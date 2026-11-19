import type { ServicePatchBody, Status } from "../shared/api.ts";
import type { ServiceSample } from "../shared/protocol.ts";
import { checksOfService } from "./checks.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";
import { serviceStatus, type ServiceRow } from "./model.ts";

export class ServiceError extends Error {}

export function getServiceRow(id: number): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
}

export const serviceLabel = (r: Pick<ServiceRow, "server_id" | "display_name" | "name">) =>
  `${r.server_id} › ${r.display_name ?? r.name}`;

const updStatus = db.query(
  `UPDATE services SET status = ?, status_reason = ?, status_since = ?, down_since = ?, notified_down = ? WHERE id = ?`,
);

/**
 * Записать новый статус сервиса и обработать переходы. Уведомление о падении — не здесь, а в мониторе
 * после антидребезга (serviceDownDelay); здесь — только восстановление после уже объявленного падения.
 */
export function applyServiceStatus(row: ServiceRow, next: { status: Status; reason: string | null }, now = Date.now()): void {
  const prev = row.status;
  let downSince = row.down_since;
  let notified = row.notified_down;
  if (next.status === "down" && prev !== "down") {
    downSince = now;
    notified = 0;
  }
  if (next.status !== "down" && prev === "down") {
    // unknown (сервер пропал / сервис пропал) — не восстановление
    if (notified && next.status !== "unknown") {
      addEvent({
        level: "ok",
        type: "service.up",
        serverId: row.server_id,
        serviceId: row.id,
        title: `${serviceLabel(row)} — снова работает`,
        message: next.reason,
        notify: row.tracked && !row.muted ? "serviceDown" : null,
      });
    }
    if (next.status !== "unknown") {
      downSince = null;
      notified = 0;
    }
  }
  if (next.status === prev && next.reason === row.status_reason && downSince === row.down_since && notified === row.notified_down) return;
  updStatus.run(next.status, next.reason, next.status === prev ? row.status_since : now, downSince, notified, row.id);
  row.status = next.status;
  row.status_reason = next.reason;
  if (next.status !== prev) row.status_since = now;
  row.down_since = downSince;
  row.notified_down = notified;
}

export function recomputeService(id: number): void {
  const row = getServiceRow(id);
  if (!row) return;
  applyServiceStatus(row, serviceStatus(row, parseJson<ServiceSample>(row.sample_json), checksOfService(id)));
}

export function patchService(id: number, body: ServicePatchBody, actor: string): ServiceRow {
  const row = getServiceRow(id);
  if (!row) throw new ServiceError("нет такого сервиса");
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const changes: string[] = [];
  if (body.displayName !== undefined) {
    const v = body.displayName === null ? null : String(body.displayName).trim().slice(0, 80) || null;
    sets.push("display_name = ?");
    args.push(v);
    changes.push(`имя: ${v ?? "по умолчанию"}`);
  }
  if (body.group !== undefined) {
    let v: string | null = body.group === null ? null : String(body.group).trim().slice(0, 60);
    if (v !== null && v !== "" && !/^[\p{L}\p{N} ._\-/]+$/u.test(v)) throw new ServiceError("group: недопустимые символы");
    sets.push("group_name = ?");
    args.push(v);
    changes.push(`группа: ${v === null ? "авто" : v === "" ? "без группы" : v}`);
  }
  if (body.tracked !== undefined) {
    sets.push("tracked = ?");
    args.push(body.tracked ? 1 : 0);
    changes.push(body.tracked ? "отслеживается" : "скрыт");
  }
  if (body.muted !== undefined) {
    sets.push("muted = ?");
    args.push(body.muted ? 1 : 0);
    changes.push(body.muted ? "без уведомлений" : "с уведомлениями");
  }
  if (body.sort !== undefined) {
    if (!Number.isFinite(body.sort)) throw new ServiceError("sort: число");
    sets.push("sort = ?");
    args.push(Math.round(body.sort));
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?");
    args.push(body.notes === null ? null : String(body.notes).slice(0, 4000) || null);
    changes.push("заметки");
  }
  if (!sets.length) return row;
  db.query(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  if (changes.length) {
    addEvent({
      level: "info",
      type: "config.service",
      serverId: row.server_id,
      serviceId: id,
      title: `Настройки ${serviceLabel(row)}`,
      message: changes.join("; "),
      actor,
    });
  }
  return getServiceRow(id)!;
}

export function deleteService(id: number, actor: string): void {
  const row = getServiceRow(id);
  if (!row) throw new ServiceError("нет такого сервиса");
  db.transaction(() => {
    db.query("UPDATE checks SET service_id = NULL WHERE service_id = ?").run(id);
    db.query("DELETE FROM m_service WHERE service_id = ?").run(id);
    db.query("DELETE FROM logs WHERE service_id = ?").run(id);
    db.query("DELETE FROM log_counts WHERE service_id = ?").run(id);
    db.query("DELETE FROM services WHERE id = ?").run(id);
  })();
  addEvent({ level: "info", type: "config.service", serverId: row.server_id, title: `Забыт сервис ${serviceLabel(row)}`, actor });
}
