/**
 * Мок хаба для разработки веб-интерфейса: все эндпоинты из src/shared/api.ts с правдоподобными данными в памяти.
 *   PORT=4179 bun scripts/mock-hub.ts
 *   NODEKO_DEV_HUB=http://127.0.0.1:4179 bunx --bun vite --config web/vite.config.ts --port 5179
 * Логин admin / admin.
 */
import type {
  CheckBody,
  CheckSummary,
  EventItem,
  LogItem,
  MetricsRange,
  Note,
  NoteCreateBody,
  NoteKind,
  NotePatchBody,
  NoteRef,
  NoteRevisionItem,
  PasskeyItem,
  ServerDetail,
  ServerSummary,
  ServiceDetail,
  ServiceSummary,
  SessionItem,
  Settings,
  Status,
  TokenItem,
} from "../src/shared/api.ts";
import {
  applyEdits,
  checkBody,
  checkNoteId,
  checkServers,
  checkServices,
  checkSummary,
  checkTags,
  checkTitle,
  isNoteKind,
  NoteError,
  searchNotes,
} from "../src/shared/notes.ts";
import type { ServiceKind, ServiceState } from "../src/shared/protocol.ts";

const PORT = Number(process.env.PORT ?? 4179);
const NOW = () => Date.now();
const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
const counts0 = (): Record<Status, number> => ({ ok: 0, warn: 0, down: 0, stopped: 0, unknown: 0, pending: 0 });

// ---------------- servers ----------------
const host = (hostname: string, os: string, arch: string, cores: number, mem: number, user: string, bootAgo: number, caps: Record<string, boolean>) => ({
  hostname,
  os,
  kernel: arch === "aarch64" ? "7.0.0-14-generic" : "6.8.0-71-generic",
  arch,
  cpuModel: arch === "aarch64" ? "Neoverse-N1" : "AMD EPYC-Rome Processor",
  cores,
  memTotal: mem,
  bootTime: NOW() - bootAgo,
  user,
  agentVersion: "1.0.0",
  caps,
});

interface Srv {
  id: string;
  name: string;
  description: string | null;
  sort: number;
  host: ServerSummary["host"];
  enrolled: boolean;
  connected: boolean;
  base: { cpu: number; mem: number; disk: number; net: number };
  overrides: ServerDetail["overrides"];
}
const servers: Srv[] = [
  {
    id: "atlas",
    name: "atlas",
    description: "Прод: магазин, API, воркеры",
    sort: 0,
    host: host("atlas", "Ubuntu 24.04.4 LTS", "x86_64", 4, 7.75 * GB, "deploy", 27 * D + 14 * H, {
      systemdUser: true,
      systemdSystem: true,
      journalSystem: false,
      journalUser: true,
      docker: true,
      pm2: true,
    }),
    enrolled: true,
    connected: true,
    base: { cpu: 24, mem: 52, disk: 71, net: 380_000 },
    overrides: { disk: { pct: 85 } },
  },
  {
    id: "nebula",
    name: "nebula",
    description: "Домашний сервер: медиа, финансы",
    sort: 1,
    host: host("nebula", "Debian GNU/Linux 13 (trixie)", "x86_64", 4, 7.75 * GB, "app", 124 * D, {
      systemdUser: true,
      systemdSystem: true,
      journalSystem: true,
      journalUser: true,
      docker: true,
      pm2: false,
    }),
    enrolled: true,
    connected: true,
    base: { cpu: 6, mem: 21, disk: 34, net: 60_000 },
    overrides: null,
  },
  {
    id: "pico",
    name: "pico",
    description: "arm64 — хаб nodeko, вики",
    sort: 2,
    host: host("pico", "Ubuntu 26.04.1 LTS", "aarch64", 2, 3.7 * GB, "deploy", 3 * D + 3 * H, {
      systemdUser: true,
      systemdSystem: true,
      journalSystem: true,
      journalUser: true,
      docker: false,
      pm2: false,
    }),
    enrolled: true,
    connected: true,
    base: { cpu: 11, mem: 20, disk: 22, net: 45_000 },
    overrides: null,
  },
  {
    id: "test-box",
    name: "test-box",
    description: null,
    sort: 3,
    host: null,
    enrolled: false,
    connected: false,
    base: { cpu: 0, mem: 0, disk: 0, net: 0 },
    overrides: null,
  },
];

// ---------------- services ----------------
let svcSeq = 100;
const services: (ServiceDetail & { _hidden?: boolean })[] = [];

function addSvc(
  serverId: string,
  name: string,
  kind: ServiceKind,
  group: string | null,
  o: Partial<ServiceDetail> & { state?: ServiceState } = {},
) {
  const r = hash(serverId + name);
  const id = ++svcSeq;
  const job = o.role === "job";
  const state: ServiceState = o.state ?? (job ? "inactive" : "running");
  const since = state === "running" ? NOW() - (2 * H + r * 20 * D) : null;
  const s: ServiceDetail = {
    id,
    serverId,
    key: `${kind}:${name}`,
    kind,
    name,
    displayName: null,
    group,
    role: job ? "job" : "service",
    status: "ok",
    statusReason: null,
    statusSince: since ?? NOW() - 5 * H,
    state,
    tracked: true,
    muted: false,
    missing: false,
    sort: 0,
    since,
    lastRun: job ? NOW() - (1 + r * 20) * H : null,
    version: kind === "docker" ? "16.10" : kind === "systemd" ? null : `${1 + Math.floor(r * 3)}.${Math.floor(r * 20)}.${Math.floor(r * 9)}`,
    commit: kind === "systemd-user" && !job ? (r * 1e9).toString(16).slice(0, 7) : null,
    cpu: state === "running" ? +(r * 8 + 0.2).toFixed(1) : null,
    mem: state === "running" ? Math.round((40 + r * 380) * MB) : null,
    restarts: Math.floor(r * 3) === 2 ? 1 : 0,
    ports: kind === "systemd-user" && !job && r > 0.3 ? [4000 + Math.floor(r * 170)] : [],
    errors1h: 0,
    checks: { total: 0, ok: 0 },
    description: o.description ?? null,
    raw: state === "running" ? (kind === "docker" ? "Up 3 weeks (healthy)" : "active/running") : job ? "inactive/dead" : "inactive/dead",
    enabled: job ? "static" : "enabled",
    vendor: kind === "systemd" && ["caddy", "docker", "crowdsec", "crowdsec-firewall-bouncer", "xrdp", "cloudflared"].includes(name),
    result: job ? "success" : null,
    exitCode: job ? 0 : null,
    pid: state === "running" ? 1000 + Math.floor(r * 300000) : null,
    tasks: state === "running" ? 5 + Math.floor(r * 30) : null,
    commitAt: kind === "systemd-user" && !job ? NOW() - r * 30 * D : null,
    runtime: kind === "systemd-user" && !job ? (name.includes("grafana") ? "node 22.16.0" : "bun 1.4.0") : kind === "pm2" ? "node 20.17.0" : null,
    cwd: kind === "systemd-user" ? `/home/${serverId === "nebula" ? "app" : "deploy"}/${name.split("-")[0]}` : null,
    exec: kind === "systemd-user" ? "/home/deploy/.bun/bin/bun run start" : kind === "systemd" ? `/usr/bin/${name}` : null,
    image: kind === "docker" ? "postgres:16" : null,
    health: kind === "docker" ? "healthy" : null,
    logRate: state === "running" ? +(r * 40).toFixed(1) : null,
    notes: null,
    firstSeen: NOW() - 30 * D,
    lastSeen: NOW(),
    checkList: [],
    recentErrors: [],
    recentEvents: [],
    errorsHourly: Array.from({ length: 24 }, () => 0),
    linkedNotes: [],
    ...o,
  };
  services.push(s);
  return s;
}

