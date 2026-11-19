import type {
  CheckResults,
  CheckSummary,
  LogItem,
  MetricsRange,
  Overview,
  ServerDetail,
  ServerMetrics,
  ServerNow,
  ServerSummary,
  ServiceDetail,
  ServiceMetrics,
  ServiceSummary,
  Status,
  Thresholds,
} from "../shared/api.ts";
import { AGENT_VERSION, type FsUsage, type HostInfo, type ServiceSample } from "../shared/protocol.ts";
import { fingerprint } from "../shared/secure.ts";
import { allCheckRows, effectiveCheckStatus, getCheckRow, toCheckSummary } from "./checks.ts";
import { HUB_VERSION } from "./config.ts";
import { db, parseJson } from "./db.ts";
import { listEvents } from "./events.ts";
import { computeGroups, live, roleOf, semverLess, type CheckRow, type ServerAlerts, type ServerRow, type ServiceRow } from "./model.ts";
import { effectiveThresholds, getSettings } from "./settings.ts";

const STATUSES: Status[] = ["ok", "warn", "down", "stopped", "unknown", "pending"];
const zeroCounts = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;

const serverOnline = (id: string) => {
  const r = db.query("SELECT status FROM servers WHERE id = ?").get(id) as { status: Status } | null;
  return !!r && (r.status === "ok" || r.status === "warn");
};

function errors1hMap(): Map<number, number> {
  const since = Math.floor(Date.now() / 60_000) - 60;
  const rows = db.query("SELECT service_id, sum(n) AS n FROM log_counts WHERE minute >= ? GROUP BY service_id").all(since) as {
    service_id: number;
    n: number;
  }[];
  return new Map(rows.map((r) => [r.service_id, r.n]));
}

function serverSummary(r: ServerRow, counts: Record<Status, number>): ServerSummary {
  const host = parseJson<HostInfo>(r.host_json);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    statusReason: r.status === "pending" ? (r.agent_key ? "ожидание данных" : "агент не установлен") : r.status_reason,
    statusSince: r.status_since,
    connected: live.has(r.id),
    lastSeen: r.last_seen,
    sort: r.sort,
    host,
    now: parseJson<ServerNow>(r.now_json),
    counts,
    enrolled: !!r.agent_key,
    agentOutdated: !!host?.agentVersion && semverLess(host.agentVersion, AGENT_VERSION),
  };
}

function serviceSummary(
  r: ServiceRow,
  group: string | null,
  server: ServerRow | undefined,
  errors: Map<number, number>,
  checks: CheckSummary[],
): ServiceSummary {
  const s = parseJson<ServiceSample>(r.sample_json);
  let status = r.status;
  let reason = r.status_reason;
  if (server && (server.status === "down" || server.status === "pending" || server.status === "unknown")) {
    status = "unknown";
    reason = server.status === "down" ? "сервер не на связи" : "нет данных";
  }
  const mine = checks.filter((c) => c.serviceId === r.id && c.enabled);
  return {
    id: r.id,
    serverId: r.server_id,
    key: r.key,
    kind: r.kind as ServiceSummary["kind"],
    name: r.name,
    displayName: r.display_name,
    group,
    role: roleOf(s),
    status,
    statusReason: reason,
    statusSince: r.status_since,
    state: s?.state ?? null,
    tracked: !!r.tracked,
    muted: !!r.muted,
    missing: !!r.missing,
    sort: r.sort,
    since: s?.state === "running" || s?.state === "exited" ? (s.since ?? null) : null,
    lastRun: s?.lastRun ?? null,
    version: s?.version ?? null,
    commit: s?.commit ?? null,
    cpu: s?.cpu ?? null,
    mem: s?.mem ?? null,
    restarts: s?.restarts ?? null,
    ports: s?.ports ?? [],
    errors1h: errors.get(r.id) ?? 0,
    checks: { total: mine.length, ok: mine.filter((c) => c.status === "ok").length },
  };
}

function allCheckSummaries(): CheckSummary[] {
  return allCheckRows().map((r) => toCheckSummary(r, effectiveCheckStatus(r, serverOnline)));
}

let overviewCache: { at: number; all: boolean; data: Overview } | null = null;

