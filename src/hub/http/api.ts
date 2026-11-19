import type { AuthState, CheckBody, EventLevel, ServerCreateBody, ServerPatchBody, ServicePatchBody, SettingsPatch } from "../../shared/api.ts";
import {
  clearSessionCookie,
  createSession,
  createToken,
  deleteSession,
  deleteToken,
  listSessions,
  listTokens,
  loginBlocked,
  loginFailed,
  loginSucceeded,
  sessionCookie,
  setPassword,
  userCount,
  verifyLogin,
} from "../auth/core.ts";
import {
  authenticationOptions,
  authenticationVerify,
  deletePasskey,
  listPasskeys,
  passkeyCount,
  registrationOptions,
  registrationVerify,
  renamePasskey,
} from "../auth/passkeys.ts";
import { createCheck, deleteCheck, getCheckRow, updateCheck } from "../checks.ts";
import { addEvent, listEvents } from "../events.ts";
import { sendTelegram } from "../notify.ts";
import { checkList, checkResults, checkSummary, invalidateOverview, isRange, overview, serverDetail, serverMetrics, serviceDetail, serviceLogs, serviceMetrics } from "../queries.ts";
import { createServer, deleteServer, patchServer, reEnroll } from "../servers.ts";
import { deleteService, patchService } from "../services.ts";
import { patchSettings, publicSettings } from "../settings.ts";
import { apiDocs } from "../docs.ts";
import { bad, HttpError, notFound, Router, type Ctx } from "./router.ts";

export const api = new Router();

const idNum = (c: Ctx, k = "id") => {
  const n = Number(c.params[k]);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${k}: ожидается число`);
  return n;
};
const range = (c: Ctx) => {
  const r = c.url.searchParams.get("range") ?? "1h";
  if (!isRange(r)) throw bad("range: 1h|6h|24h|7d|30d|1y");
  return r;
};
const intQ = (c: Ctx, k: string) => {
  const v = c.url.searchParams.get(k);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${k}: число`);
  return n;
};
const ok = { ok: true };

function authState(c: Ctx): AuthState {
  const user = c.auth?.kind === "session" ? { username: c.auth.user.username } : null;
  return { authenticated: !!c.auth, configured: userCount() > 0, user, passkeys: passkeyCount() };
}

function rateLimit(c: Ctx): void {
  const wait = loginBlocked(c.ip);
  if (wait !== null) {
    throw new HttpError(429, "rate_limited", `слишком много попыток — подождите ${Math.ceil(wait / 60)} мин`, { "retry-after": String(wait) });
  }
}

function startSession(c: Ctx, userId: number, method: string): void {
  const { token } = createSession(userId, method, c.ip, c.req.headers.get("user-agent"));
  c.headers.append("set-cookie", sessionCookie(token));
}

// ---------- auth ----------

api.get("/api/auth/state", "public", (c) => authState(c));

api.post("/api/auth/login", "public", async (c) => {
  rateLimit(c);
  const b = await c.json<{ username?: string; password?: string }>();
  const user = await verifyLogin(String(b.username ?? ""), String(b.password ?? ""));
  if (!user) {
    loginFailed(c.ip);
    throw new HttpError(401, "unauthorized", "неверный логин или пароль");
  }
  loginSucceeded(c.ip);
  startSession(c, user.id, "password");
  return { authenticated: true, configured: true, user: { username: user.username }, passkeys: passkeyCount() } satisfies AuthState;
});

api.post("/api/auth/logout", "public", (c) => {
  if (c.auth?.kind === "session") deleteSession(c.auth.session.id);
  c.headers.append("set-cookie", clearSessionCookie());
  return ok;
});

api.post("/api/auth/passkey/login/options", "public", async (c) => {
  rateLimit(c);
  return authenticationOptions();
});

