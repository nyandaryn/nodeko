import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MetricsRange, SeriesBase, ServerSummary, ServiceSummary } from "../shared/api.ts";
import { verifyToken } from "./auth/core.ts";
import { createCheck, deleteCheck, updateCheck } from "./checks.ts";
import { HUB_VERSION } from "./config.ts";
import { addEvent, listEvents } from "./events.ts";
import { errMsg, log } from "./log.ts";
import {
  checkList,
  checkResults,
  checkSummary,
  invalidateOverview,
  overview,
  serverDetail,
  serverMetrics,
  serviceDetail,
  serviceLogs,
  serviceMetrics,
} from "./queries.ts";
import { createServer, patchServer } from "./servers.ts";
import { patchService } from "./services.ts";
import { patchSettings, publicSettings } from "./settings.ts";

/**
 * MCP (Streamable HTTP, stateless) на `/mcp`. Авторизация — Bearer API-токен nodeko;
 * токен со scope read видит только чтение, admin — ещё и настройку.
 */

const INSTRUCTIONS = `nodeko — мониторинг серверов пользователя и сервисов на них.
Сервер (id — slug) → сервисы (id — число; kind: systemd | systemd-user | docker | pm2; role service|job) → HTTP/TCP-проверки.
Статусы: ok, warn (деградация/пороги/рестарт), down (упал/недоступен), stopped (намеренно остановлен), unknown (нет данных), pending (агент не подключён).
Начинай с nodeko_overview (issuesOnly=true — только проблемы), затем детали: nodeko_server / nodeko_service, логи ошибок — nodeko_logs, история — nodeko_events, графики — nodeko_metrics.
Времена — ms epoch UTC, память/диск — байты, скорости — байт/с, CPU — % (у сервисов — % одного ядра).
Изменения (нужен admin-токен) пишутся в журнал событий от имени токена.`;

const RANGE = z.enum(["1h", "6h", "24h", "7d", "30d", "1y"]);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });

interface Caller {
  name: string;
  admin: boolean;
}

function callerOf(ctx: unknown): Caller {
  const info = (ctx as { http?: { authInfo?: AuthInfo } })?.http?.authInfo;
  const c = info?.extra?.nodeko as Caller | undefined;
  if (!c) throw new Error("нет авторизации");
  return c;
}

function summarize(s: SeriesBase & Record<string, unknown>, fields: string[]) {
  const out: Record<string, { min: number; avg: number; max: number; last: number } | null> = {};
  for (const f of fields) {
    const arr = (s[f] as (number | null)[]).filter((v): v is number => v !== null);
    out[f] = arr.length
      ? {
          min: Math.round(Math.min(...arr) * 100) / 100,
          avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100,
          max: Math.round(Math.max(...arr) * 100) / 100,
          last: arr[arr.length - 1]!,
        }
      : null;
  }
  return out;
}

function downsample(s: SeriesBase & Record<string, unknown>, fields: string[], points: number) {
  const n = s.t.length;
  const k = Math.max(1, Math.ceil(n / points));
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i += k) {
    const row: Record<string, unknown> = { t: s.t[i]! * 1000 };
    for (const f of fields) {
      const vals = (s[f] as (number | null)[]).slice(i, i + k).filter((v): v is number => v !== null);
      row[f] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
    }
    out.push(row);
  }
  return { range: s.range, stepSec: s.step * k, points: out };
}

const SERVER_FIELDS = ["cpu", "cpuMax", "mem", "memUsed", "disk", "diskRead", "diskWrite", "netRx", "netTx", "load1", "ping"];
const SERVICE_FIELDS = ["cpu", "mem"];

function compactServer(s: ServerSummary) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    reason: s.statusReason,
    connected: s.connected,
    lastSeen: s.lastSeen,
    cpu: s.now?.cpu,
    memPct: s.now?.mem,
    diskPct: s.now?.disk,
    load1: s.now?.load[0],
    netRx: s.now?.netRx,
    netTx: s.now?.netTx,
    pingMs: s.now?.ping,
    uptimeSec: s.now?.uptime,
    os: s.host?.os,
    agentVersion: s.host?.agentVersion,
    agentOutdated: s.agentOutdated,
    counts: Object.fromEntries(Object.entries(s.counts).filter(([, n]) => n > 0)),
  };
}

function compactService(s: ServiceSummary) {
  return {
    id: s.id,
    server: s.serverId,
    name: s.displayName ?? s.name,
    unit: s.name,
    kind: s.kind,
    role: s.role,
    group: s.group,
    status: s.status,
    reason: s.statusReason,
    state: s.state,
    since: s.since,
    lastRun: s.lastRun,
    version: s.version,
    commit: s.commit,
    restarts: s.restarts,
    errors1h: s.errors1h,
    cpu: s.cpu,
    mem: s.mem,
    tracked: s.tracked,
    muted: s.muted,
    missing: s.missing,
  };
}