export function invalidateOverview(): void {
  overviewCache = null;
}

export function overview(all = false): Overview {
  const now = Date.now();
  if (overviewCache && overviewCache.all === all && now - overviewCache.at < 1500) return overviewCache.data;
  const servers = db.query("SELECT * FROM servers ORDER BY sort, name").all() as ServerRow[];
  const services = db.query("SELECT * FROM services ORDER BY sort, name").all() as ServiceRow[];
  const checks = allCheckSummaries();
  const errors = errors1hMap();
  const byServer = new Map<string, ServiceRow[]>();
  for (const s of services) (byServer.get(s.server_id) ?? byServer.set(s.server_id, []).get(s.server_id)!).push(s);
  const srvMap = new Map(servers.map((s) => [s.id, s]));

  const outServices: ServiceSummary[] = [];
  const counts = new Map<string, Record<Status, number>>();
  for (const srv of servers) {
    const rows = byServer.get(srv.id) ?? [];
    const groups = computeGroups(rows);
    const c = zeroCounts();
    for (const r of rows) {
      const sum = serviceSummary(r, groups.get(r.id) ?? null, srv, errors, checks);
      if (r.tracked) c[sum.status]++;
      if (r.tracked || all) outServices.push(sum);
    }
    for (const ch of checks) if (ch.serverId === srv.id && ch.serviceId === null) c[ch.status]++;
    counts.set(srv.id, c);
  }
  const data: Overview = {
    servers: servers.map((s) => serverSummary(s, counts.get(s.id) ?? zeroCounts())),
    services: outServices,
    checks,
    generatedAt: now,
    hubVersion: HUB_VERSION,
  };
  void srvMap;
  overviewCache = { at: now, all, data };
  return data;
}

// ---------- сервер ----------

function traffic(serverId: string) {
  const nowSec = Math.floor(Date.now() / 1000);
  const q = db.query(
    "SELECT sum(net_rx * n) AS rx, sum(net_tx * n) AS tx FROM m_server WHERE server_id = ? AND tier = 1 AND ts >= ?",
  );
  // tier1: средняя скорость за минуту × 60 с; n — число сырых точек, поэтому делим на n и умножаем на 60
  const q1 = db.query(
    "SELECT sum(net_rx) * 60 AS rx, sum(net_tx) * 60 AS tx FROM m_server WHERE server_id = ? AND tier = 1 AND ts >= ?",
  );
  void q;
  const d = q1.get(serverId, nowSec - 86400) as { rx: number | null; tx: number | null };
  const m = q1.get(serverId, nowSec - 30 * 86400) as { rx: number | null; tx: number | null };
  return { rx24h: Math.round(d.rx ?? 0), tx24h: Math.round(d.tx ?? 0), rx30d: Math.round(m.rx ?? 0), tx30d: Math.round(m.tx ?? 0) };
}

export function serverDetail(id: string): ServerDetail | null {
  const r = db.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
  if (!r) return null;
  const sum = overview().servers.find((s) => s.id === id) ?? serverSummary(r, zeroCounts());
  const overrides = parseJson<Partial<Thresholds>>(r.overrides_json);
  const alerts = parseJson<ServerAlerts>(r.alerts_json) ?? {};
  const l = live.get(id);
  return {
    ...sum,
    filesystems: (parseJson<FsUsage[]>(r.fs_json) ?? []).map((f) => ({ mount: f.mount, dev: f.dev, fstype: f.fstype, used: f.used, total: f.total })),
    thresholds: effectiveThresholds(overrides),
    overrides,
    agentKeyFingerprint: r.agent_key ? fingerprint(r.agent_key) : null,
    traffic: traffic(id),
    alerts: { cpu: !!alerts.cpu, mem: !!alerts.mem, disk: !!alerts.disk },
    enrollPending: !!r.enroll_hash && (r.enroll_expires ?? 0) > Date.now(),
    remoteAddr: l?.ip ?? null,
    connectedAt: l?.connectedAt ?? null,
    rtt: l?.rtt ?? null,
  };
}

// ---------- метрики ----------

const RANGE_SEC: Record<MetricsRange, number> = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "1y": 31536000 };
const NICE = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

