import type { CheckBody, CheckSummary, Status } from "../shared/api.ts";
import { runCheck, tlsCertExpiry, validateCheckTarget, parseExpect } from "../shared/checks.ts";
import type { CheckDef, CheckResult } from "../shared/protocol.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";
import { errMsg, log } from "./log.ts";
import type { CheckRow } from "./model.ts";
import { recomputeService } from "./services.ts";
import { getSettings } from "./settings.ts";

export class CheckError extends Error {}

const DAY = 86_400_000;

export function getCheckRow(id: number): CheckRow | null {
  return db.query("SELECT * FROM checks WHERE id = ?").get(id) as CheckRow | null;
}

export function allCheckRows(): CheckRow[] {
  return db.query("SELECT * FROM checks ORDER BY id").all() as CheckRow[];
}

// ---------- статистика (кэш 60 с) ----------

interface Stats {
  at: number;
  uptime24h: number | null;
  uptime30d: number | null;
  avgMs24h: number | null;
}
const statsCache = new Map<number, Stats>();
const qStats = db.query(
  "SELECT avg(ok) AS up, avg(CASE WHEN ok THEN ms END) AS ms FROM check_results WHERE check_id = ? AND ts >= ?",
);
const qBeats = db.query("SELECT ok FROM check_results WHERE check_id = ? ORDER BY ts DESC LIMIT 60");

function stats(id: number): Stats {
  const now = Date.now();
  const c = statsCache.get(id);
  if (c && now - c.at < 60_000) return c;
  const d = qStats.get(id, now - DAY) as { up: number | null; ms: number | null };
  const m = qStats.get(id, now - 30 * DAY) as { up: number | null; ms: number | null };
  const s: Stats = {
    at: now,
    uptime24h: d.up === null ? null : Math.round(d.up * 10000) / 100,
    uptime30d: m.up === null ? null : Math.round(m.up * 10000) / 100,
    avgMs24h: d.ms === null ? null : Math.round(d.ms),
  };
  statsCache.set(id, s);
  return s;
}

export function toCheckSummary(r: CheckRow, effective?: { status: Status; reason: string | null }): CheckSummary {
  const st = stats(r.id);
  const beats = (qBeats.all(r.id) as { ok: number }[]).map((b) => (b.ok ? 1 : 0) as 0 | 1).reverse();
  const last = parseJson<CheckResult>(r.last_json);
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    target: r.target,
    runner: r.runner,
    serverId: r.server_id,
    serviceId: r.service_id,
    interval: r.interval,
    timeout: r.timeout,
    expect: r.expect,
    keyword: r.keyword,
    method: r.method,
    insecure: !!r.insecure,
    retries: r.retries,
    enabled: !!r.enabled,
    status: effective?.status ?? r.status,
    statusReason: effective ? effective.reason : r.status_reason,
    statusSince: r.status_since,
    last: last
      ? { t: last.t, ok: last.ok, code: last.code ?? null, ms: last.ms ?? null, err: last.err ?? null }
      : null,
    uptime24h: st.uptime24h,
    uptime30d: st.uptime30d,
    avgMs24h: st.avgMs24h,
    certExpires: r.cert_expires,
    beats,
  };
}

/** Эффективный статус: выключена → stopped; агент-раннер не на связи → unknown. */
export function effectiveCheckStatus(r: CheckRow, runnerOnline: (serverId: string) => boolean) {
  if (!r.enabled) return { status: "stopped" as Status, reason: "выключена" };
  if (r.runner !== "hub" && !runnerOnline(r.runner)) return { status: "unknown" as Status, reason: "агент-исполнитель не на связи" };
  return { status: r.status, reason: r.status_reason };
}

export function checksOfService(serviceId: number): CheckSummary[] {
  return (db.query("SELECT * FROM checks WHERE service_id = ?").all(serviceId) as CheckRow[]).map((r) => toCheckSummary(r));
}

