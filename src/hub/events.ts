import type { EventItem, EventLevel, NotifyEvents } from "../shared/api.ts";
import { db } from "./db.ts";
import { enqueueNotice } from "./notify.ts";
import { getSettings } from "./settings.ts";

export interface NewEvent {
  level: EventLevel;
  type: string;
  serverId?: string | null;
  serviceId?: number | null;
  checkId?: number | null;
  title: string;
  message?: string | null;
  actor?: string | null;
  /** категория уведомления; null/undefined — не уведомлять */
  notify?: keyof NotifyEvents | null;
}

const insert = db.query(
  `INSERT INTO events(ts, level, type, server_id, service_id, check_id, title, message, actor)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
);

export function linkFor(e: { serverId?: string | null; serviceId?: number | null; checkId?: number | null }): string {
  const base = getSettings().publicUrl;
  if (e.serviceId) return `${base}/svc/${e.serviceId}`;
  if (e.checkId) return `${base}/chk/${e.checkId}`;
  if (e.serverId) return `${base}/s/${encodeURIComponent(e.serverId)}`;
  return base;
}

export function addEvent(e: NewEvent): number {
  const row = insert.get(
    Date.now(),
    e.level,
    e.type,
    e.serverId ?? null,
    e.serviceId ?? null,
    e.checkId ?? null,
    e.title,
    e.message ?? null,
    e.actor ?? null,
  ) as { id: number };
  if (e.notify) {
    const s = getSettings();
    const isRecovery = e.level === "ok";
    if (s.notify.events[e.notify] && (!isRecovery || s.notify.events.recovery)) {
      enqueueNotice({ level: e.level, title: e.title, message: e.message, link: linkFor(e) });
    }
  }
  return row.id;
}

export interface EventRow {
  id: number;
  ts: number;
  level: EventLevel;
  type: string;
  server_id: string | null;
  service_id: number | null;
  check_id: number | null;
  title: string;
  message: string | null;
  actor: string | null;
}

export function toEventItem(r: EventRow): EventItem {
  return {
    id: r.id,
    ts: r.ts,
    level: r.level,
    type: r.type,
    serverId: r.server_id,
    serviceId: r.service_id,
    checkId: r.check_id,
    title: r.title,
    message: r.message,
    actor: r.actor,
  };
}

export function listEvents(q: {
  limit?: number;
  before?: number;
  serverId?: string;
  serviceId?: number;
  checkId?: number;
  level?: EventLevel;
  since?: number;
}): EventItem[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.before) (where.push("id < ?"), args.push(q.before));
  if (q.since) (where.push("ts >= ?"), args.push(q.since));
  if (q.serverId) (where.push("server_id = ?"), args.push(q.serverId));
  if (q.serviceId) (where.push("service_id = ?"), args.push(q.serviceId));
  if (q.checkId) (where.push("check_id = ?"), args.push(q.checkId));
  if (q.level) (where.push("level = ?"), args.push(q.level));
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`;
  return (db.query(sql).all(...args) as EventRow[]).map(toEventItem);
}
