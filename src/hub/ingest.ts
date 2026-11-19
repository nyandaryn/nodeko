import type { ServerNow } from "../shared/api.ts";
import {
  LIMITS,
  type HostInfo,
  type LogLine,
  type ServiceKind,
  type ServiceSample,
  type ServiceState,
  type SnapMsg,
  type SysMetrics,
} from "../shared/protocol.ts";
import { processCheckResult } from "./checks.ts";
import { checksOfService } from "./checks.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";
import { defaultTracked, pct, serviceStatus, type ServerAlerts, type ServerRow, type ServiceRow } from "./model.ts";
import { applyServiceStatus, serviceLabel } from "./services.ts";

// ---------- санитайзинг недоверенных данных агента ----------

const num = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};
const optNum = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined =>
  v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : num(v, min, max);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");
const optStr = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);

const KINDS: ServiceKind[] = ["systemd", "systemd-user", "docker", "pm2"];
const STATES: ServiceState[] = ["running", "exited", "starting", "stopping", "restarting", "failed", "inactive"];

export function sanitizeHost(h: unknown): HostInfo | null {
  if (!h || typeof h !== "object") return null;
  const o = h as Record<string, unknown>;
  const caps = (o.caps && typeof o.caps === "object" ? o.caps : {}) as Record<string, unknown>;
  return {
    hostname: str(o.hostname, 100),
    os: str(o.os, 100),
    kernel: str(o.kernel, 100),
    arch: str(o.arch, 30),
    cpuModel: str(o.cpuModel, 120),
    cores: num(o.cores, 0, 4096),
    memTotal: num(o.memTotal),
    bootTime: num(o.bootTime),
    user: str(o.user, 64),
    agentVersion: str(o.agentVersion, 30),
    caps: {
      systemdUser: !!caps.systemdUser,
      systemdSystem: !!caps.systemdSystem,
      journalSystem: !!caps.journalSystem,
      journalUser: !!caps.journalUser,
      docker: !!caps.docker,
      pm2: !!caps.pm2,
    },
  };
}

function sanitizeMetrics(m: unknown): SysMetrics | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, any>;
  const fs = Array.isArray(o.fs) ? o.fs.slice(0, 32) : [];
  const load = Array.isArray(o.load) ? o.load : [];
  return {
    cpu: num(o.cpu, 0, 100),
    load: [num(load[0], 0, 1e4), num(load[1], 0, 1e4), num(load[2], 0, 1e4)],
    mem: { total: num(o.mem?.total), used: num(o.mem?.used), available: num(o.mem?.available), cached: num(o.mem?.cached) },
    swap: { total: num(o.swap?.total), used: num(o.swap?.used) },
    fs: fs.map((f: any) => ({ mount: str(f?.mount, 200), dev: str(f?.dev, 200), fstype: str(f?.fstype, 30), total: num(f?.total), used: num(f?.used) })),
    disk: { read: num(o.disk?.read), write: num(o.disk?.write) },
    net: { rx: num(o.net?.rx), tx: num(o.net?.tx), rxTotal: num(o.net?.rxTotal), txTotal: num(o.net?.txTotal) },
    ping: optNum(o.ping, 0, 60_000) ?? null,
    uptime: num(o.uptime),
    procs: num(o.procs, 0, 1e7),
  };
}

function sanitizeSample(s: unknown): ServiceSample | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, any>;
  const kind = o.kind as ServiceKind;
  const state = o.state as ServiceState;
  const name = str(o.name, 200);
  if (!KINDS.includes(kind) || !STATES.includes(state) || !name) return null;
  return {
    key: `${kind}:${name}`,
    kind,
    name,
    description: optStr(o.description, 300),
    state,
    raw: str(o.raw, 120),
    enabled: optStr(o.enabled, 40),
    job: !!o.job,
    vendor: !!o.vendor,
    since: optNum(o.since),
    lastRun: optNum(o.lastRun),
    result: optStr(o.result, 40),
    exitCode: optNum(o.exitCode, -1e6, 1e6),
    pid: optNum(o.pid, 0, 1e9),
    restarts: optNum(o.restarts, 0, 1e9),
    cpu: optNum(o.cpu, 0, 1e5),
    mem: optNum(o.mem),
    tasks: optNum(o.tasks, 0, 1e7),
    ports: Array.isArray(o.ports) ? o.ports.slice(0, 32).map((p: unknown) => num(p, 0, 65535)).filter(Boolean) : undefined,
    version: optStr(o.version, 60),
    commit: optStr(o.commit, 40),
    commitAt: optNum(o.commitAt),
    runtime: optStr(o.runtime, 60),
    cwd: optStr(o.cwd, 300),
    exec: optStr(o.exec, 500),
    image: optStr(o.image, 200),
    health: optStr(o.health, 30),
    logRate: optNum(o.logRate, 0, 1e9),
  };
}

