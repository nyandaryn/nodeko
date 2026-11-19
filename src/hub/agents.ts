import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  AGENT_VERSION,
  LIMITS,
  type AgentMsg,
  type AuthMsg,
  type ConfigMsg,
  type HubMsg,
  type SnapMsg,
} from "../shared/protocol.ts";
import { hubHandshake, safeEqual, sha256 } from "../shared/secure.ts";
import { agentChecks, onChecksChanged } from "./checks.ts";
import { db } from "./db.ts";
import { addEvent } from "./events.ts";
import { hubIdentity } from "./identity.ts";
import { ingestHello, ingestSnapshot } from "./ingest.ts";
import { errMsg, log } from "./log.ts";
import { live, type AgentWsData, type ServerRow } from "./model.ts";
import { onDisconnectRequest } from "./servers.ts";
import { effectiveLogPattern, getSettings, onSettingsChange } from "./settings.ts";

/**
 * WebSocket `/agent`: рукопожатие (shared/secure.ts) → авторизация по закреплённому ключу агента
 * или одноразовому токену регистрации → поток снимков. Агент ничего не исполняет по команде хаба.
 */

type WS = ServerWebSocket<AgentWsData>;

// неудачные рукопожатия по IP: защита от перебора токенов
const failures = new Map<string, number[]>();
const FAIL_WINDOW = 10 * 60_000;
const FAIL_MAX = 20;

