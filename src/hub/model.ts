import type { ServerWebSocket } from "bun";
import type { CheckSummary, ServiceRole, Status } from "../shared/api.ts";
import type { HostInfo, ServiceSample, SysMetrics } from "../shared/protocol.ts";
import type { SecureChannel } from "../shared/secure.ts";

export interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  sort: number;
  agent_key: Uint8Array | null;
  enroll_hash: Uint8Array | null;
  enroll_expires: number | null;
  created_at: number;
  last_seen: number | null;
  host_json: string | null;
  now_json: string | null;
  fs_json: string | null;
  overrides_json: string | null;
  alerts_json: string | null;
  status: Status;
  status_reason: string | null;
  status_since: number;
}

export interface ServiceRow {
  id: number;
  server_id: string;
  key: string;
  kind: string;
  name: string;
  display_name: string | null;
  group_name: string | null;
  tracked: number;
  muted: number;
  sort: number;
  notes: string | null;
  first_seen: number;
  last_seen: number;
  missing: number;
  sample_json: string | null;
  status: Status;
  status_reason: string | null;
  status_since: number;
  down_since: number | null;
  notified_down: number;
  last_restarts: number | null;
  last_restart_at: number | null;
}

export interface CheckRow {
  id: number;
  name: string;
  type: "http" | "tcp";
  target: string;
  runner: string;
  server_id: string | null;
  service_id: number | null;
  interval: number;
  timeout: number;
  expect: string | null;
  keyword: string | null;
  method: "GET" | "HEAD";
  insecure: number;
  retries: number;
  enabled: number;
  status: Status;
  status_reason: string | null;
  status_since: number;
  fails: number;
  last_json: string | null;
  cert_expires: number | null;
  cert_notified: number | null;
  created_at: number;
}

export interface ServerAlerts {
  cpu?: { since: number; value: number } | null;
  mem?: { since: number; value: number } | null;
  disk?: { since: number; value: number; mount: string } | null;
}

export type { HostInfo, ServiceSample, SysMetrics };

/** Живое подключение агента. */
export interface AgentWsData {
  ip: string;
  phase: "hs1" | "auth" | "ready" | "closed";
  hs?: import("../shared/secure.ts").HubHandshake;
  channel?: SecureChannel;
  serverId?: string;
  timer?: ReturnType<typeof setTimeout>;
  connectedAt?: number;
  lastSnapAt?: number;
  pingId: number;
  pingSentAt?: number;
}

export interface LiveAgent {
  ws: ServerWebSocket<AgentWsData>;
  ip: string;
  connectedAt: number;
  rtt: number | null;
}

/** Активные подключения агентов: serverId → подключение. */
export const live = new Map<string, LiveAgent>();

export function roleOf(sample: ServiceSample | null): ServiceRole {
  return sample?.job ? "job" : "service";
}

/** Включён ли автозапуск — тогда «не запущен» означает падение, а не намеренную остановку. */
function autostart(s: ServiceSample): boolean {
  const e = (s.enabled ?? "").toLowerCase();
  return ["enabled", "enabled-runtime", "linked", "alias", "always", "unless-stopped", "on-failure", "true"].includes(e);
}

export function serviceStatus(
  row: Pick<ServiceRow, "missing" | "last_restart_at">,
  sample: ServiceSample | null,
  checks: Pick<CheckSummary, "status" | "name" | "statusReason" | "enabled">[],
  now = Date.now(),
): { status: Status; reason: string | null } {
  if (row.missing) return { status: "unknown", reason: "пропал из системы" };
  if (!sample) return { status: "unknown", reason: "нет данных" };
  let status: Status = "ok";
  let reason: string | null = null;
  switch (sample.state) {
    case "running":
      if (sample.health === "unhealthy") {
        status = "down";
        reason = "healthcheck: unhealthy";
      } else if (sample.health === "starting") {
        status = "warn";
        reason = "healthcheck: запускается";
      }
      break;
    case "exited":
      if (sample.result && sample.result !== "success") {
        status = "down";
        reason = `завершился: ${sample.result}`;
      }
      break;
    case "starting":
      status = "warn";
      reason = "запускается";
      break;
    case "stopping":
      status = "warn";
      reason = "останавливается";
      break;
    case "restarting":
      status = "warn";
      reason = "перезапускается";
      break;
    case "failed":
      status = "down";
      reason = sample.result && sample.result !== "success" ? `упал: ${sample.result}` : "упал";
      if (sample.exitCode !== undefined && sample.exitCode !== 0) reason += ` (код ${sample.exitCode})`;
      break;
    case "inactive":
      if (sample.job) {
        if (sample.result && sample.result !== "success") {
          status = "down";
          reason = `последний запуск: ${sample.result}`;
        } else {
          status = "ok";
          reason = null;
        }
      } else if (autostart(sample)) {
        status = "down";
        reason = "не запущен (автозапуск включён)";
      } else {
        status = "stopped";
        reason = "остановлен";
      }
      break;
  }
  if (status === "ok" || status === "warn") {
    const active = checks.filter((c) => c.enabled);
    const down = active.find((c) => c.status === "down");
    const warn = active.find((c) => c.status === "warn");
    if (down) {
      status = "down";
      reason = `проверка «${down.name}»: ${down.statusReason ?? "не проходит"}`;
    } else if (status === "ok" && warn) {
      status = "warn";
      reason = `проверка «${warn.name}»: ${warn.statusReason ?? "сбои"}`;
    }
  }
  if (status === "ok" && row.last_restart_at && now - row.last_restart_at < 15 * 60_000) {
    status = "warn";
    reason = `аварийный перезапуск ${Math.max(1, Math.round((now - row.last_restart_at) / 60_000))} мин назад`;
  }
  return { status, reason };
}

/** Сервисы, которые по умолчанию стоит отслеживать среди пакетных (vendor) юнитов. */
const VENDOR_ALLOW =
  /^(caddy|nginx|apache2|httpd|haproxy|traefik|docker|containerd|crowdsec.*|cloudflared.*|postgres.*|redis.*|mysql|mariadb|mongod|fail2ban|xrdp.*|beszel.*|pm2-.*|tailscaled|wg-quick@.*|php.*-fpm|clickhouse.*|minio|rabbitmq.*|netdata|grafana.*|prometheus.*|node_exporter|uptime-kuma|supervisor|gitea|forgejo|vaultwarden|coolify.*)$/;

export function defaultTracked(s: ServiceSample): boolean {
  if (s.kind === "docker" || s.kind === "pm2") return true;
  if (!s.vendor) return true;
  return VENDOR_ALLOW.test(s.name);
}

/** Автогруппы: префикс имени до первого -_.@, если на сервере ≥2 отслеживаемых сервиса с таким префиксом. */
export function computeGroups(rows: Pick<ServiceRow, "id" | "name" | "group_name" | "tracked">[]): Map<number, string | null> {
  const prefix = (n: string) => n.split(/[-_.@]/)[0]!.toLowerCase();
  const counts = new Map<string, number>();
  for (const r of rows) if (r.tracked && r.group_name === null) counts.set(prefix(r.name), (counts.get(prefix(r.name)) ?? 0) + 1);
  const out = new Map<number, string | null>();
  for (const r of rows) {
    if (r.group_name === "") out.set(r.id, null);
    else if (r.group_name) out.set(r.id, r.group_name);
    else {
      const p = prefix(r.name);
      out.set(r.id, (counts.get(p) ?? 0) >= 2 ? p : null);
    }
  }
  return out;
}

export function semverLess(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);