export function toDef(r: CheckRow): CheckDef {
  return {
    id: r.id,
    type: r.type,
    target: r.target,
    interval: r.interval,
    timeout: r.timeout,
    expect: r.expect,
    keyword: r.keyword,
    method: r.method,
    insecure: !!r.insecure,
  };
}

export function agentChecks(serverId: string): CheckDef[] {
  return (db.query("SELECT * FROM checks WHERE runner = ? AND enabled = 1").all(serverId) as CheckRow[]).map(toDef);
}

// ---------- обработка результатов ----------

const insResult = db.query(
  "INSERT OR REPLACE INTO check_results(check_id, ts, ok, code, ms, err) VALUES(?, ?, ?, ?, ?, ?)",
);

export function processCheckResult(r: CheckResult, runner: string): void {
  const row = getCheckRow(r.id);
  if (!row || row.runner !== runner || !row.enabled) return; // агент не может писать в чужие проверки
  const now = Date.now();
  const t = Math.min(Number(r.t) || now, now);
  const ok = !!r.ok;
  const code = Number.isFinite(r.code) ? Math.round(r.code!) : null;
  const ms = Number.isFinite(r.ms) ? Math.round(r.ms!) : null;
  const err = r.err ? String(r.err).slice(0, 300) : null;
  insResult.run(row.id, t, ok ? 1 : 0, code, ms, err);
  statsCache.delete(row.id);

  let certExpires = row.cert_expires;
  if (Number.isFinite(r.certExpires)) certExpires = r.certExpires!;

  const fails = ok ? 0 : row.fails + 1;
  let status: Status;
  let reason: string | null;
  const s = getSettings();
  if (ok) {
    const daysLeft = certExpires ? (certExpires - now) / DAY : null;
    if (daysLeft !== null && daysLeft < s.certWarnDays) {
      status = daysLeft <= 0 ? "down" : "warn";
      reason = daysLeft <= 0 ? "TLS-сертификат истёк" : `сертификат истекает через ${Math.ceil(daysLeft)} дн.`;
    } else {
      status = "ok";
      reason = null;
    }
  } else {
    const what = err ?? (code ? `HTTP ${code}` : "ошибка");
    if (fails >= row.retries) {
      status = "down";
      reason = what;
    } else {
      status = row.status === "down" ? "down" : "warn";
      reason = `сбой ${fails}/${row.retries}: ${what}`;
    }
  }

  const changed = status !== row.status;
  db.query(
    `UPDATE checks SET fails = ?, last_json = ?, cert_expires = ?, status = ?, status_reason = ?,
       status_since = CASE WHEN status = ? THEN status_since ELSE ? END WHERE id = ?`,
  ).run(
    fails,
    JSON.stringify({ t, ok, code, ms, err }),
    certExpires,
    status,
    reason,
    status,
    now,
    row.id,
  );

  if (changed) {
    const where = row.server_id ? `${row.server_id} › ` : "";
    if (status === "down") {
      addEvent({
        level: "error",
        type: "check.down",
        serverId: row.server_id,
        serviceId: row.service_id,
        checkId: row.id,
        title: `${where}${row.name} — недоступен`,
        message: `${row.target}\n${reason}`,
        notify: "checkDown",
      });
    } else if (row.status === "down") {
      addEvent({
        level: "ok",
        type: "check.up",
        serverId: row.server_id,
        serviceId: row.service_id,
        checkId: row.id,
        title: `${where}${row.name} — снова доступен`,
        message: `${row.target}${ms !== null ? ` · ${ms} мс` : ""}`,
        notify: "checkDown",
      });
    }
  }
  // предупреждение о сертификате — раз в сутки
  if (certExpires && ok && (certExpires - now) / DAY < s.certWarnDays && (!row.cert_notified || now - row.cert_notified > DAY)) {
    db.query("UPDATE checks SET cert_notified = ? WHERE id = ?").run(now, row.id);
    addEvent({
      level: "warn",
      type: "cert.expiring",
      serverId: row.server_id,
      serviceId: row.service_id,
      checkId: row.id,
      title: `${row.name} — TLS-сертификат истекает`,
      message: `${row.target}: до ${new Date(certExpires).toISOString().slice(0, 10)}`,
      notify: "certExpiry",
    });
  }
  if (row.service_id && changed) recomputeService(row.service_id);
}

