import type { ServerCreateBody, ServerEnrollment, ServerPatchBody, Thresholds } from "../shared/api.ts";
import { randomToken, sha256 } from "../shared/secure.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";
import { hubFingerprint, hubPublicKey } from "./identity.ts";
import { live, type ServerRow } from "./model.ts";
import { getSettings } from "./settings.ts";

export class ServerError extends Error {}

const ENROLL_TTL = 24 * 3600_000;

export function getServerRow(id: string): ServerRow | null {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
}

export function hubWsUrl(): string {
  const u = new URL(getSettings().publicUrl);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/agent`;
}

export function installCommand(serverId: string, token?: string): string {
  const base = getSettings().publicUrl;
  return `curl -fsSL ${base}/install/agent.sh | sh -s -- --server ${serverId}${token ? ` --token ${token}` : ""}`;
}

function issueEnrollment(id: string): ServerEnrollment {
  const token = `ne_${randomToken(24)}`;
  const expiresAt = Date.now() + ENROLL_TTL;
  db.query("UPDATE servers SET enroll_hash = ?, enroll_expires = ? WHERE id = ?").run(sha256(token), expiresAt, id);
  return {
    serverId: id,
    token,
    expiresAt,
    hubUrl: hubWsUrl(),
    hubKey: hubPublicKey,
    hubKeyFingerprint: hubFingerprint,
    installCommand: installCommand(id, token),
  };
}

export function createServer(body: ServerCreateBody, actor: string): ServerEnrollment {
  const id = String(body.id ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new ServerError("id: латиница, цифры и дефис, до 32 символов");
  if (getServerRow(id)) throw new ServerError("сервер с таким id уже есть");
  const name = String(body.name ?? "").trim().slice(0, 60) || id;
  const maxSort = (db.query("SELECT coalesce(max(sort), 0) AS m FROM servers").get() as { m: number }).m;
  db.query("INSERT INTO servers(id, name, description, sort, created_at, status, status_since) VALUES(?, ?, ?, ?, ?, 'pending', ?)").run(
    id,
    name,
    body.description?.slice(0, 300) || null,
    maxSort + 10,
    Date.now(),
    Date.now(),
  );
  addEvent({ level: "info", type: "config.server", serverId: id, title: `Добавлен сервер ${name}`, actor });
  return issueEnrollment(id);
}

/** Новый токен регистрации; ключ текущего агента отзывается, активное подключение рвётся. */
export function reEnroll(id: string, actor: string): ServerEnrollment {
  const r = getServerRow(id);
  if (!r) throw new ServerError("нет такого сервера");
  db.query("UPDATE servers SET agent_key = NULL WHERE id = ?").run(id);
  disconnect(id, "ключ агента отозван");
  addEvent({ level: "warn", type: "config.server", serverId: id, title: `${r.name}: выпущен новый токен регистрации`, message: "прежний ключ агента отозван", actor });
  return issueEnrollment(id);
}

export function patchServer(id: string, body: ServerPatchBody, actor: string): void {
  const r = getServerRow(id);
  if (!r) throw new ServerError("нет такого сервера");
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (body.name !== undefined) {
    const v = String(body.name).trim().slice(0, 60);
    if (!v) throw new ServerError("name: пустое имя");
    sets.push("name = ?");
    args.push(v);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    args.push(body.description ? String(body.description).slice(0, 300) : null);
  }
  if (body.sort !== undefined) {
    if (!Number.isFinite(body.sort)) throw new ServerError("sort: число");
    sets.push("sort = ?");
    args.push(Math.round(body.sort));
  }
  if (body.overrides !== undefined) {
    sets.push("overrides_json = ?");
    args.push(body.overrides === null ? null : JSON.stringify(cleanOverrides(body.overrides, parseJson(r.overrides_json))));
  }
  if (!sets.length) return;
  db.query(`UPDATE servers SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  addEvent({ level: "info", type: "config.server", serverId: id, title: `Изменены настройки сервера ${body.name ?? r.name}`, actor });
}

function cleanOverrides(o: Partial<Thresholds>, cur: Partial<Thresholds> | null): Partial<Thresholds> {
  const out: Partial<Thresholds> = { ...(cur ?? {}) };
  const n = (v: unknown, a: number, b: number) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < a || x > b) throw new ServerError(`порог вне диапазона ${a}..${b}`);
    return x;
  };
  if (o.cpu) out.cpu = { pct: n(o.cpu.pct, 1, 100), minutes: n(o.cpu.minutes, 1, 120) };
  if (o.mem) out.mem = { pct: n(o.mem.pct, 1, 100), minutes: n(o.mem.minutes, 1, 120) };
  if (o.disk) out.disk = { pct: n(o.disk.pct, 1, 100) };
  if (o.offlineSeconds !== undefined) out.offlineSeconds = n(o.offlineSeconds, 20, 3600);
  return out;
}

export function deleteServer(id: string, actor: string): void {
  const r = getServerRow(id);
  if (!r) throw new ServerError("нет такого сервера");
  disconnect(id, "сервер удалён");
  db.transaction(() => {
    const ids = (db.query("SELECT id FROM services WHERE server_id = ?").all(id) as { id: number }[]).map((x) => x.id);
    for (const sid of ids) {
      db.query("DELETE FROM m_service WHERE service_id = ?").run(sid);
      db.query("DELETE FROM logs WHERE service_id = ?").run(sid);
      db.query("DELETE FROM log_counts WHERE service_id = ?").run(sid);
    }
    db.query("DELETE FROM m_server WHERE server_id = ?").run(id);
    db.query("UPDATE checks SET runner = 'hub' WHERE runner = ?").run(id);
    db.query("DELETE FROM servers WHERE id = ?").run(id);
  })();
  addEvent({ level: "warn", type: "config.server", title: `Удалён сервер ${r.name}`, message: id, actor });
}

let disconnectHook: (id: string, reason: string) => void = () => {};
export function onDisconnectRequest(fn: (id: string, reason: string) => void): void {
  disconnectHook = fn;
}
function disconnect(id: string, reason: string): void {
  if (live.has(id)) disconnectHook(id, reason);
}