// atlas
const U = "systemd-user" as const;
const S = "systemd" as const;
const shopWeb = addSvc("atlas", "shop-web", U, "shop");
const shopApi = addSvc("atlas", "shop-api", U, "shop", { description: "Shop API (prod)" });
addSvc("atlas", "shop-worker", U, "shop");
addSvc("atlas", "shop-backup", U, "shop", { role: "job", description: "Ночной бэкап магазина" });
addSvc("atlas", "shop-web-staging", U, "shop-staging");
const shopApiStaging = addSvc("atlas", "shop-api-staging", U, "shop-staging", {
  state: "failed",
  status: "down",
  statusReason: "failed (exit-code 1)",
  statusSince: NOW() - 7 * MIN,
  raw: "failed/failed",
  result: "exit-code",
  exitCode: 1,
  restarts: 3,
  errors1h: 42,
  since: null,
  pid: null,
  cpu: null,
  mem: null,
});
const billingApi = addSvc("atlas", "billing-api", U, "billing");
addSvc("atlas", "billing-web", U, "billing");
addSvc("atlas", "billing-backup", U, "billing", { role: "job" });
addSvc("atlas", "notify-bot", U, "notify");
addSvc("atlas", "notify-worker", U, "notify", { status: "warn", statusReason: "4 перезапуска за 10 мин", restarts: 4, errors1h: 7, since: NOW() - 3 * MIN });
addSvc("atlas", "auth-server", U, "auth");
addSvc("atlas", "auth-web", U, "auth");
addSvc("atlas", "auth-backup", U, "auth", { role: "job" });
addSvc("atlas", "search-api", U, "search");
addSvc("atlas", "search-indexer", U, "search");
addSvc("atlas", "blog", U, "blog");
addSvc("atlas", "cloudflared-blog", U, "blog", { runtime: null, version: "2026.10.0" });
addSvc("atlas", "blog-backup", U, "blog", { role: "job" });
addSvc("atlas", "analytics", U, null);
addSvc("atlas", "status-page", U, null);
addSvc("atlas", "grafana", U, null, { displayName: "Grafana" });
addSvc("atlas", "webhook-relay", U, null, {
  missing: true,
  status: "unknown",
  statusReason: "юнит не найден",
  state: "inactive",
  since: null,
  enabled: "disabled",
  cpu: null,
  mem: null,
});
addSvc("atlas", "caddy", S, "infra", { version: "2.10.2" });
addSvc("atlas", "crowdsec", S, "infra", { version: "1.7.3" });
addSvc("atlas", "crowdsec-firewall-bouncer", S, "infra", { version: "0.0.33" });
addSvc("atlas", "docker", S, "infra", { version: "28.5.1" });
addSvc("atlas", "shop-pg", "docker", null, { displayName: "shop-pg" });
addSvc("atlas", "redirector", "pm2", "pm2");
addSvc("atlas", "landing", "pm2", "pm2", { errors1h: 2 });
addSvc("atlas", "gpg-agent", U, null, { tracked: false, status: "stopped", state: "inactive", since: null, cpu: null, mem: null });
addSvc("atlas", "unattended-upgrades", S, null, { tracked: false, vendor: true });
// nebula
for (const n of ["jellyfin", "photo-sync", "rss-reader", "spam-filter", "dyndns"]) addSvc("nebula", n, U, null);
for (const n of ["media-api", "media-proxy", "media-tunnel"]) addSvc("nebula", n, U, "media");
for (const n of ["paperless", "paperless-tunnel"]) addSvc("nebula", n, U, "paperless");
addSvc("nebula", "finance-tracker", S, "finance");
addSvc("nebula", "finance-backup", S, "finance");
addSvc("nebula", "xrdp", S, "infra");
addSvc("nebula", "crowdsec", S, "infra");
addSvc("nebula", "docker", S, "infra", { state: "inactive", status: "stopped", enabled: "disabled", since: null, cpu: null, mem: null });
// pico
addSvc("pico", "wiki", U, null);
addSvc("pico", "nodeko-hub", U, "nodeko");
addSvc("pico", "nodeko-agent", U, "nodeko");
addSvc("pico", "cloudflared", S, null, { version: "2026.11.0" });
addSvc("pico", "crowdsec", S, null);

for (const s of services) {
  if (s.errors1h > 0) {
    s.errorsHourly = Array.from({ length: 24 }, (_, i) => (i > 20 ? Math.round(s.errors1h * (0.3 + hash(s.name + i))) : hash(s.name + i) > 0.8 ? Math.round(hash(s.name + i) * 6) : 0));
  }
}