// ---------- hello ----------

export function ingestHello(serverId: string, info: unknown): void {
  const host = sanitizeHost(info);
  if (!host) return;
  db.query("UPDATE servers SET host_json = ? WHERE id = ?").run(JSON.stringify(host), serverId);
}

// ---------- снимок ----------

const qServer = db.query("SELECT * FROM servers WHERE id = ?");
const qServices = db.query("SELECT * FROM services WHERE server_id = ?");
const updServer = db.query("UPDATE servers SET last_seen = ?, now_json = ?, fs_json = ? WHERE id = ?");
const insMetric = db.query(
  `INSERT OR REPLACE INTO m_server(server_id, tier, ts, cpu, cpu_max, mem, mem_used, swap_used, disk, disk_read, disk_write,
     net_rx, net_tx, load1, ping, n) VALUES(?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
);
const insService = db.query(
  `INSERT INTO services(server_id, key, kind, name, tracked, first_seen, last_seen, sample_json, status, status_since)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?) RETURNING *`,
);
const updSample = db.query(
  "UPDATE services SET sample_json = ?, last_seen = ?, missing = 0, last_restarts = ?, last_restart_at = ? WHERE id = ?",
);
const setMissing = db.query("UPDATE services SET missing = 1 WHERE id = ?");
const insSvcMetric = db.query(
  "INSERT OR REPLACE INTO m_service(service_id, tier, ts, cpu, cpu_max, mem, mem_max, n) VALUES(?, 0, ?, ?, NULL, ?, NULL, 1)",
);
const insLog = db.query("INSERT INTO logs(service_id, ts, prio, msg) VALUES(?, ?, ?, ?)");
const incCount = db.query(
  "INSERT INTO log_counts(service_id, minute, n) VALUES(?, ?, ?) ON CONFLICT(service_id, minute) DO UPDATE SET n = n + excluded.n",
);

export function serverNowFrom(m: SysMetrics, ts: number): ServerNow {
  const root = m.fs.find((f) => f.mount === "/") ?? m.fs[0];
  return {
    ts,
    cpu: Math.round(m.cpu * 10) / 10,
    load: m.load,
    memUsed: m.mem.used,
    memTotal: m.mem.total,
    mem: pct(m.mem.used, m.mem.total),
    swapUsed: m.swap.used,
    swapTotal: m.swap.total,
    diskUsed: root?.used ?? 0,
    diskTotal: root?.total ?? 0,
    disk: pct(root?.used ?? 0, root?.total ?? 0),
    diskRead: m.disk.read,
    diskWrite: m.disk.write,
    netRx: m.net.rx,
    netTx: m.net.tx,
    ping: m.ping,
    uptime: m.uptime,
    procs: m.procs,
  };
}

export function ingestSnapshot(serverId: string, snap: SnapMsg): void {
  const m = sanitizeMetrics(snap.m);
  if (!m) return;
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const server = qServer.get(serverId) as ServerRow | null;
  if (!server) return;
  const nowDto = serverNowFrom(m, now);

  const samples = (Array.isArray(snap.svc) ? snap.svc.slice(0, LIMITS.services) : [])
    .map(sanitizeSample)
    .filter((s): s is ServiceSample => !!s);
  const logs = (Array.isArray(snap.logs) ? snap.logs.slice(0, LIMITS.logsPerSnap) : []) as LogLine[];

  const statusWork: { row: ServiceRow; sample: ServiceSample }[] = [];

  db.transaction(() => {
    updServer.run(now, JSON.stringify(nowDto), JSON.stringify(m.fs), serverId);
    insMetric.run(serverId, ts, m.cpu, nowDto.mem, m.mem.used, m.swap.used, nowDto.disk, m.disk.read, m.disk.write, m.net.rx, m.net.tx, m.load[0], m.ping);

    const existing = new Map<string, ServiceRow>();
    for (const r of qServices.all(serverId) as ServiceRow[]) existing.set(r.key, r);
    const seen = new Set<string>();

    for (const s of samples) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      let row = existing.get(s.key);
      if (!row) {
        const tracked = defaultTracked(s);
        row = insService.get(serverId, s.key, s.kind, s.name, tracked ? 1 : 0, now, now, JSON.stringify(s), now) as ServiceRow;
        existing.set(s.key, row);
        if (tracked && server.status !== "pending") {
          addEvent({
            level: "info",
            type: "service.new",
            serverId,
            serviceId: row.id,
            title: `Новый сервис ${serverId} › ${s.name}`,
            message: `${s.kind}${s.description ? ` · ${s.description}` : ""}`,
            notify: "newService",
          });
        }
      }
      let restartAt = row.last_restart_at;
      if (s.restarts !== undefined && row.last_restarts !== null && s.restarts > row.last_restarts) {
        restartAt = now;
        addEvent({
          level: "warn",
          type: "service.restart",
          serverId,
          serviceId: row.id,
          title: `${serviceLabel(row)} — аварийный перезапуск`,
          message: `перезапусков всего: ${s.restarts}${s.result && s.result !== "success" ? ` · причина: ${s.result}` : ""}`,
          notify: row.tracked && !row.muted ? "serviceRestart" : null,
        });
      }
      updSample.run(JSON.stringify(s), now, s.restarts ?? row.last_restarts, restartAt, row.id);
      row.sample_json = JSON.stringify(s);
      row.missing = 0;
      row.last_restart_at = restartAt;
      row.last_restarts = s.restarts ?? row.last_restarts;
      if (s.cpu !== undefined || s.mem !== undefined) insSvcMetric.run(row.id, ts, s.cpu ?? null, s.mem ?? null);
      statusWork.push({ row, sample: s });
    }

    for (const row of existing.values()) {
      if (seen.has(row.key) || row.missing) continue;
      setMissing.run(row.id);
      row.missing = 1;
      if (row.tracked) {
        addEvent({ level: "warn", type: "service.missing", serverId, serviceId: row.id, title: `${serviceLabel(row)} пропал из системы`, message: "юнит/контейнер больше не обнаруживается" });
      }
      statusWork.push({ row, sample: parseJson<ServiceSample>(row.sample_json)! });
    }

    // строки-ошибки
    const minute = Math.floor(now / 60_000);
    for (const l of logs) {
      if (!l || typeof l !== "object") continue;
      const row = existing.get(str(l.key, 250));
      if (!row) continue;
      const lts = Math.min(num(l.ts), now) || now;
      insLog.run(row.id, lts, num(l.prio, 0, 7), str(l.msg, LIMITS.logLineLen));
      incCount.run(row.id, minute, 1);
    }
    if (snap.dropped && typeof snap.dropped === "object") {
      for (const [k, n] of Object.entries(snap.dropped).slice(0, 500)) {
        const row = existing.get(k);
        if (row && num(n) > 0) incCount.run(row.id, minute, Math.round(num(n, 0, 1e6)));
      }
    }
  })();

  for (const { row, sample } of statusWork) {
    applyServiceStatus(row, serviceStatus(row, sample, checksOfService(row.id), now), now);
  }

  if (Array.isArray(snap.chk)) for (const r of snap.chk.slice(0, 1000)) if (r && typeof r === "object") processCheckResult(r, serverId);

  markServerOnline(server, now);
}

/** Сервер прислал данные: снять offline, при необходимости событие «снова на связи». */
export function markServerOnline(server: ServerRow, now = Date.now()): void {
  if (server.status === "down" || server.status === "pending" || server.status === "unknown") {
    const alerts = parseJson<ServerAlerts>(server.alerts_json) ?? {};
    const warn = !!(alerts.cpu || alerts.mem || alerts.disk);
    db.query("UPDATE servers SET status = ?, status_reason = ?, status_since = ? WHERE id = ?").run(
      warn ? "warn" : "ok",
      warn ? server.status_reason : null,
      now,
      server.id,
    );
    if (server.status === "down") {
      const mins = Math.round((now - (server.status_since ?? now)) / 60_000);
      addEvent({
        level: "ok",
        type: "server.online",
        serverId: server.id,
        title: `${server.name} — снова на связи`,
        message: mins > 0 ? `не было связи ~${mins} мин` : null,
        notify: "serverOffline",
      });
    }
  }
}