export function isRange(r: unknown): r is MetricsRange {
  return typeof r === "string" && r in RANGE_SEC;
}

export function planRange(range: MetricsRange) {
  const s = getSettings();
  const sec = RANGE_SEC[range];
  const to = Math.floor(Date.now() / 1000);
  const tier = sec <= s.retention.rawHours * 3600 ? 0 : sec <= s.retention.minuteDays * 86400 ? 1 : 2;
  const base = tier === 0 ? s.agentInterval : tier === 1 ? 60 : 900;
  const want = sec / 400;
  let step = NICE.find((n) => n >= want && n >= base && n % base === 0) ?? 86400;
  if (step < base) step = base;
  const from = Math.floor((to - sec) / step) * step;
  return { tier, step, from, to };
}

function buckets(from: number, to: number, step: number): number[] {
  const t: number[] = [];
  for (let x = from; x <= to; x += step) t.push(x);
  return t;
}

function fill(t: number[], rows: Record<string, number | null>[], keys: readonly string[]): Record<string, (number | null)[]> {
  const by = new Map(rows.map((r) => [r.b as number, r]));
  const out: Record<string, (number | null)[]> = {};
  for (const k of keys) out[k] = [];
  for (const x of t) {
    const r = by.get(x);
    for (const k of keys) {
      const v = r ? r[k] : null;
      out[k]!.push(v === null || v === undefined ? null : Math.round(v * 100) / 100);
    }
  }
  return out;
}

export function serverMetrics(id: string, range: MetricsRange): ServerMetrics {
  const p = planRange(range);
  const rows = db
    .query(
      `SELECT (ts / ?1) * ?1 AS b,
         sum(cpu * n) / sum(n) AS cpu, max(coalesce(cpu_max, cpu)) AS cpuMax, sum(mem * n) / sum(n) AS mem,
         sum(mem_used * n) / sum(n) AS memUsed, sum(swap_used * n) / sum(n) AS swapUsed, sum(disk * n) / sum(n) AS disk,
         sum(disk_read * n) / sum(n) AS diskRead, sum(disk_write * n) / sum(n) AS diskWrite,
         sum(net_rx * n) / sum(n) AS netRx, sum(net_tx * n) / sum(n) AS netTx, sum(load1 * n) / sum(n) AS load1,
         sum(ping * n) / sum(n) AS ping
       FROM m_server WHERE server_id = ?2 AND tier = ?3 AND ts >= ?4 AND ts <= ?5 GROUP BY b ORDER BY b`,
    )
    .all(p.step, id, p.tier, p.from, p.to) as any[];
  const t = buckets(p.from, p.to, p.step);
  const keys = ["cpu", "cpuMax", "mem", "memUsed", "swapUsed", "disk", "diskRead", "diskWrite", "netRx", "netTx", "load1", "ping"] as const;
  const f = fill(t, rows, keys);
  return {
    range, from: p.from * 1000, to: p.to * 1000, step: p.step, t,
    cpu: f.cpu!, cpuMax: f.cpuMax!, mem: f.mem!, memUsed: f.memUsed!, swapUsed: f.swapUsed!, disk: f.disk!,
    diskRead: f.diskRead!, diskWrite: f.diskWrite!, netRx: f.netRx!, netTx: f.netTx!, load1: f.load1!, ping: f.ping!,
  };
}

export function serviceMetrics(id: number, range: MetricsRange): ServiceMetrics {
  const p = planRange(range);
  const rows = db
    .query(
      `SELECT (ts / ?1) * ?1 AS b, sum(cpu * n) / sum(n) AS cpu, max(coalesce(cpu_max, cpu)) AS cpuMax,
         sum(mem * n) / sum(n) AS mem, max(coalesce(mem_max, mem)) AS memMax
       FROM m_service WHERE service_id = ?2 AND tier = ?3 AND ts >= ?4 AND ts <= ?5 GROUP BY b ORDER BY b`,
    )
    .all(p.step, id, p.tier, p.from, p.to) as any[];
  const t = buckets(p.from, p.to, p.step);
  const f = fill(t, rows, ["cpu", "cpuMax", "mem", "memMax"]);
  return { range, from: p.from * 1000, to: p.to * 1000, step: p.step, t, cpu: f.cpu!, cpuMax: f.cpuMax!, mem: f.mem!, memMax: f.memMax! };
}