api.post("/api/auth/passkey/login/verify", "public", async (c) => {
  rateLimit(c);
  const b = await c.json();
  try {
    const user = await authenticationVerify(b.challengeId, b.response);
    loginSucceeded(c.ip);
    startSession(c, user.id, "passkey");
    return { authenticated: true, configured: true, user: { username: user.username }, passkeys: passkeyCount() } satisfies AuthState;
  } catch (e) {
    loginFailed(c.ip);
    throw e;
  }
});

api.post("/api/auth/passkey/register/options", "session", async (c) => {
  if (c.auth?.kind !== "session") throw new HttpError(403, "forbidden", "только из веб-сессии");
  return registrationOptions(c.auth.user);
});

api.post("/api/auth/passkey/register/verify", "session", async (c) => {
  if (c.auth?.kind !== "session") throw new HttpError(403, "forbidden", "только из веб-сессии");
  const b = await c.json();
  const item = await registrationVerify(c.auth.user, b.challengeId, b.response, b.name);
  addEvent({ level: "info", type: "config.security", title: `Добавлен passkey «${item.name}»`, actor: c.actor });
  return item;
});

// ---------- обзор и детали ----------

api.get("/api/v1/overview", "read", (c) => overview(c.url.searchParams.get("all") === "1"));

api.get("/api/v1/servers/:id", "read", (c) => serverDetail(c.params.id!) ?? notFoundThrow("нет такого сервера"));
api.get("/api/v1/servers/:id/metrics", "read", (c) => {
  if (!serverDetail(c.params.id!)) throw notFound("нет такого сервера");
  return serverMetrics(c.params.id!, range(c));
});
api.post("/api/v1/servers", "admin", async (c) => {
  const r = createServer(await c.json<ServerCreateBody>(), c.actor);
  invalidateOverview();
  return r;
});
api.patch("/api/v1/servers/:id", "admin", async (c) => {
  patchServer(c.params.id!, await c.json<ServerPatchBody>(), c.actor);
  invalidateOverview();
  return serverDetail(c.params.id!);
});
api.post("/api/v1/servers/:id/enroll", "admin", (c) => {
  const r = reEnroll(c.params.id!, c.actor);
  invalidateOverview();
  return r;
});
api.del("/api/v1/servers/:id", "admin", (c) => {
  deleteServer(c.params.id!, c.actor);
  invalidateOverview();
  return ok;
});

api.get("/api/v1/services/:id", "read", (c) => serviceDetail(idNum(c)) ?? notFoundThrow("нет такого сервиса"));
api.get("/api/v1/services/:id/metrics", "read", (c) => {
  const id = idNum(c);
  if (!serviceDetail(id)) throw notFound("нет такого сервиса");
  return serviceMetrics(id, range(c));
});
api.get("/api/v1/services/:id/logs", "read", (c) => serviceLogs(idNum(c), intQ(c, "limit") ?? 100, intQ(c, "before"), intQ(c, "since")));
api.patch("/api/v1/services/:id", "admin", async (c) => {
  const id = idNum(c);
  patchService(id, await c.json<ServicePatchBody>(), c.actor);
  invalidateOverview();
  return serviceDetail(id);
});
api.del("/api/v1/services/:id", "admin", (c) => {
  deleteService(idNum(c), c.actor);
  invalidateOverview();
  return ok;
});

// ---------- проверки ----------

api.get("/api/v1/checks", "read", () => checkList());
api.post("/api/v1/checks", "admin", async (c) => {
  const row = createCheck(await c.json<CheckBody>(), c.actor);
  invalidateOverview();
  return checkSummary(row.id);
});
api.get("/api/v1/checks/:id", "read", (c) => checkSummary(idNum(c)) ?? notFoundThrow("нет такой проверки"));
api.patch("/api/v1/checks/:id", "admin", async (c) => {
  const row = updateCheck(idNum(c), await c.json<Partial<CheckBody>>(), c.actor);
  invalidateOverview();
  return checkSummary(row.id);
});
api.del("/api/v1/checks/:id", "admin", (c) => {
  deleteCheck(idNum(c), c.actor);
  invalidateOverview();
  return ok;
});
api.get("/api/v1/checks/:id/results", "read", (c) => {
  const id = idNum(c);
  if (!getCheckRow(id)) throw notFound("нет такой проверки");
  return checkResults(id, range(c));
});