// ---------------- checks ----------------
let chkSeq = 10;
const checks: CheckSummary[] = [];
function beats(seed: string, failRate: number, lastFail = false): (0 | 1)[] {
  const b = Array.from({ length: 60 }, (_, i) => (hash(seed + i) < failRate ? 0 : 1) as 0 | 1);
  if (lastFail) b.splice(57, 3, 0, 0, 0);
  return b;
}
function addCheck(c: Partial<CheckSummary> & Pick<CheckSummary, "name" | "target">) {
  const id = ++chkSeq;
  const failing = c.status === "down";
  const ch: CheckSummary = {
    id,
    type: "http",
    runner: "hub",
    serverId: null,
    serviceId: null,
    interval: 60,
    timeout: 10000,
    expect: null,
    keyword: null,
    method: "GET",
    insecure: false,
    retries: 2,
    enabled: true,
    status: "ok",
    statusReason: null,
    statusSince: NOW() - 3 * D,
    last: { t: NOW() - 20_000, ok: !failing, code: failing ? 502 : 200, ms: 180 + Math.round(hash(c.name) * 200), err: failing ? "HTTP 502" : null },
    uptime24h: failing ? 97.2 : 100,
    uptime30d: failing ? 99.1 : 99.98,
    avgMs24h: 210 + Math.round(hash(c.name) * 120),
    certExpires: c.target.startsWith("https") ? NOW() + (20 + hash(c.name) * 60) * D : null,
    beats: beats(c.name, failing ? 0.05 : 0.01, failing),
    ...c,
  };
  checks.push(ch);
  return ch;
}
addCheck({ name: "shop.example.com", target: "https://shop.example.com/", serverId: "atlas", serviceId: shopWeb.id });
addCheck({ name: "Billing health", target: "https://billing.example.com/api/health", serverId: "atlas", serviceId: billingApi.id, keyword: "ok" });
addCheck({ name: "Shop API (изнутри)", target: "http://127.0.0.1:4055/api/v1/health", runner: "atlas", serverId: "atlas", serviceId: shopApi.id, interval: 30 });
addCheck({ name: "Shop API staging", target: "http://127.0.0.1:4041/api/v1/health", runner: "atlas", serverId: "atlas", serviceId: shopApiStaging.id, status: "down", statusReason: "ECONNREFUSED", statusSince: NOW() - 7 * MIN });
addCheck({ name: "partner.example.org", target: "https://partner.example.org/", status: "down", statusReason: "HTTP 502 · 3 раза подряд", statusSince: NOW() - 4 * MIN, certExpires: NOW() + 9 * D });
addCheck({ name: "SSH pico", type: "tcp", target: "192.0.2.10:22", serverId: "pico", method: "GET" });

function refreshDerived() {
  for (const s of services) {
    const cl = checks.filter((c) => c.serviceId === s.id);
    s.checkList = cl;
    s.checks = { total: cl.length, ok: cl.filter((c) => c.status === "ok").length };
  }
}
refreshDerived();

// ---------------- events / logs ----------------
let evSeq = 1000;
const events: EventItem[] = [];
function ev(ts: number, level: EventItem["level"], type: string, title: string, o: Partial<EventItem> = {}) {
  events.push({ id: ++evSeq, ts, level, type, title, message: null, serverId: null, serviceId: null, checkId: null, actor: null, ...o });
}
let seed = 42;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
for (let i = 0; i < 90; i++) {
  const t = NOW() - 3 * D + i * 47 * MIN;
  const s = services[Math.floor(rnd() * services.length)]!;
  const r = rnd();
  if (r < 0.3) ev(t, "warn", "service.restart", `${s.name} перезапущен`, { serverId: s.serverId, serviceId: s.id, message: "systemd: Scheduled restart job, restart counter is at 1" });
  else if (r < 0.45) ev(t, "error", "service.down", `${s.name} упал`, { serverId: s.serverId, serviceId: s.id, message: "Main process exited, code=exited, status=1/FAILURE" });
  else if (r < 0.6) ev(t + 40_000, "ok", "service.up", `${s.name} снова работает`, { serverId: s.serverId, serviceId: s.id });
  else if (r < 0.7) ev(t, "warn", "alert.cpu", `CPU atlas 93% > 90% дольше 5 мин`, { serverId: "atlas" });
  else if (r < 0.75) ev(t, "info", "config.service", `Сервис ${s.name}: группа изменена`, { serverId: s.serverId, serviceId: s.id, actor: "token:claude-code" });
  else if (r < 0.85) ev(t, "error", "check.down", `partner.example.org недоступен`, { checkId: 15, message: "HTTP 502" });
  else ev(t + 120_000, "ok", "check.up", `partner.example.org снова доступен`, { checkId: 15 });
}
ev(NOW() - 7 * MIN, "error", "service.down", "shop-api-staging упал", { serverId: "atlas", serviceId: shopApiStaging.id, message: "Failed with result 'exit-code'" });
ev(NOW() - 4 * MIN, "error", "check.down", "partner.example.org недоступен", { checkId: 15, message: "HTTP 502 · 3 раза подряд" });
ev(NOW() - 3 * MIN, "warn", "service.restart", "notify-worker перезапущен (4 за 10 мин)", { serverId: "atlas", serviceId: services.find((s) => s.name === "notify-worker")!.id });
ev(NOW() - 2 * D, "info", "agent.enrolled", "Агент pico зарегистрирован", { serverId: "pico", actor: "system" });
events.sort((a, b) => a.ts - b.ts);
events.forEach((e, i) => (e.id = 1001 + i));
evSeq = 1000 + events.length;
events.reverse();

let logSeq = 5000;
const logs: LogItem[] = [];
const LOGMSG = [
  "error: connect ECONNREFUSED 127.0.0.1:5432",
  'TypeError: Cannot read properties of undefined (reading "price")\n    at calcOrder (/home/deploy/shop/packages/api/src/orders.ts:214:31)\n    at async handle (/home/deploy/shop/packages/api/src/http.ts:88:12)',
  "shop-api-staging.service: Main process exited, code=exited, status=1/FAILURE",
  "[ERR] payment provider: upstream 500 after 30012ms",
  "Unhandled promise rejection: FetchError: request to https://api.telegram.org failed, reason: socket hang up",
  "level=error msg=\"webhook delivery failed\" shop=… status=503",
];
for (const s of services.filter((x) => x.errors1h > 0)) {
  const n = Math.min(140, s.errors1h * 3);
  for (let i = 0; i < n; i++)
    logs.push({ id: ++logSeq, serviceId: s.id, ts: NOW() - (n - 1 - i) * 97_000, prio: hash(s.name + i) > 0.5 ? 3 : 4, msg: LOGMSG[Math.floor(hash(s.name + "m" + i) * LOGMSG.length)]! });
}
logs.sort((a, b) => b.id - a.id);