function resolveService(args: { id?: number; server?: string; name?: string }): number {
  if (args.id) return args.id;
  if (args.server && args.name) {
    const n = args.name.toLowerCase().replace(/\.service$/, "");
    const s = overview(true).services.find(
      (x) => x.serverId === args.server && (x.name.toLowerCase() === n || x.displayName?.toLowerCase() === n),
    );
    if (s) return s.id;
    throw new Error(`сервис ${args.name} на ${args.server} не найден`);
  }
  throw new Error("укажите id или server+name");
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "nodeko", title: "nodeko", version: HUB_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );

  const tool = <A,>(name: string, admin: boolean, fn: (args: A, caller: Caller) => unknown) =>
    async (args: A, ctx: unknown): Promise<ToolResult> => {
      const caller = callerOf(ctx);
      if (admin && !caller.admin) return { ...text("нужен API-токен со scope admin"), isError: true };
      try {
        const r = await fn(args, caller);
        if (admin) invalidateOverview();
        return text(r);
      } catch (e) {
        return { ...text(errMsg(e)), isError: true };
      }
    };
  const RO = { readOnlyHint: true, openWorldHint: false } as const;
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "nodeko_overview",
    {
      title: "Обзор",
      description: "Все серверы, сервисы и проверки с текущими статусами и ключевыми метриками.",
      inputSchema: z.object({
        issuesOnly: z.boolean().optional().describe("только проблемы: статус не ok/stopped или есть ошибки в логах за час"),
        server: z.string().optional().describe("только этот сервер"),
        includeHidden: z.boolean().optional().describe("включить скрытые (неотслеживаемые) сервисы"),
      }),
      annotations: RO,
    },
    tool("nodeko_overview", false, (a: { issuesOnly?: boolean; server?: string; includeHidden?: boolean }) => {
      const o = overview(!!a.includeHidden);
      const bad = (st: string) => st !== "ok" && st !== "stopped";
      let servers = o.servers;
      let services = o.services;
      let checks = o.checks;
      if (a.server) {
        servers = servers.filter((s) => s.id === a.server);
        services = services.filter((s) => s.serverId === a.server);
        checks = checks.filter((c) => c.serverId === a.server || c.runner === a.server);
      }
      if (a.issuesOnly) {
        services = services.filter((s) => bad(s.status) || s.errors1h > 0);
        checks = checks.filter((c) => bad(c.status));
      }
      return {
        generatedAt: o.generatedAt,
        servers: servers.map(compactServer),
        services: services.map(compactService),
        checks: checks.map((c) => ({
          id: c.id,
          name: c.name,
          target: c.target,
          runner: c.runner,
          server: c.serverId,
          service: c.serviceId,
          status: c.status,
          reason: c.statusReason,
          uptime24h: c.uptime24h,
          avgMs24h: c.avgMs24h,
          certExpires: c.certExpires,
          enabled: c.enabled,
        })),
      };
    }),
  );

  server.registerTool(
    "nodeko_server",
    {
      title: "Сервер",
      description: "Детали сервера: хост, ФС, пороги, агент, трафик, сводка метрик (min/avg/max/last) за диапазон.",
      inputSchema: z.object({ id: z.string(), range: RANGE.optional().describe("по умолчанию 24h") }),
      annotations: RO,
    },
    tool("nodeko_server", false, (a: { id: string; range?: MetricsRange }) => {
      const d = serverDetail(a.id);
      if (!d) throw new Error("нет такого сервера");
      const m = serverMetrics(a.id, a.range ?? "24h");
      return { ...d, metricsSummary: { range: m.range, ...summarize(m as never, SERVER_FIELDS) } };
    }),
  );

  server.registerTool(
    "nodeko_service",
    {
      title: "Сервис",
      description: "Детали сервиса: состояние, версия/коммит, порты, проверки, последние ошибки и события, сводка CPU/RAM за 24ч. По id или server+name.",
      inputSchema: z.object({ id: z.number().int().optional(), server: z.string().optional(), name: z.string().optional() }),
      annotations: RO,
    },
    tool("nodeko_service", false, (a: { id?: number; server?: string; name?: string }) => {
      const id = resolveService(a);
      const d = serviceDetail(id);
      if (!d) throw new Error("нет такого сервиса");
      const m = serviceMetrics(id, "24h");
      return { ...d, recentErrors: d.recentErrors.slice(0, 15), metricsSummary24h: summarize(m as never, SERVICE_FIELDS) };
    }),
  );

  server.registerTool(
    "nodeko_metrics",
    {
      title: "Метрики",
      description: "Временной ряд метрик сервера, сервиса или проверки за диапазон, ужатый до points точек.",
      inputSchema: z.object({
        server: z.string().optional(),
        service: z.number().int().optional(),
        check: z.number().int().optional(),
        range: RANGE,
        points: z.number().int().min(5).max(400).optional().describe("по умолчанию 60"),
      }),
      annotations: RO,
    },
    tool("nodeko_metrics", false, (a: { server?: string; service?: number; check?: number; range: MetricsRange; points?: number }) => {
      const pts = a.points ?? 60;
      if (a.service) return downsample(serviceMetrics(a.service, a.range) as never, SERVICE_FIELDS, pts);
      if (a.check) return downsample(checkResults(a.check, a.range) as never, ["ms", "up"], pts);
      if (a.server) {
        if (!serverDetail(a.server)) throw new Error("нет такого сервера");
        return downsample(serverMetrics(a.server, a.range) as never, SERVER_FIELDS, pts);
      }
      throw new Error("укажите server, service или check");
    }),
  );

  server.registerTool(
    "nodeko_events",
    {
      title: "События",
      description: "Журнал: падения/восстановления, рестарты, пороги, offline, изменения настроек. Новые первыми.",
      inputSchema: z.object({
        sinceMinutes: z.number().int().min(1).optional(),
        level: z.enum(["info", "ok", "warn", "error"]).optional(),
        server: z.string().optional(),
        service: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: RO,
    },
    tool("nodeko_events", false, (a: { sinceMinutes?: number; level?: "info" | "ok" | "warn" | "error"; server?: string; service?: number; limit?: number }) =>
      listEvents({
        since: a.sinceMinutes ? Date.now() - a.sinceMinutes * 60_000 : undefined,
        level: a.level,
        serverId: a.server,
        serviceId: a.service,
        limit: a.limit ?? 50,
      }),
    ),
  );

  server.registerTool(
    "nodeko_logs",
    {
      title: "Ошибки в логах",
      description: "Строки-ошибки сервиса из journal (priority<=err или по шаблону ошибок), новые первыми.",
      inputSchema: z.object({
        service: z.number().int().optional(),
        server: z.string().optional(),
        name: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        sinceMinutes: z.number().int().min(1).optional(),
      }),
      annotations: RO,
    },
    tool("nodeko_logs", false, (a: { service?: number; server?: string; name?: string; limit?: number; sinceMinutes?: number }) =>
      serviceLogs(resolveService({ id: a.service, server: a.server, name: a.name }), a.limit ?? 50, undefined, a.sinceMinutes ? Date.now() - a.sinceMinutes * 60_000 : undefined),
    ),
  );

  server.registerTool(
    "nodeko_settings",
    { title: "Настройки", description: "Текущие настройки nodeko (токен бота не раскрывается).", inputSchema: z.object({}), annotations: RO },
    tool("nodeko_settings", false, () => publicSettings()),
  );

  // ---------- изменения ----------

  const ServicePatch = z.object({
    id: z.number().int(),
    displayName: z.string().nullable().optional(),
    group: z.string().nullable().optional().describe('null — автогруппа, "" — без группы, иначе имя группы'),
    tracked: z.boolean().optional().describe("false — скрыть из дерева"),
    muted: z.boolean().optional().describe("true — без уведомлений"),
    sort: z.number().int().optional(),
    notes: z.string().nullable().optional(),
  });

  server.registerTool(
    "nodeko_update_services",
    {
      title: "Изменить сервисы",
      description: "Пакетно поменять отображаемое имя, группу в дереве, отслеживание, уведомления, порядок, заметки.",
      inputSchema: z.object({ updates: z.array(ServicePatch).min(1).max(200) }),
      annotations: RW,
    },
    tool("nodeko_update_services", true, (a: { updates: z.infer<typeof ServicePatch>[] }, c) => {
      const res: { id: number; ok: boolean; error?: string }[] = [];
      for (const { id, ...patch } of a.updates) {
        try {
          patchService(id, patch, `token:${c.name}`);
          res.push({ id, ok: true });
        } catch (e) {
          res.push({ id, ok: false, error: errMsg(e) });
        }
      }
      return res;
    }),
  );

  const Thr = z.object({
    cpu: z.object({ pct: z.number(), minutes: z.number() }).optional(),
    mem: z.object({ pct: z.number(), minutes: z.number() }).optional(),
    disk: z.object({ pct: z.number() }).optional(),
    offlineSeconds: z.number().optional(),
  });

  server.registerTool(
    "nodeko_update_server",
    {
      title: "Изменить сервер",
      description: "Имя, описание, порядок, переопределения порогов (null — сбросить).",
      inputSchema: z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
        sort: z.number().int().optional(),
        overrides: Thr.nullable().optional(),
      }),
      annotations: RW,
    },
    tool("nodeko_update_server", true, (a: { id: string; name?: string; description?: string | null; sort?: number; overrides?: z.infer<typeof Thr> | null }, c) => {
      const { id, ...patch } = a;
      patchServer(id, patch, `token:${c.name}`);
      return serverDetail(id);
    }),
  );

  server.registerTool(
    "nodeko_add_server",
    {
      title: "Добавить сервер",
      description: "Создать сервер и одноразовый токен регистрации агента (24 ч). Возвращает команду установки агента.",
      inputSchema: z.object({ id: z.string().describe("slug [a-z0-9-]"), name: z.string(), description: z.string().optional() }),
      annotations: RW,
    },
    tool("nodeko_add_server", true, (a: { id: string; name: string; description?: string }, c) => createServer(a, `token:${c.name}`)),
  );

  const CheckFields = {
    name: z.string().optional(),
    type: z.enum(["http", "tcp"]).optional(),
    target: z.string().optional().describe("URL для http, host:port для tcp"),
    runner: z.string().optional().describe('"hub" (снаружи, по умолчанию) или id сервера, чей агент проверяет изнутри'),
    serverId: z.string().nullable().optional().describe("под каким сервером показывать"),
    serviceId: z.number().int().nullable().optional().describe("к какому сервису привязать (влияет на его статус)"),
    interval: z.number().int().optional().describe("секунды, по умолчанию 60"),
    timeout: z.number().int().optional().describe("мс, по умолчанию 10000"),
    expect: z.string().nullable().optional().describe('коды ответа, напр. "200-399" или "200,204"'),
    keyword: z.string().nullable().optional(),
    method: z.enum(["GET", "HEAD"]).optional(),
    insecure: z.boolean().optional(),
    retries: z.number().int().optional().describe("неудач подряд до down, по умолчанию 2"),
    enabled: z.boolean().optional(),
  };

  server.registerTool(
    "nodeko_upsert_check",
    {
      title: "Создать/изменить проверку",
      description: "HTTP/TCP-проверка (аналог монитора Uptime Kuma). Без id — создать (нужны type и target), с id — изменить.",
      inputSchema: z.object({ id: z.number().int().optional(), ...CheckFields }),
      annotations: RW,
    },
    tool("nodeko_upsert_check", true, (a: { id?: number } & Record<string, unknown>, c) => {
      const { id, ...body } = a;
      const row = id ? updateCheck(id, body, `token:${c.name}`) : createCheck(body as never, `token:${c.name}`);
      return checkSummary(row.id);
    }),
  );

  server.registerTool(
    "nodeko_delete_check",
    { title: "Удалить проверку", description: "Удалить проверку и её историю.", inputSchema: z.object({ id: z.number().int() }), annotations: { ...RW, destructiveHint: true } },
    tool("nodeko_delete_check", true, (a: { id: number }, c) => {
      deleteCheck(a.id, `token:${c.name}`);
      return { ok: true };
    }),
  );

  server.registerTool(
    "nodeko_update_settings",
    {
      title: "Изменить настройки",
      description:
        "Частичное обновление настроек: agentInterval, thresholds, serviceDownDelay, notify.events, notify.telegram (enabled, chatId, threadId; botToken — только записать), logPattern, pingTarget, retention, certWarnDays, publicUrl.",
      inputSchema: z.object({ patch: z.record(z.string(), z.unknown()) }),
      annotations: RW,
    },
    tool("nodeko_update_settings", true, (a: { patch: Record<string, unknown> }, c) => {
      const s = patchSettings(a.patch as never);
      addEvent({ level: "info", type: "config.settings", title: "Изменены настройки", message: Object.keys(a.patch).join(", "), actor: `token:${c.name}` });
      return publicSettings(s);
    }),
  );

  void checkList;
  return server;
}

const handler = createMcpHandler(() => buildMcpServer(), {
  responseMode: "auto",
  maxRequestBodySize: 512 * 1024,
  onerror: (e) => log.warn("mcp", { error: e.message }),
});

export async function mcpFetch(req: Request, ip: string): Promise<Response> {
  const authz = req.headers.get("authorization");
  const tok = authz?.startsWith("Bearer ") ? verifyToken(authz.slice(7).trim()) : null;
  if (!tok) {
    return new Response(JSON.stringify({ error: "нужен Bearer API-токен nodeko", code: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="nodeko"' },
    });
  }
  const caller: Caller = { name: tok.name, admin: tok.scope === "admin" };
  const authInfo: AuthInfo = { token: tok.id, clientId: tok.id, scopes: [tok.scope], extra: { nodeko: caller } };
  void ip;
  return handler.fetch(req, { authInfo });
}