export function handshakeBlocked(ip: string): boolean {
  const now = Date.now();
  const list = (failures.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list.length >= FAIL_MAX;
}

function fail(ws: WS, reason: string, publicReason = "unauthorized"): void {
  const list = failures.get(ws.data.ip) ?? [];
  list.push(Date.now());
  failures.set(ws.data.ip, list);
  log.warn("агент: отказ", { ip: ws.data.ip, server: ws.data.serverId, reason });
  try {
    if (ws.data.channel) ws.send(ws.data.channel.seal({ t: "bye", reason: publicReason } satisfies HubMsg));
  } catch {}
  ws.data.phase = "closed";
  ws.close(4001, publicReason);
}

function send(ws: WS, msg: HubMsg): void {
  if (ws.data.phase !== "ready" || !ws.data.channel) return;
  ws.send(ws.data.channel.seal(msg));
}

function configFor(serverId: string): ConfigMsg {
  const s = getSettings();
  return {
    t: "config",
    interval: s.agentInterval,
    checks: agentChecks(serverId),
    logPattern: effectiveLogPattern(s),
    pingTarget: s.pingTarget,
  };
}

export function pushConfig(serverId: string): void {
  const l = live.get(serverId);
  if (l) send(l.ws, configFor(serverId));
}

onChecksChanged((runner) => pushConfig(runner));
onSettingsChange(() => {
  for (const id of live.keys()) pushConfig(id);
});
onDisconnectRequest((id, reason) => {
  const l = live.get(id);
  if (!l) return;
  try {
    send(l.ws, { t: "bye", reason });
  } catch {}
  l.ws.close(4002, reason);
  live.delete(id);
});

function handleAuth(ws: WS, frame: Uint8Array): void {
  const hs = ws.data.hs!;
  let msg: AuthMsg;
  try {
    msg = hs.channel.open(frame, LIMITS.maxFrame) as AuthMsg;
  } catch (e) {
    return fail(ws, `auth: ${errMsg(e)}`);
  }
  ws.data.channel = hs.channel;
  if (msg?.t !== "auth" || typeof msg.server !== "string" || typeof msg.sig !== "string") return fail(ws, "auth: формат");
  if (!hs.verifyAgent(msg.sig)) return fail(ws, "auth: подпись агента");
  const server = db.query("SELECT * FROM servers WHERE id = ?").get(msg.server) as ServerRow | null;
  if (!server) return fail(ws, `auth: нет сервера ${msg.server}`);
  ws.data.serverId = server.id;

  let enrolled = false;
  if (server.agent_key && safeEqual(server.agent_key, hs.agentKey)) {
    // известный агент
  } else if (
    typeof msg.enroll === "string" &&
    server.enroll_hash &&
    (server.enroll_expires ?? 0) > Date.now() &&
    safeEqual(server.enroll_hash, sha256(msg.enroll))
  ) {
    db.query("UPDATE servers SET agent_key = ?, enroll_hash = NULL, enroll_expires = NULL WHERE id = ?").run(hs.agentKey, server.id);
    enrolled = true;
    addEvent({ level: "info", type: "agent.enrolled", serverId: server.id, title: `${server.name}: агент зарегистрирован`, message: `с адреса ${ws.data.ip}`, actor: "system" });
  } else {
    return fail(ws, server.agent_key ? "auth: чужой ключ агента" : "auth: неверный или просроченный токен регистрации");
  }

  // одно подключение на сервер: старое закрываем
  const prev = live.get(server.id);
  if (prev && prev.ws !== ws) {
    try {
      prev.ws.close(4003, "replaced");
    } catch {}
  }
  clearTimeout(ws.data.timer);
  ws.data.phase = "ready";
  ws.data.connectedAt = Date.now();
  ws.data.hs = undefined;
  live.set(server.id, { ws, ip: ws.data.ip, connectedAt: Date.now(), rtt: null });
  ws.send(hs.channel.seal({ t: "ok", server: server.id, enrolled }));
  send(ws, configFor(server.id));
  log.info("агент подключён", { server: server.id, ip: ws.data.ip, enrolled, version: msg.agentVersion });
}

function handleReady(ws: WS, frame: Uint8Array): void {
  let msg: AgentMsg;
  try {
    msg = ws.data.channel!.open(frame, LIMITS.maxFrame) as AgentMsg;
  } catch (e) {
    log.warn("агент: битый кадр, разрыв", { server: ws.data.serverId, error: errMsg(e) });
    ws.close(4004, "bad frame");
    return;
  }
  const id = ws.data.serverId!;
  switch (msg?.t) {
    case "hello":
      ingestHello(id, msg.info);
      break;
    case "snap": {
      const now = Date.now();
      if (ws.data.lastSnapAt && now - ws.data.lastSnapAt < 2000) return; // защита БД от слишком частых снимков
      ws.data.lastSnapAt = now;
      try {
        ingestSnapshot(id, msg as SnapMsg);
      } catch (e) {
        log.error("ingest", { server: id, error: errMsg(e) });
      }
      break;
    }
    case "pong": {
      if (msg.id === ws.data.pingId && ws.data.pingSentAt) {
        const l = live.get(id);
        if (l && l.ws === ws) l.rtt = Date.now() - ws.data.pingSentAt;
      }
      break;
    }
  }
}

export const agentWebsocket: WebSocketHandler<AgentWsData> = {
  maxPayloadLength: LIMITS.maxFrame,
  idleTimeout: 120,
  sendPings: true,
  open(ws) {
    ws.data.timer = setTimeout(() => {
      if (ws.data.phase !== "ready") fail(ws, "таймаут рукопожатия", "timeout");
    }, LIMITS.handshakeTimeout);
  },
  message(ws, raw) {
    try {
      if (ws.data.phase === "hs1") {
        if (typeof raw !== "string") return fail(ws, "hs1: ожидался текст");
        const hs1 = JSON.parse(raw);
        if (hs1?.t !== "hs1") return fail(ws, "hs1: формат");
        const hs = hubHandshake(hubIdentity, hs1);
        ws.data.hs = hs;
        ws.data.phase = "auth";
        ws.send(JSON.stringify(hs.hs2));
        return;
      }
      if (typeof raw === "string") return fail(ws, "ожидался бинарный кадр");
      if (ws.data.phase === "auth") return handleAuth(ws, raw);
      if (ws.data.phase === "ready") return handleReady(ws, raw);
    } catch (e) {
      fail(ws, `ошибка: ${errMsg(e)}`, "error");
    }
  },
  close(ws) {
    clearTimeout(ws.data.timer);
    const id = ws.data.serverId;
    if (id && live.get(id)?.ws === ws) {
      live.delete(id);
      log.info("агент отключился", { server: id });
    }
    ws.data.phase = "closed";
  },
};

/** Пинг каждые 30 с — замер RTT и проверка канала. */
export function startAgentPings(): void {
  setInterval(() => {
    for (const l of live.values()) {
      l.ws.data.pingId++;
      l.ws.data.pingSentAt = Date.now();
      send(l.ws, { t: "ping", id: l.ws.data.pingId });
    }
  }, 30_000);
}

export function upgradeAgent(req: Request, server: Server<AgentWsData>, ip: string): Response | undefined {
  if (handshakeBlocked(ip)) return new Response("too many failed handshakes", { status: 429 });
  const ok = server.upgrade(req, { data: { ip, phase: "hs1", pingId: 0 } });
  return ok ? undefined : new Response("websocket upgrade expected", { status: 426 });
}

export const agentVersionLatest = AGENT_VERSION;