// ---------------- settings / auth ----------------
let settings: Settings = {
  publicUrl: "https://nodeko.example.com",
  agentInterval: 10,
  thresholds: { cpu: { pct: 90, minutes: 5 }, mem: { pct: 90, minutes: 5 }, disk: { pct: 90 }, offlineSeconds: 60 },
  serviceDownDelay: 30,
  notify: {
    telegram: { enabled: true, chatId: "-1001234567890", threadId: null, botTokenSet: true },
    events: { serverOffline: true, serviceDown: true, serviceRestart: false, checkDown: true, thresholds: true, recovery: true, certExpiry: true, newService: false },
  },
  logPattern: String.raw`\b(error|exception|fatal|panic|critical|uncaught|unhandled|traceback|segfault)\b|\[(err|error|fatal)\]`,
  pingTarget: "1.1.1.1:443",
  retention: { rawHours: 48, minuteDays: 30, quarterDays: 400, eventsDays: 90, logsDays: 14 },
  certWarnDays: 14,
};
let tokens: TokenItem[] = [{ id: "a1b2c3d4", name: "claude-code", scope: "admin", createdAt: NOW() - 5 * D, lastUsed: NOW() - 2 * H, hint: "x9Qa" }];
let passkeys: PasskeyItem[] = [{ id: "cred-macbook", name: "Chrome · Linux", createdAt: NOW() - 10 * D, lastUsed: NOW() - D, deviceType: "multiDevice", backedUp: true }];
let sessions: SessionItem[] = [
  { id: "sess-cur", createdAt: NOW() - 2 * H, lastSeen: NOW(), ip: "203.0.113.24", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0", current: true, method: "password" },
  { id: "sess-old", createdAt: NOW() - 6 * D, lastSeen: NOW() - 3 * H, ip: "198.51.100.7", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Safari/604.1", current: false, method: "passkey" },
];

// ---------------- derived views ----------------
function serverStatus(s: Srv): { status: Status; reason: string | null } {
  if (!s.enrolled) return { status: "pending", reason: "агент не зарегистрирован" };
  if (!s.connected) return { status: "down", reason: "нет связи" };
  const n = nowOf(s)!;
  const t = { ...settings.thresholds, ...(s.overrides ?? {}) };
  if (n.disk >= t.disk.pct) return { status: "warn", reason: `диск ${Math.round(n.disk)}% ≥ ${t.disk.pct}%` };
  if (n.cpu >= t.cpu.pct) return { status: "warn", reason: `CPU ${Math.round(n.cpu)}%` };
  return { status: "ok", reason: null };
}

function wave(seed: string, t: number, base: number, amp: number) {
  const p = hash(seed) * 10;
  const v = base + amp * Math.sin(t / 3_600_000 / 3 + p) + amp * 0.5 * Math.sin(t / 600_000 + p * 2) + amp * 0.35 * (hash(seed + Math.floor(t / 10_000)) - 0.5);
  return Math.max(0, v);
}

function nowOf(s: Srv): ServerSummary["now"] {
  if (!s.enrolled || !s.host) return null;
  const t = NOW();
  const cpu = Math.min(100, wave(s.id + "cpu", t, s.base.cpu, s.base.cpu * 0.5));
  const mem = Math.min(100, wave(s.id + "mem", t, s.base.mem, 3));
  const memTotal = s.host.memTotal;
  const diskTotal = s.id === "pico" ? 38 * GB : 169 * GB;
  return {
    ts: t - 3000,
    cpu,
    load: [+(cpu / 25).toFixed(2), +(cpu / 28).toFixed(2), +(cpu / 30).toFixed(2)],
    memUsed: (mem / 100) * memTotal,
    memTotal,
    mem,
    swapUsed: s.id === "atlas" ? 380 * MB : 0,
    swapTotal: s.id === "atlas" ? 2 * GB : 0,
    diskUsed: (s.base.disk / 100) * diskTotal,
    diskTotal,
    disk: s.base.disk,
    diskRead: wave(s.id + "dr", t, 120_000, 90_000),
    diskWrite: wave(s.id + "dw", t, 400_000, 300_000),
    netRx: wave(s.id + "rx", t, s.base.net, s.base.net * 0.6),
    netTx: wave(s.id + "tx", t, s.base.net * 1.6, s.base.net),
    ping: s.id === "pico" ? 4 : 8 + Math.round(hash(s.id) * 6),
    uptime: (t - s.host.bootTime) / 1000,
    procs: 180 + Math.round(hash(s.id) * 120),
  };
}

function summary(s: Srv): ServerSummary {
  const st = serverStatus(s);
  const counts = counts0();
  for (const x of services) if (x.serverId === s.id && x.tracked) counts[x.status]++;
  for (const c of checks) if (c.serverId === s.id) counts[c.status]++;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    status: st.status,
    statusReason: st.reason,
    statusSince: NOW() - 2 * D,
    connected: s.connected,
    lastSeen: s.enrolled ? NOW() - 4000 : null,
    sort: s.sort,
    host: s.host,
    now: nowOf(s),
    counts,
    enrolled: s.enrolled,
    agentOutdated: false,
  };
}

function svcSummary(s: ServiceDetail): ServiceSummary {
  const { description, raw, enabled, vendor, result, exitCode, pid, tasks, commitAt, runtime, cwd, exec, image, health, logRate, notes, firstSeen, lastSeen, checkList, recentErrors, recentEvents, errorsHourly, ...rest } = s;
  void [description, raw, enabled, vendor, result, exitCode, pid, tasks, commitAt, runtime, cwd, exec, image, health, logRate, notes, firstSeen, lastSeen, checkList, recentErrors, recentEvents, errorsHourly];
  return rest;
}

function detail(s: Srv): ServerDetail {
  const sum = summary(s);
  const t = { ...settings.thresholds, ...(s.overrides ?? {}) };
  const n = sum.now;
  return {
    ...sum,
    filesystems: n
      ? [
          { mount: "/", dev: "/dev/vda2", fstype: "ext4", used: n.diskUsed, total: n.diskTotal },
          { mount: "/boot/efi", dev: "/dev/vda1", fstype: "vfat", used: 6.1 * MB, total: 105 * MB },
        ]
      : [],
    thresholds: t,
    overrides: s.overrides,
    agentKeyFingerprint: s.enrolled ? "9f3a:21c7:e0b4:5d18" : null,
    traffic: { rx24h: s.base.net * 86400, tx24h: s.base.net * 1.6 * 86400, rx30d: s.base.net * 86400 * 30, tx30d: s.base.net * 1.6 * 86400 * 30 },
    alerts: { cpu: false, mem: false, disk: sum.status === "warn" },
    enrollPending: !s.enrolled,
    remoteAddr: s.enrolled ? `${s.id === "pico" ? "127.0.0.1" : "203.0.113." + (10 + s.sort)}` : null,
    connectedAt: s.enrolled ? NOW() - 5 * H : null,
    rtt: s.enrolled ? (s.id === "pico" ? 1 : 38) : null,
    linkedNotes: notesForServer(s.id),
  };
}

// ---------------- metrics ----------------
const RANGES: Record<MetricsRange, { span: number; step: number }> = {
  "1h": { span: H, step: 10 },
  "6h": { span: 6 * H, step: 60 },
  "24h": { span: 24 * H, step: 240 },
  "7d": { span: 7 * D, step: 1800 },
  "30d": { span: 30 * D, step: 7200 },
  "1y": { span: 365 * D, step: 86400 },
};
function timeline(range: MetricsRange) {
  const { span, step } = RANGES[range] ?? RANGES["6h"];
  const to = Math.floor(NOW() / 1000 / step) * step;
  const from = to - span / 1000;
  const t: number[] = [];
  for (let x = from; x <= to; x += step) t.push(x);
  return { range, from: from * 1000, to: to * 1000, step, t };
}
function series(seed: string, t: number[], base: number, amp: number, max = Infinity, gap = false) {
  return t.map((x, i) => (gap && i > t.length * 0.62 && i < t.length * 0.66 ? null : Math.min(max, +wave(seed, x * 1000, base, amp).toFixed(2))));
}

// ---------------- notes (база знаний) ----------------
const KIND_ORDER: NoteKind[] = ["server", "project", "runbook", "reference"];
const notes = new Map<string, Note>();
const revisions = new Map<string, { item: NoteRevisionItem; note: Note | null }[]>();
const sizeOf = (t: string) => new TextEncoder().encode(t).length;

function saveRev(n: Note, deleted = false) {
  const list = revisions.get(n.id) ?? [];
  list.unshift({ item: { rev: n.rev, ts: n.updatedAt, actor: n.updatedBy, title: n.title, size: deleted ? 0 : n.size, deleted }, note: deleted ? null : { ...n } });
  revisions.set(n.id, list);
}

function seedNote(n: Omit<Note, "rev" | "size" | "createdAt" | "updatedAt" | "updatedBy">, history: { ago: number; by: string; body?: string; title?: string }[]) {
  let rev = 0;
  const created = NOW() - history[0]!.ago;
  for (const h of history) {
    const body = h.body ?? n.body;
    const v: Note = { ...n, title: h.title ?? n.title, body, rev: ++rev, size: sizeOf(body), createdAt: created, updatedAt: NOW() - h.ago, updatedBy: h.by };
    saveRev(v);
    notes.set(n.id, v);
  }
}

seedNote(
  {
    id: "atlas",
    kind: "server",
    title: "atlas — прод-сервер",
    summary: "Что крутится на atlas, как туда ходить, общие правила для юнитов и бэкапов.",
    tags: ["prod", "systemd"],
    servers: ["atlas"],
    services: [],
    body: `Ubuntu 24.04 · 4 CPU · 8 ГБ RAM. SSH-алиас \`atlas\`, пользователь \`deploy\`.

Всё прикладное — **systemd user** (\`systemctl --user\`), reverse-proxy — Caddy (\`/etc/caddy/Caddyfile\`).

## Сервисы

| Сервис | Каталог | Порт | Домен | Заметка |
|--------|---------|------|-------|---------|
| \`shop-api\` | \`/home/deploy/shop\` | 4055 | shop.example.com | [[shop]] |
| \`shop-web\` | ↑ | 4056 | ↑ | ↑ |
| \`billing-api\` | \`/home/deploy/billing\` | 4070 | billing.example.com | [[billing]] |
| \`grafana\` | — | 3000 | — | [[grafana]] |

## Правила

- \`ssh atlas '<cmd>'\` не читает \`.bashrc\` — bun по абсолютному пути: \`~/.bun/bin/bun\`.
- Юниты не в git, лежат в \`~/.config/systemd/user/\`.
- Бэкапы — таймеры \`*-backup\` ночью; см. [[deploy-rollback]].

> Пароли и ключи сюда не пишем — они в менеджере паролей.
`,
  },
  [{ ago: 40 * D, by: "user:admin" }],
);

seedNote(
  {
    id: "shop",
    kind: "project",
    title: "Магазин — прод, staging, выкатка",
    summary: "Где живёт магазин (API, веб, воркер), как выкатывать и откатывать, известные грабли.",
    tags: ["deploy", "bun"],
    servers: ["atlas"],
    services: ["atlas/shop-api", "atlas/shop-web", "atlas/shop-worker", "atlas/shop-api-staging"],
    body: `Репозиторий \`example/shop\`, ветка \`main\` — прод, \`dev\` — staging. Сервер — [[atlas]].

## Окружения

| | Прод | Staging |
|---|---|---|
| Каталог | \`/home/deploy/shop\` | \`/home/deploy/shop-staging\` |
| Юниты | \`shop-api\`, \`shop-web\`, \`shop-worker\` | \`shop-api-staging\`, \`shop-web-staging\` |
| Домен | https://shop.example.com | https://staging.shop.example.com |
| БД | \`app.db\` (SQLite, WAL) | своя копия |

## Выкатка

\`\`\`sh
ssh atlas 'cd ~/shop && ./update.sh -a -w'
\`\`\`

- [x] миграции применяются при старте API
- [ ] воркер перезапускать отдельно, если менялась очередь

Откат — [[deploy-rollback]]. Секрет подписи вебхуков — в \`.env\` (не здесь).

## Грабли

1. \`update.sh\` без \`-m\` не гоняет миграции.
2. Staging делит Redis с продом — ~~не чистить~~ чистить только префикс \`stg:\`.
`,
  },
  [
    { ago: 30 * D, by: "user:admin", title: "Магазин", body: "Репозиторий `example/shop`, ветка `main` — прод.\n" },
    { ago: 12 * D, by: "token:claude", title: "Магазин — прод и выкатка", body: "Репозиторий `example/shop`, ветка `main` — прод, `dev` — staging.\n\n## Выкатка\n\n```sh\nssh atlas 'cd ~/shop && ./update.sh -a -w'\n```\n" },
    { ago: 2 * H, by: "token:claude" },
  ],
);

seedNote(
  {
    id: "deploy-rollback",
    kind: "runbook",
    title: "Откат релиза bun-сервиса",
    summary: "Пошагово: вернуть предыдущий коммит, перезапустить юниты, проверить health.",
    tags: ["deploy", "bun"],
    servers: [],
    services: [],
    body: `1. Найти предыдущий коммит: \`git log --oneline -5\`.
2. \`git checkout <коммит> && bun install --frozen-lockfile\`.
3. \`systemctl --user restart <сервис>\` и проверить \`curl -fsS http://127.0.0.1:<порт>/api/health\`.
4. Записать в заметку проекта, почему откатывали.

Замена бинаря bun не переключает работающие процессы — нужен рестарт.
`,
  },
  [{ ago: 20 * D, by: "user:admin" }],
);

seedNote(
  {
    id: "billing",
    kind: "project",
    title: "Billing — API и кабинет",
    summary: "Платёжный API и веб-кабинет на atlas; бэкап ночью.",
    tags: ["deploy"],
    servers: ["atlas"],
    services: ["atlas/billing-api", "atlas/billing-web", "atlas/billing-backup"],
    body: `Сервисы \`billing-api\` (4070) и \`billing-web\` (4071) на [[atlas]], домен billing.example.com.

Выкатка — \`./deploy/update.sh\` из каталога проекта; откат — [[deploy-rollback]].
`,
  },
  [{ ago: 9 * D, by: "user:admin" }],
);

const noteRef = (n: Note): NoteRef => ({ id: n.id, kind: n.kind, title: n.title, summary: n.summary });
const noteSummary = (n: Note) => {
  const { body: _b, createdAt: _c, historic: _h, ...rest } = n;
  return rest;
};
const byKind = (a: Note, b: Note) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id);