export function checkResults(id: number, range: MetricsRange): CheckResults {
  const sec = Math.min(RANGE_SEC[range], 30 * 86400);
  const to = Math.floor(Date.now() / 1000);
  const want = sec / 300;
  const step = NICE.find((n) => n >= want) ?? 86400;
  const from = Math.floor((to - sec) / step) * step;
  const rows = db
    .query(
      `SELECT ((ts / 1000) / ?1) * ?1 AS b, avg(CASE WHEN ok THEN ms END) AS ms, avg(ok) AS up
       FROM check_results WHERE check_id = ?2 AND ts >= ?3 GROUP BY b ORDER BY b`,
    )
    .all(step, id, from * 1000) as any[];
  const t = buckets(from, to, step);
  const f = fill(t, rows, ["ms", "up"]);
  return { range, from: from * 1000, to: to * 1000, step, t, ms: f.ms!, up: f.up! };
}

// ---------- сервис ----------

export function serviceDetail(id: number): ServiceDetail | null {
  const r = db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
  if (!r) return null;
  const server = db.query("SELECT * FROM servers WHERE id = ?").get(r.server_id) as ServerRow;
  const siblings = db.query("SELECT id, name, group_name, tracked FROM services WHERE server_id = ?").all(r.server_id) as ServiceRow[];
  const group = computeGroups(siblings).get(id) ?? null;
  const checkRows = db.query("SELECT * FROM checks WHERE service_id = ?").all(id) as CheckRow[];
  const checks = checkRows.map((c) => toCheckSummary(c, effectiveCheckStatus(c, serverOnline)));
  const sum = serviceSummary(r, group, server, errors1hMap(), checks);
  const s = parseJson<ServiceSample>(r.sample_json);
  const hourNow = Math.floor(Date.now() / 3600_000);
  const hourly = db
    .query("SELECT minute / 60 AS h, sum(n) AS n FROM log_counts WHERE service_id = ? AND minute >= ? GROUP BY h")
    .all(id, (hourNow - 23) * 60) as { h: number; n: number }[];
  const hm = new Map(hourly.map((x) => [x.h, x.n]));
  return {
    ...sum,
    description: s?.description ?? null,
    raw: s?.raw ?? null,
    enabled: s?.enabled ?? null,
    vendor: !!s?.vendor,
    result: s?.result ?? null,
    exitCode: s?.exitCode ?? null,
    pid: s?.pid ?? null,
    tasks: s?.tasks ?? null,
    commitAt: s?.commitAt ?? null,
    runtime: s?.runtime ?? null,
    cwd: s?.cwd ?? null,
    exec: s?.exec ?? null,
    image: s?.image ?? null,
    health: s?.health ?? null,
    logRate: s?.logRate ?? null,
    notes: r.notes,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    checkList: checks,
    recentErrors: serviceLogs(id, 30),
    recentEvents: listEvents({ serviceId: id, limit: 20 }),
    errorsHourly: Array.from({ length: 24 }, (_, i) => hm.get(hourNow - 23 + i) ?? 0),
  };
}

export function serviceLogs(id: number, limit = 100, before?: number, since?: number): LogItem[] {
  const lim = Math.min(Math.max(limit, 1), 500);
  const where = ["service_id = ?"];
  const args: number[] = [id];
  if (before) (where.push("id < ?"), args.push(before));
  if (since) (where.push("ts >= ?"), args.push(since));
  return (
    db.query(`SELECT id, service_id, ts, prio, msg FROM logs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${lim}`).all(...args) as {
      id: number;
      service_id: number;
      ts: number;
      prio: number;
      msg: string;
    }[]
  ).map((l) => ({ id: l.id, serviceId: l.service_id, ts: l.ts, prio: l.prio, msg: l.msg }));
}

export function checkSummary(id: number): CheckSummary | null {
  const r = getCheckRow(id);
  return r ? toCheckSummary(r, effectiveCheckStatus(r, serverOnline)) : null;
}

export function checkList(): CheckSummary[] {
  return allCheckSummaries();
}
