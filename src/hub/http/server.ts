import type { Server } from "bun";
import fs from "node:fs";
import path from "node:path";
import { readCookie, SESSION_COOKIE, sessionByToken, getUser, verifyToken } from "../auth/core.ts";
import { PasskeyError } from "../auth/passkeys.ts";
import { CheckError } from "../checks.ts";
import { agentWebsocket, upgradeAgent } from "../agents.ts";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { mcpFetch } from "../mcp.ts";
import { NoteError } from "../notes.ts";
import type { AgentWsData } from "../model.ts";
import { ServerError } from "../servers.ts";
import { ServiceError } from "../services.ts";
import { getSettings, ValidationError } from "../settings.ts";
import { api } from "./api.ts";
import { installRoute } from "./install.ts";
import { HttpError, type Auth, type Ctx } from "./router.ts";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

function withHeaders(res: Response, extra?: Headers): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  if (config.production) res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (extra) for (const [k, v] of extra) res.headers.append(k, v);
  return res;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const r = json({ error: e.message, code: e.code }, e.status);
    if (e.extraHeaders) for (const [k, v] of Object.entries(e.extraHeaders)) r.headers.set(k, v);
    return r;
  }
  if (e instanceof CheckError || e instanceof ServiceError || e instanceof ServerError || e instanceof ValidationError || e instanceof PasskeyError) {
    return json({ error: e.message, code: "bad_request" }, 400);
  }
  if (e instanceof NoteError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400);
  if (e instanceof SyntaxError) return json({ error: "тело запроса — не JSON", code: "bad_request" }, 400);
  log.error("http: необработанная ошибка", { error: errMsg(e) });
  return json({ error: "внутренняя ошибка", code: "internal" }, 500);
}

export function clientIp(req: Request, server: Server<AgentWsData>): string {
  // хаб слушает только loopback; внешний трафик приходит через cloudflared, который ставит CF-Connecting-IP
  const peer = server.requestIP(req)?.address ?? "unknown";
  const cf = req.headers.get("cf-connecting-ip");
  const isLoopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  return cf && isLoopback ? cf.slice(0, 64) : peer;
}

function authenticate(req: Request): Auth {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const t = verifyToken(authz.slice(7).trim());
    return t ? { kind: "token", token: t } : null;
  }
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const s = sessionByToken(sid);
  if (!s) return null;
  const user = getUser(s.user_id);
  return user ? { kind: "session", session: s, user } : null;
}

function allowedOrigins(): string[] {
  const list = [new URL(getSettings().publicUrl).origin];
  if (!config.production) list.push(...config.devOrigins, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`);
  return list;
}

async function handleApi(req: Request, url: URL, ip: string): Promise<Response> {
  const headers = new Headers();
  try {
    const m = api.match(req.method, url.pathname);
    if (m === null) throw new HttpError(404, "not_found", "нет такого эндпоинта");
    if (m === "method") throw new HttpError(405, "method_not_allowed", "метод не поддерживается");
    const auth = authenticate(req);
    const { route, params } = m;
    const mutating = req.method !== "GET" && req.method !== "HEAD";

    if (route.access !== "public") {
      if (!auth) throw new HttpError(401, "unauthorized", "нужен вход");
      if (route.access === "session" && auth.kind !== "session") throw new HttpError(403, "forbidden", "доступно только из веб-сессии");
      if (route.access === "admin" && auth.kind === "token" && auth.token.scope !== "admin") {
        throw new HttpError(403, "forbidden", "токену нужен scope admin");
      }
      if (route.access === "read" && mutating && auth.kind === "token" && auth.token.scope !== "admin") {
        throw new HttpError(403, "forbidden", "токену нужен scope admin");
      }
    }
    // CSRF: мутирующие запросы с cookie — только с нашего Origin и только JSON
    if (mutating && auth?.kind !== "token") {
      const origin = req.headers.get("origin");
      if (!origin || !allowedOrigins().includes(origin)) throw new HttpError(403, "forbidden", "запрос с чужого origin");
    }
    if (mutating && req.headers.get("content-length") !== "0" && req.body) {
      const ct = req.headers.get("content-type") ?? "";
      if (!ct.startsWith("application/json")) throw new HttpError(415, "bad_request", "нужен Content-Type: application/json");
    }

    const ctx: Ctx = {
      req,
      url,
      params,
      ip,
      auth,
      actor: auth?.kind === "token" ? `token:${auth.token.name}` : auth?.kind === "session" ? `user:${auth.user.username}` : "anonymous",
      headers,
      async json() {
        const text = await req.text();
        if (!text) return {} as any;
        const v = JSON.parse(text);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "bad_request", "ожидается JSON-объект");
        return v;
      },
    };
    const out = await route.handler(ctx);
    const res = out instanceof Response ? out : json(out ?? { ok: true });
    return withHeaders(res, headers);
  } catch (e) {
    return withHeaders(errorResponse(e), headers);
  }
}

// ---------- статика SPA ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(url: URL): Response {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(config.webDist, rel || "index.html");
  const inside = file === config.webDist || file.startsWith(config.webDist + path.sep);
  if (inside && rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    const immutable = rel.startsWith("assets/");
    const headers: Record<string, string> = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (ext === ".html") headers["content-security-policy"] = CSP;
    return new Response(Bun.file(file), { headers });
  }
  // SPA-фолбэк
  if (path.extname(rel) && !rel.endsWith(".html")) return new Response("not found", { status: 404 });
  const index = path.join(config.webDist, "index.html");
  if (!fs.existsSync(index)) return new Response("web UI не собран: bun run build:web", { status: 503 });
  return new Response(Bun.file(index), {
    headers: { "content-type": MIME[".html"]!, "cache-control": "no-cache", "content-security-policy": CSP },
  });
}

export function startHttp(): Server<AgentWsData> {
  const server = Bun.serve<AgentWsData>({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 1024 * 1024,
    development: false,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ip = clientIp(req, srv);
      try {
        if (url.pathname === "/agent") return upgradeAgent(req, srv, ip);
        if (url.pathname === "/mcp") return withHeaders(await mcpFetch(req, ip));
        if (url.pathname.startsWith("/api/")) return handleApi(req, url, ip);
        if (url.pathname.startsWith("/install/")) return withHeaders(await installRoute(url));
        if (req.method !== "GET" && req.method !== "HEAD") return withHeaders(new Response("method not allowed", { status: 405 }));
        return withHeaders(serveStatic(url));
      } catch (e) {
        return withHeaders(errorResponse(e));
      }
    },
    websocket: agentWebsocket,
    error(e) {
      log.error("http", { error: errMsg(e) });
      return new Response("internal error", { status: 500 });
    },
  });
  log.info(`nodeko hub слушает http://${config.host}:${config.port}`);
  return server;
}