// ---------- события ----------

api.get("/api/v1/events", "read", (c) => {
  const level = c.url.searchParams.get("level") as EventLevel | null;
  if (level && !["info", "ok", "warn", "error"].includes(level)) throw bad("level: info|ok|warn|error");
  return listEvents({
    limit: intQ(c, "limit"),
    before: intQ(c, "before"),
    since: intQ(c, "since"),
    serverId: c.url.searchParams.get("server") ?? undefined,
    serviceId: intQ(c, "service"),
    checkId: intQ(c, "check"),
    level: level ?? undefined,
  });
});

// ---------- настройки ----------

api.get("/api/v1/settings", "read", () => publicSettings());
api.patch("/api/v1/settings", "admin", async (c) => {
  const body = await c.json<SettingsPatch>();
  const s = patchSettings(body);
  const what = Object.keys(body).join(", ");
  addEvent({ level: "info", type: "config.settings", title: "Изменены настройки", message: what, actor: c.actor });
  invalidateOverview();
  return publicSettings(s);
});
api.post("/api/v1/settings/notify/test", "admin", async () => {
  const r = await sendTelegram("🔵 <b>nodeko</b>: тестовое уведомление — всё настроено.");
  return r.ok ? ok : { ok: false, error: r.error };
});

// ---------- токены, сессии, passkeys, пароль ----------

api.get("/api/v1/tokens", "admin", () => listTokens());
api.post("/api/v1/tokens", "session", async (c) => {
  const b = await c.json<{ name?: string; scope?: string }>();
  try {
    const t = createToken(String(b.name ?? ""), b.scope as "read" | "admin");
    addEvent({ level: "info", type: "config.security", title: `Создан API-токен «${t.name}» (${t.scope})`, actor: c.actor });
    return t;
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
});
api.del("/api/v1/tokens/:id", "session", (c) => {
  if (!deleteToken(c.params.id!)) throw notFound("нет такого токена");
  addEvent({ level: "info", type: "config.security", title: "Удалён API-токен", message: c.params.id!, actor: c.actor });
  return ok;
});

api.get("/api/v1/sessions", "session", (c) => listSessions(c.auth?.kind === "session" ? c.auth.session.id : null));
api.del("/api/v1/sessions/:id", "session", (c) => {
  deleteSession(c.params.id!);
  return ok;
});

api.get("/api/v1/passkeys", "session", () => listPasskeys());
api.patch("/api/v1/passkeys/:id", "session", async (c) => renamePasskey(c.params.id!, (await c.json()).name));
api.del("/api/v1/passkeys/:id", "session", (c) => {
  if (!deletePasskey(c.params.id!)) throw notFound("нет такого ключа");
  addEvent({ level: "info", type: "config.security", title: "Удалён passkey", actor: c.actor });
  return ok;
});

api.post("/api/v1/account/password", "session", async (c) => {
  if (c.auth?.kind !== "session") throw new HttpError(403, "forbidden", "только из веб-сессии");
  rateLimit(c);
  const b = await c.json<{ current?: string; next?: string }>();
  const u = await verifyLogin(c.auth.user.username, String(b.current ?? ""));
  if (!u) {
    loginFailed(c.ip);
    throw new HttpError(400, "bad_request", "текущий пароль неверен");
  }
  try {
    await setPassword(u.id, String(b.next ?? ""));
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  addEvent({ level: "info", type: "config.security", title: "Пароль изменён", actor: c.actor });
  return ok;
});

api.get("/api/v1/docs", "public", () => new Response(apiDocs(), { headers: { "content-type": "text/markdown; charset=utf-8" } }));
api.get("/api/health", "public", () => ({ ok: true }));

function notFoundThrow(msg: string): never {
  throw notFound(msg);
}