// ---------- проверки с раннером hub ----------

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const certCheckedAt = new Map<number, number>();
let checksChangedHook: (runner: string) => void = () => {};

export function onChecksChanged(fn: (runner: string) => void): void {
  checksChangedHook = fn;
}

async function tick(id: number): Promise<void> {
  const row = getCheckRow(id);
  if (!row || !row.enabled || row.runner !== "hub") {
    timers.delete(id);
    return;
  }
  try {
    const def = toDef(row);
    const res = await runCheck(def);
    if (def.type === "http" && def.target.startsWith("https:")) {
      const last = certCheckedAt.get(id) ?? 0;
      if (Date.now() - last > 6 * 3600_000) {
        certCheckedAt.set(id, Date.now());
        const exp = await tlsCertExpiry(def.target);
        if (exp) res.certExpires = exp;
      }
    }
    processCheckResult(res, "hub");
  } catch (e) {
    log.warn("проверка упала", { id, error: errMsg(e) });
  }
  const fresh = getCheckRow(id);
  if (fresh && fresh.enabled && fresh.runner === "hub") {
    timers.set(id, setTimeout(() => void tick(id), fresh.interval * 1000));
  } else timers.delete(id);
}

export function scheduleHubChecks(): void {
  const rows = allCheckRows().filter((r) => r.enabled && r.runner === "hub");
  const want = new Set(rows.map((r) => r.id));
  for (const [id, t] of timers) {
    if (!want.has(id)) {
      clearTimeout(t);
      timers.delete(id);
    }
  }
  for (const r of rows) {
    if (timers.has(r.id)) continue;
    // разносим старт, чтобы проверки не били залпом
    timers.set(r.id, setTimeout(() => void tick(r.id), Math.random() * Math.min(r.interval, 15) * 1000));
  }
}

function restartHubCheck(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  certCheckedAt.delete(id);
  scheduleHubChecks();
}

// ---------- CRUD ----------

function normalize(body: Partial<CheckBody>, base: Partial<CheckRow> = {}) {
  const type = body.type ?? base.type ?? "http";
  if (type !== "http" && type !== "tcp") throw new CheckError("type: http или tcp");
  const target = String(body.target ?? base.target ?? "").trim();
  const tErr = validateCheckTarget(type, target);
  if (tErr) throw new CheckError(`target: ${tErr}`);
  const name = String(body.name ?? base.name ?? "").trim().slice(0, 100) || target.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 100);
  const runner = String(body.runner ?? base.runner ?? "hub");
  if (runner !== "hub" && !db.query("SELECT 1 FROM servers WHERE id = ?").get(runner)) throw new CheckError("runner: нет такого сервера");
  let serverId = body.serverId !== undefined ? body.serverId : (base.server_id ?? null);
  let serviceId = body.serviceId !== undefined ? body.serviceId : (base.service_id ?? null);
  if (serviceId !== null) {
    const svc = db.query("SELECT server_id FROM services WHERE id = ?").get(serviceId) as { server_id: string } | null;
    if (!svc) throw new CheckError("serviceId: нет такого сервиса");
    serverId = svc.server_id;
  }
  if (serverId !== null && !db.query("SELECT 1 FROM servers WHERE id = ?").get(serverId)) throw new CheckError("serverId: нет такого сервера");
  const interval = Math.round(body.interval ?? base.interval ?? 60);
  if (interval < 10 || interval > 86_400) throw new CheckError("interval: 10..86400 с");
  const timeout = Math.round(body.timeout ?? base.timeout ?? 10_000);
  if (timeout < 500 || timeout > 60_000) throw new CheckError("timeout: 500..60000 мс");
  const expect = body.expect !== undefined ? body.expect?.trim() || null : (base.expect ?? null);
  try {
    parseExpect(expect);
  } catch (e) {
    throw new CheckError(`expect: ${errMsg(e)}`);
  }
  const keyword = body.keyword !== undefined ? body.keyword?.slice(0, 200) || null : (base.keyword ?? null);
  const method = body.method ?? base.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new CheckError("method: GET или HEAD");
  const retries = Math.round(body.retries ?? base.retries ?? 2);
  if (retries < 1 || retries > 20) throw new CheckError("retries: 1..20");
  return {
    name,
    type,
    target,
    runner,
    server_id: serverId,
    service_id: serviceId,
    interval,
    timeout,
    expect,
    keyword,
    method,
    insecure: (body.insecure ?? !!base.insecure) ? 1 : 0,
    retries,
    enabled: (body.enabled ?? (base.enabled === undefined ? true : !!base.enabled)) ? 1 : 0,
  };
}