function notesForServer(id: string): NoteRef[] {
  return [...notes.values()].filter((n) => n.servers.includes(id) || n.services.some((x) => x.startsWith(`${id}/`))).sort(byKind).map(noteRef);
}
function notesForService(s: ServiceDetail): NoteRef[] {
  const key = `${s.serverId}/${s.name}`.toLowerCase();
  const all = [...notes.values()];
  const own = all.filter((n) => n.services.some((x) => x.toLowerCase() === key)).sort(byKind);
  const srv = all.filter((n) => n.kind === "server" && n.servers.includes(s.serverId) && !own.includes(n)).sort(byKind);
  return [...own, ...srv].map(noteRef);
}

function noteErr(e: unknown) {
  if (e instanceof NoteError) return err(e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400, e.code, e.message);
  throw e;
}

function writeNote(id: string, fields: Partial<NoteCreateBody>, prev: Note | null): Note {
  if (!isNoteKind(fields.kind ?? prev?.kind)) throw new NoteError("kind: server|project|runbook|reference");
  const body = checkBody(fields.body ?? prev?.body);
  const lastRev = revisions.get(id)?.[0]?.item.rev ?? 0;
  const n: Note = {
    id,
    kind: (fields.kind ?? prev?.kind)!,
    title: checkTitle(fields.title ?? prev?.title),
    summary: checkSummary(fields.summary ?? prev?.summary),
    tags: checkTags(fields.tags ?? prev?.tags),
    servers: checkServers(fields.servers ?? prev?.servers),
    services: checkServices(fields.services ?? prev?.services),
    body,
    rev: lastRev + 1,
    size: sizeOf(body),
    createdAt: prev?.createdAt ?? NOW(),
    updatedAt: NOW(),
    updatedBy: "user:admin",
  };
  if (prev && (["kind", "title", "summary", "body"] as const).every((k) => n[k] === prev[k]) && (["tags", "servers", "services"] as const).every((k) => n[k].join() === prev[k].join())) return prev;
  notes.set(id, n);
  saveRev(n);
  ev(NOW(), "info", `note.${prev ? "updated" : "created"}`, `Заметка «${n.title}» ${prev ? "изменена" : "создана"}`, { message: `${id}, версия ${n.rev}`, actor: "user:admin" });
  return n;
}

// ---------------- http ----------------
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, code: string, error: string) => json({ error, code }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authed = (req: Request) => (req.headers.get("cookie") ?? "").includes("mock_session=1");

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    await sleep(60 + Math.random() * 120);
    const body = async <T>() => ((await req.json().catch(() => ({}))) as T);

    // ---- auth ----
    if (p === "/api/auth/state") return json({ authenticated: authed(req), configured: true, user: authed(req) ? { username: "admin" } : null, passkeys: passkeys.length });
    if (p === "/api/auth/login" && m === "POST") {
      const b = await body<{ username: string; password: string }>();
      if (b.username === "admin" && b.password === "admin")
        return json({ authenticated: true, configured: true, user: { username: "admin" }, passkeys: passkeys.length }, 200, {
          "set-cookie": "mock_session=1; Path=/; HttpOnly; SameSite=Strict",
        });
      if (b.username === "rate") return err(429, "rate_limited", "Слишком много попыток входа. Повторите через 14 мин.");
      return err(401, "unauthorized", "Неверный логин или пароль");
    }
    if (p === "/api/auth/logout") return json({ ok: true }, 200, { "set-cookie": "mock_session=; Path=/; Max-Age=0" });
    if (p === "/api/auth/passkey/login/options")
      return json({ challengeId: "c1", options: { challenge: "Y2hhbGxlbmdlLW1vY2s", rpId: url.hostname, allowCredentials: [], userVerification: "preferred", timeout: 60000 } });
    if (p === "/api/auth/passkey/login/verify") return err(401, "unauthorized", "Passkey не распознан (мок)");
    if (!authed(req) && p.startsWith("/api/")) return err(401, "unauthorized", "Требуется вход");
    if (p === "/api/auth/passkey/register/options")
      return json({
        challengeId: "c2",
        options: {
          challenge: "Y2hhbGxlbmdlLW1vY2stcmVn",
          rp: { name: "nodeko", id: url.hostname },
          user: { id: "dXNlci0x", name: "admin", displayName: "admin" },
          pubKeyCredParams: [
            { alg: -8, type: "public-key" },
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" },
          ],
          timeout: 60000,
          attestation: "none",
          excludeCredentials: [],
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        },
      });
    if (p === "/api/auth/passkey/register/verify") {
      const b = await body<{ name: string; response: { id: string } }>();
      const pk: PasskeyItem = { id: b.response?.id ?? `cred-${Date.now()}`, name: b.name, createdAt: NOW(), lastUsed: null, deviceType: "multiDevice", backedUp: true };
      passkeys.push(pk);
      return json(pk);
    }

    // ---- overview ----
    if (p === "/api/v1/overview") {
      const all = url.searchParams.get("all") === "1";
      return json({
        servers: servers.map(summary),
        services: services.filter((s) => all || s.tracked).map(svcSummary),
        checks,
        generatedAt: NOW(),
        hubVersion: "1.0.0",
      });
    }

    // ---- servers ----
    let r = /^\/api\/v1\/servers\/([^/]+)(\/metrics|\/enroll)?$/.exec(p);
    if (p === "/api/v1/servers" && m === "POST") {
      const b = await body<{ id: string; name: string; description?: string }>();
      if (servers.some((s) => s.id === b.id)) return err(409, "conflict", "Сервер с таким id уже есть");
      servers.push({ id: b.id, name: b.name, description: b.description ?? null, sort: servers.length, host: null, enrolled: false, connected: false, base: { cpu: 0, mem: 0, disk: 0, net: 0 }, overrides: null });
      return json(enrollment(b.id));
    }
    if (r) {
      const id = decodeURIComponent(r[1]!);
      const s = servers.find((x) => x.id === id);
      if (!s) return err(404, "not_found", "Сервер не найден");
      if (r[2] === "/metrics") {
        const tl = timeline((url.searchParams.get("range") as MetricsRange) ?? "6h");
        const t = tl.t;
        const cpu = series(id + "cpu", t, s.base.cpu, s.base.cpu * 0.5, 100, id === "atlas");
        return json({
          ...tl,
          cpu,
          cpuMax: cpu.map((v) => (v == null ? null : Math.min(100, v * 1.6 + 4))),
          mem: series(id + "mem", t, s.base.mem, 3, 100, id === "atlas"),
          memUsed: series(id + "memu", t, s.base.mem * 80 * MB, 200 * MB),
          swapUsed: series(id + "sw", t, 300 * MB, 50 * MB),
          disk: t.map((_, i) => +(s.base.disk - 2 + (i / t.length) * 2).toFixed(2)),
          diskRead: series(id + "dr", t, 120_000, 90_000),
          diskWrite: series(id + "dw", t, 400_000, 300_000),
          netRx: series(id + "rx", t, s.base.net, s.base.net * 0.6),
          netTx: series(id + "tx", t, s.base.net * 1.6, s.base.net),
          load1: series(id + "ld", t, s.base.cpu / 25, s.base.cpu / 50),
          ping: series(id + "pg", t, 9, 3),
        });
      }
      if (r[2] === "/enroll") {
        s.enrolled = s.enrolled && false;
        return json(enrollment(id));
      }
      if (m === "PATCH") {
        const b = await body<{ name?: string; description?: string | null; sort?: number; overrides?: ServerDetail["overrides"] }>();
        if (b.name !== undefined) s.name = b.name;
        if (b.description !== undefined) s.description = b.description;
        if (b.sort !== undefined) s.sort = b.sort;
        if (b.overrides !== undefined) s.overrides = b.overrides;
        ev(NOW(), "info", "config.server", `Сервер ${s.id}: настройки изменены`, { serverId: s.id, actor: "user" });
        return json(detail(s));
      }
      if (m === "DELETE") {
        servers.splice(servers.indexOf(s), 1);
        for (let i = services.length - 1; i >= 0; i--) if (services[i]!.serverId === id) services.splice(i, 1);
        return json({ ok: true });
      }
      return json(detail(s));
    }

    // ---- services ----
    r = /^\/api\/v1\/services\/(\d+)(\/metrics|\/logs)?$/.exec(p);
    if (r) {
      const s = services.find((x) => x.id === Number(r![1]));
      if (!s) return err(404, "not_found", "Сервис не найден");
      if (r[2] === "/metrics") {
        const tl = timeline((url.searchParams.get("range") as MetricsRange) ?? "6h");
        const base = s.cpu ?? 0;
        const cpu = series(s.name + "c", tl.t, base, base * 0.6 + 0.3);
        const mem = series(s.name + "m", tl.t, s.mem ?? 0, (s.mem ?? 0) * 0.08);
        return json({ ...tl, cpu, cpuMax: cpu.map((v) => (v == null ? null : v * 1.8 + 1)), mem, memMax: mem.map((v) => (v == null ? null : v * 1.05)) });
      }
      if (r[2] === "/logs") {
        const before = Number(url.searchParams.get("before") ?? Infinity);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return json(logs.filter((l) => l.serviceId === s.id && l.id < before).slice(0, limit));
      }
      if (m === "PATCH") {
        const b = await body<Partial<ServiceDetail>>();
        if (b.displayName !== undefined) s.displayName = b.displayName;
        if (b.group !== undefined) s.group = b.group === null ? s.name.split(/[-.]/)[0]! : b.group === "" ? null : b.group;
        if (b.tracked !== undefined) s.tracked = b.tracked;
        if (b.muted !== undefined) s.muted = b.muted;
        if (b.sort !== undefined) s.sort = b.sort;
        if (b.notes !== undefined) s.notes = b.notes;
        ev(NOW(), "info", "config.service", `Сервис ${s.name}: настройки изменены`, { serverId: s.serverId, serviceId: s.id, actor: "user" });
        return json(s);
      }
      if (m === "DELETE") {
        services.splice(services.indexOf(s), 1);
        return json({ ok: true });
      }
      refreshDerived();
      return json({
        ...s,
        recentErrors: logs.filter((l) => l.serviceId === s.id).slice(0, 10),
        recentEvents: events.filter((e) => e.serviceId === s.id).slice(0, 10),
        linkedNotes: notesForService(s),
      });
    }

    // ---- checks ----
    if (p === "/api/v1/checks" && m === "GET") return json(checks);
    if (p === "/api/v1/checks" && m === "POST") {
      const b = await body<CheckBody>();
      const c = addCheck({ ...b, beats: [], last: null, uptime24h: null, uptime30d: null, avgMs24h: null, status: "pending", statusReason: "ещё не проверялась" } as Partial<CheckSummary> & Pick<CheckSummary, "name" | "target">);
      refreshDerived();
      return json(c);
    }
    r = /^\/api\/v1\/checks\/(\d+)(\/results)?$/.exec(p);
    if (r) {
      const c = checks.find((x) => x.id === Number(r![1]));
      if (!c) return err(404, "not_found", "Проверка не найдена");
      if (r[2]) {
        const tl = timeline((url.searchParams.get("range") as MetricsRange) ?? "24h");
        return json({
          ...tl,
          ms: series(c.name + "ms", tl.t, c.avgMs24h ?? 200, 60),
          up: tl.t.map((x) => (c.status === "down" && x * 1000 > NOW() - 10 * MIN ? 0 : hash(c.name + x) > 0.985 ? 0.5 : 1)),
        });
      }
      if (m === "PATCH") {
        Object.assign(c, await body<Partial<CheckBody>>());
        refreshDerived();
        return json(c);
      }
      if (m === "DELETE") {
        checks.splice(checks.indexOf(c), 1);
        refreshDerived();
        return json({ ok: true });
      }
      return json(c);
    }

    // ---- events ----
    if (p === "/api/v1/events") {
      const q = url.searchParams;
      const before = Number(q.get("before") ?? Infinity);
      const limit = Number(q.get("limit") ?? 50);
      return json(
        events
          .filter(
            (e) =>
              e.id < before &&
              (!q.get("level") || e.level === q.get("level")) &&
              (!q.get("server") || e.serverId === q.get("server")) &&
              (!q.get("service") || e.serviceId === Number(q.get("service"))) &&
              (!q.get("check") || e.checkId === Number(q.get("check"))),
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, limit),
      );
    }

    // ---- notes ----
    if (p === "/api/v1/notes" && m === "GET") {
      const q = url.searchParams;
      let list = [...notes.values()];
      const kind = q.get("kind");
      const tag = q.get("tag");
      const server = q.get("server");
      const service = q.get("service")?.toLowerCase();
      if (kind) list = list.filter((n) => n.kind === kind);
      if (tag) list = list.filter((n) => n.tags.includes(tag.toLowerCase()));
      if (server) list = list.filter((n) => n.servers.includes(server) || n.services.some((x) => x.startsWith(`${server}/`)));
      if (service) list = list.filter((n) => n.services.some((x) => x.toLowerCase() === service));
      const text = q.get("q")?.trim();
      if (text) return json(searchNotes(list, text));
      return json(list.sort(byKind).map(noteSummary));
    }
    if (p === "/api/v1/notes" && m === "POST") {
      try {
        const b = await body<NoteCreateBody>();
        const id = checkNoteId(b.id);
        if (notes.has(id)) throw new NoteError(`заметка ${id} уже есть`, "conflict");
        return json(writeNote(id, b, null));
      } catch (e) {
        return noteErr(e);
      }
    }
    r = /^\/api\/v1\/notes\/([^/]+)(?:\/revisions(?:\/(\d+))?)?$/.exec(p);
    if (r) {
      const id = decodeURIComponent(r[1]!);
      const isRev = p.includes("/revisions");
      const cur = notes.get(id) ?? null;
      try {
        if (isRev) {
          const list = revisions.get(id);
          if (!list) throw new NoteError("нет такой заметки", "not_found");
          if (!r[2]) return json(list.map((x) => x.item));
          const v = list.find((x) => x.item.rev === Number(r![2]));
          if (!v) throw new NoteError(`нет версии ${r[2]}`, "not_found");
          if (!v.note) throw new NoteError(`версия ${r[2]} — отметка удаления`, "not_found");
          return json({ ...v.note, historic: true });
        }
        if (!cur) throw new NoteError("нет такой заметки", "not_found");
        if (m === "GET") return json(cur);
        if (m === "PATCH") {
          const b = await body<NotePatchBody>();
          if (b.baseRev != null && b.baseRev !== cur.rev)
            throw new NoteError(`заметку ${id} уже изменили: текущая версия ${cur.rev} (${cur.updatedBy ?? "?"}), а правка сделана от ${b.baseRev}`, "conflict");
          if (b.body !== undefined && b.edits !== undefined) throw new NoteError("body и edits взаимоисключающи");
          const nextBody = b.edits ? applyEdits(cur.body, b.edits) : b.body;
          return json(writeNote(id, { ...b, body: nextBody }, cur));
        }
        if (m === "DELETE") {
          const base = url.searchParams.get("baseRev");
          if (base && Number(base) !== cur.rev) throw new NoteError(`заметку ${id} уже изменили (версия ${cur.rev})`, "conflict");
          notes.delete(id);
          saveRev({ ...cur, rev: cur.rev + 1, updatedAt: NOW(), updatedBy: "user:admin" }, true);
          ev(NOW(), "info", "note.deleted", `Заметка «${cur.title}» удалена`, { message: `${id}, версия ${cur.rev + 1}`, actor: "user:admin" });
          return json({ ok: true });
        }
      } catch (e) {
        return noteErr(e);
      }
    }

    // ---- settings ----
    if (p === "/api/v1/settings" && m === "GET") return json(settings);
    if (p === "/api/v1/settings" && m === "PATCH") {
      const b = await body<Record<string, unknown> & { notify?: { telegram?: Record<string, unknown>; events?: Record<string, boolean> }; thresholds?: object; retention?: object }>();
      const tg = b.notify?.telegram ?? {};
      settings = {
        ...settings,
        ...(b as Partial<Settings>),
        thresholds: { ...settings.thresholds, ...(b.thresholds ?? {}) },
        retention: { ...settings.retention, ...(b.retention ?? {}) },
        notify: {
          telegram: {
            ...settings.notify.telegram,
            ...(tg.enabled !== undefined ? { enabled: tg.enabled as boolean } : {}),
            ...(tg.chatId !== undefined ? { chatId: tg.chatId as string } : {}),
            ...(tg.threadId !== undefined ? { threadId: tg.threadId as string | null } : {}),
            botTokenSet: tg.botToken === null ? false : tg.botToken ? true : settings.notify.telegram.botTokenSet,
          },
          events: { ...settings.notify.events, ...(b.notify?.events ?? {}) },
        },
      };
      return json(settings);
    }
    if (p === "/api/v1/settings/notify/test") return json(settings.notify.telegram.botTokenSet ? { ok: true } : { ok: false, error: "Токен бота не задан" });

    // ---- tokens / sessions / passkeys / account ----
    if (p === "/api/v1/tokens" && m === "GET") return json(tokens);
    if (p === "/api/v1/tokens" && m === "POST") {
      const b = await body<{ name: string; scope: "read" | "admin" }>();
      const id = Math.random().toString(16).slice(2, 10);
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
      const t: TokenItem = { id, name: b.name, scope: b.scope, createdAt: NOW(), lastUsed: null, hint: secret.slice(-4) };
      tokens.push(t);
      return json({ ...t, token: `nk_${id}_${secret}` });
    }
    r = /^\/api\/v1\/tokens\/([^/]+)$/.exec(p);
    if (r && m === "DELETE") {
      tokens = tokens.filter((t) => t.id !== r![1]);
      return json({ ok: true });
    }
    if (p === "/api/v1/sessions") return json(sessions);
    r = /^\/api\/v1\/sessions\/([^/]+)$/.exec(p);
    if (r && m === "DELETE") {
      sessions = sessions.filter((s) => s.id !== r![1]);
      return json({ ok: true });
    }
    if (p === "/api/v1/passkeys") return json(passkeys);
    r = /^\/api\/v1\/passkeys\/([^/]+)$/.exec(p);
    if (r && m === "PATCH") {
      const b = await body<{ name: string }>();
      const pk = passkeys.find((x) => x.id === decodeURIComponent(r![1]!));
      if (pk) pk.name = b.name;
      return json(pk);
    }
    if (r && m === "DELETE") {
      passkeys = passkeys.filter((x) => x.id !== decodeURIComponent(r![1]!));
      return json({ ok: true });
    }
    if (p === "/api/v1/account/password") {
      const b = await body<{ current: string }>();
      return b.current === "admin" ? json({ ok: true }) : err(401, "unauthorized", "Текущий пароль неверен");
    }
    if (p === "/api/v1/docs") return new Response("# nodeko API (mock)\n", { headers: { "content-type": "text/markdown" } });
    return err(404, "not_found", `нет такого эндпоинта: ${m} ${p}`);
  },
});

function enrollment(id: string) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
  return {
    serverId: id,
    token,
    expiresAt: NOW() + H,
    hubUrl: settings.publicUrl,
    hubKey: "Qm9ndXNIdWJLZXlGb3JNb2NrUHVycG9zZXNPbmx5MDA",
    hubKeyFingerprint: "4be1:07d2:9c3e:a1f0",
    installCommand: `curl -fsSL ${settings.publicUrl}/install/agent.sh | sh -s -- --server ${id} --token ${token}`,
  };
}

console.log(`mock hub on http://127.0.0.1:${PORT}`);