export function createCheck(body: CheckBody, actor: string): CheckRow {
  const n = normalize(body);
  const now = Date.now();
  const row = db
    .query(
      `INSERT INTO checks(name, type, target, runner, server_id, service_id, interval, timeout, expect, keyword, method,
         insecure, retries, enabled, status, status_since, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *`,
    )
    .get(n.name, n.type, n.target, n.runner, n.server_id, n.service_id, n.interval, n.timeout, n.expect, n.keyword,
      n.method, n.insecure, n.retries, n.enabled, now, now) as CheckRow;
  addEvent({ level: "info", type: "config.check", checkId: row.id, serverId: row.server_id, title: `Добавлена проверка «${row.name}»`, message: row.target, actor });
  afterChange(row, null);
  return row;
}

export function updateCheck(id: number, body: Partial<CheckBody>, actor: string): CheckRow {
  const cur = getCheckRow(id);
  if (!cur) throw new CheckError("нет такой проверки");
  const n = normalize(body, cur);
  const resetState = n.target !== cur.target || n.type !== cur.type || n.runner !== cur.runner;
  db.query(
    `UPDATE checks SET name=?, type=?, target=?, runner=?, server_id=?, service_id=?, interval=?, timeout=?, expect=?,
       keyword=?, method=?, insecure=?, retries=?, enabled=? ${resetState ? ", status='pending', status_reason=NULL, fails=0, cert_expires=NULL, status_since=" + Date.now() : ""}
     WHERE id=?`,
  ).run(n.name, n.type, n.target, n.runner, n.server_id, n.service_id, n.interval, n.timeout, n.expect, n.keyword,
    n.method, n.insecure, n.retries, n.enabled, id);
  const row = getCheckRow(id)!;
  addEvent({ level: "info", type: "config.check", checkId: id, serverId: row.server_id, title: `Изменена проверка «${row.name}»`, actor });
  afterChange(row, cur);
  return row;
}

export function deleteCheck(id: number, actor: string): void {
  const cur = getCheckRow(id);
  if (!cur) throw new CheckError("нет такой проверки");
  db.transaction(() => {
    db.query("DELETE FROM check_results WHERE check_id = ?").run(id);
    db.query("DELETE FROM checks WHERE id = ?").run(id);
  })();
  addEvent({ level: "info", type: "config.check", serverId: cur.server_id, title: `Удалена проверка «${cur.name}»`, message: cur.target, actor });
  afterChange(null, cur);
}

function afterChange(row: CheckRow | null, prev: CheckRow | null): void {
  statsCache.delete((row ?? prev)!.id);
  restartHubCheck((row ?? prev)!.id);
  const runners = new Set([row?.runner, prev?.runner].filter((r): r is string => !!r && r !== "hub"));
  for (const r of runners) checksChangedHook(r);
  for (const sid of new Set([row?.service_id, prev?.service_id])) if (sid) recomputeService(sid);
}
