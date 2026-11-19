#!/usr/bin/env bun
/**
 * nodeko-agent — сборщик метрик и состояний сервисов. Подключается к хабу сам (исходящее соединение),
 * на сервере не открывает портов. Только наблюдает: команд от хаба не исполняет.
 *
 *   nodeko-agent [--config <path>]   работать (по умолчанию ~/.config/nodeko-agent/agent.json)
 *   nodeko-agent --once [--config]   снять один снимок и напечатать JSON (без подключения)
 *   nodeko-agent --version
 */
import {
  AGENT_VERSION,
  LIMITS,
  PROTOCOL_VERSION,
  type AuthOk,
  type ByeMsg,
  type HubMsg,
  type SnapMsg,
} from "../shared/protocol.ts";
import { agentHandshake, b64u, fingerprint, rawPublic, type Identity, type SecureChannel } from "../shared/secure.ts";
import { Collector } from "./collector.ts";
import { defaultConfigPath, defaultKeyFile, dropEnrollToken, loadConfig, loadOrCreateKey, type AgentConfig } from "./config.ts";
import { log, sleep } from "./util.ts";

const SILENCE_LIMIT = 90_000;
const AUTH_RETRY = 5 * 60_000;

function parseArgs(argv: string[]) {
  const out: { config?: string; once: boolean; version: boolean; help: boolean } = { once: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "-c") out.config = argv[++i];
    else if (a.startsWith("--config=")) out.config = a.slice(9);
    else if (a === "--once") out.once = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`неизвестный аргумент: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function once(cfgPath: string): Promise<void> {
  let cfg: Partial<AgentConfig> = {};
  try {
    cfg = loadConfig(cfgPath);
  } catch {
    /* для отладки конфиг не обязателен */
  }
  const c = new Collector({ docker: cfg.docker, pm2: cfg.pm2, users: cfg.users });
  await c.prime(false);
  await sleep(1500);
  const snap = await c.snapshot();
  console.log(JSON.stringify({ hello: c.hostInfo(), snap }, null, 2));
  c.stop();
}

type Phase = "hs1" | "auth" | "ready";

class Connection {
  private ws: WebSocket | null = null;
  private channel: SecureChannel | null = null;
  private phase: Phase = "hs1";
  private lastRx = 0;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hsTimer: ReturnType<typeof setTimeout> | null = null;
  private interval = 10;
  private sending = false;
  /** причина закрытия, заданная хабом */
  byeReason: string | null = null;
  authenticated = false;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly cfgPath: string,
    private readonly identity: Identity,
    private readonly collector: Collector,
  ) {}

  /** Подключиться и работать до разрыва. */
  run(): Promise<void> {
    return new Promise((resolve) => {
      const hs = agentHandshake(this.identity, Buffer.from(this.cfg.hubKey, "base64url"));
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.cfg.hub, { headers: { "user-agent": `nodeko-agent/${AGENT_VERSION}` } } as unknown as string[]);
      } catch (e) {
        log.warn(`не удалось открыть соединение: ${e instanceof Error ? e.message : String(e)}`);
        resolve();
        return;
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        this.cleanup();
        resolve();
      };
      this.hsTimer = setTimeout(() => {
        if (this.phase !== "ready") {
          log.warn("хаб не завершил рукопожатие вовремя");
          ws.close(4000, "handshake timeout");
          done();
        }
      }, LIMITS.handshakeTimeout);

      ws.onopen = () => {
        this.lastRx = Date.now();
        ws.send(JSON.stringify(hs.hs1));
      };
      ws.onerror = () => {
        /* подробности придут в onclose */
      };
      ws.onclose = (ev) => {
        if (this.phase === "ready" || this.byeReason) log.info(`соединение закрыто (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
        else log.warn(`соединение не установлено (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
        done();
      };
      ws.onmessage = (ev) => {
        this.lastRx = Date.now();
        try {
          this.onMessage(ev.data, hs);
        } catch (e) {
          log.warn(`протокол: ${e instanceof Error ? e.message : String(e)}`);
          ws.close(4002, "protocol error");
          done();
        }
      };
    });
  }

  private onMessage(data: unknown, hs: ReturnType<typeof agentHandshake>): void {
    const ws = this.ws!;
    if (typeof data === "string") {
      if (data.length > 64 * 1024) throw new Error("слишком большой текстовый кадр");
      const msg = JSON.parse(data) as { t?: string; reason?: string };
      if (msg.t === "bye") {
        this.byeReason = String(msg.reason ?? "без причины");
        log.warn(`хаб отказал: ${this.byeReason}`);
        ws.close(1000);
        return;
      }
      if (this.phase !== "hs1" || msg.t !== "hs2") throw new Error(`неожиданное текстовое сообщение ${msg.t}`);
      const { channel, authFrame } = hs.finish(msg as { eph: string; nonce: string; sig: string }, {
        server: this.cfg.server,
        ...(this.cfg.enroll ? { enroll: this.cfg.enroll } : {}),
        agentVersion: AGENT_VERSION,
      });
      this.channel = channel;
      this.phase = "auth";
      ws.send(authFrame);
      return;
    }
    if (!(data instanceof ArrayBuffer)) throw new Error("неизвестный тип кадра");
    if (!this.channel) throw new Error("бинарный кадр до рукопожатия");
    if (data.byteLength > LIMITS.maxFrame) throw new Error("кадр больше лимита");
    const msg = this.channel.open(new Uint8Array(data), LIMITS.maxFrame) as HubMsg | AuthOk;
    if (this.phase === "auth") {
      if (msg.t === "bye") {
        this.byeReason = (msg as ByeMsg).reason;
        log.warn(`хаб отказал в авторизации: ${this.byeReason}`);
        ws.close(1000);
        return;
      }
      if (msg.t !== "ok") throw new Error(`ожидался ok, пришло ${msg.t}`);
      this.phase = "ready";
      this.authenticated = true;
      if (this.hsTimer) clearTimeout(this.hsTimer);
      const ok = msg as AuthOk;
      log.info(`подключён к хабу как «${ok.server}»${ok.enrolled ? " (агент зарегистрирован)" : ""}`);
      if (ok.enrolled && this.cfg.enroll) {
        try {
          dropEnrollToken(this.cfgPath);
          delete this.cfg.enroll;
        } catch (e) {
          log.warn(`не удалось убрать токен регистрации из конфига: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.send({ t: "hello", info: this.collector.hostInfo() });
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastRx > SILENCE_LIMIT) {
          log.warn("хаб молчит дольше 90 с — переподключение");
          ws.close(4001, "silence");
        }
      }, 10_000);
      this.scheduleSnap(1000);
      return;
    }
    switch (msg.t) {
      case "config": {
        const iv = Math.min(Math.max(Math.round(msg.interval) || 10, 2), 3600);
        const changed = iv !== this.interval;
        this.interval = iv;
        this.collector.checks.setChecks(Array.isArray(msg.checks) ? msg.checks : []);
        this.collector.journal.setPattern(typeof msg.logPattern === "string" ? msg.logPattern : "");
        if (typeof msg.pingTarget === "string" && /^[\w.:[\]-]+:\d{1,5}$/.test(msg.pingTarget)) this.collector.pingTarget = msg.pingTarget;
        if (changed) this.scheduleSnap(this.interval * 1000);
        break;
      }
      case "ping":
        this.send({ t: "pong", id: msg.id });
        break;
      case "bye":
        this.byeReason = msg.reason;
        log.info(`хаб закрывает соединение: ${msg.reason}`);
        ws.close(1000);
        break;
      default:
        break; // неизвестные сообщения игнорируем — совместимость с новыми хабами
    }
  }

  private send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.channel) return false;
    const frame = this.channel.seal(obj);
    if (frame.byteLength > LIMITS.maxFrame) throw new Error("кадр больше лимита");
    this.ws.send(frame);
    return true;
  }

  private scheduleSnap(delay: number): void {
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => void this.snap(), delay);
  }

  private async snap(): Promise<void> {
    if (this.phase !== "ready") return;
    const started = Date.now();
    if (!this.sending) {
      this.sending = true;
      let snap: SnapMsg | null = null;
      try {
        snap = await this.collector.snapshot();
        if (!this.trySend(snap)) {
          // не ушло — вернуть проверки и ошибки в очередь
          this.collector.checks.requeue(snap.chk);
          this.collector.journal.requeue(snap.logs);
        }
      } catch (e) {
        log.warn(`снимок: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.sending = false;
      }
    }
    if (this.phase === "ready") this.scheduleSnap(Math.max(500, this.interval * 1000 - (Date.now() - started)));
  }

  private trySend(snap: SnapMsg): boolean {
    try {
      return this.send(snap);
    } catch {
      // слишком большой кадр: урезаем логи и пробуем ещё раз
      const slim = { ...snap, logs: snap.logs.slice(0, 20), svc: snap.svc.slice(0, 200) };
      try {
        return this.send(slim);
      } catch {
        return false;
      }
    }
  }

  private cleanup(): void {
    this.phase = "hs1";
    this.channel = null;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.hsTimer) clearTimeout(this.hsTimer);
    this.snapTimer = null;
    this.watchdog = null;
    this.hsTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
    this.ws = null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(`nodeko-agent ${AGENT_VERSION} (protocol ${PROTOCOL_VERSION})`);
    return;
  }
  if (args.help) {
    console.log("nodeko-agent [--config <path>] [--once] [--version]");
    return;
  }
  const cfgPath = args.config ?? defaultConfigPath();
  if (args.once) {
    await once(cfgPath);
    return;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig(cfgPath);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(78); // EX_CONFIG: systemd не будет крутить рестарты бессмысленно часто (RestartSec)
  }
  const keyFile = cfg.keyFile ?? defaultKeyFile();
  const { identity, created } = loadOrCreateKey(keyFile);
  const fp = fingerprint(rawPublic(identity.publicKey));
  log.info(`nodeko-agent ${AGENT_VERSION}, сервер «${cfg.server}», ключ агента ${fp}${created ? " (новый)" : ""}`);
  log.info(`хаб ${cfg.hub}, ключ хаба ${fingerprint(b64u.dec(cfg.hubKey))}`);
  if (created && !cfg.enroll) log.warn("ключ агента новый, а токена регистрации в конфиге нет — хаб не узнает агента");

  const collector = new Collector({ docker: cfg.docker, pm2: cfg.pm2, users: cfg.users });
  await collector.prime(true);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info("остановка");
    collector.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let attempt = 0;
  for (;;) {
    const conn = new Connection(cfg, cfgPath, identity, collector);
    await conn.run();
    if (stopping) return;
    let delay: number;
    if (!conn.authenticated && conn.byeReason) {
      delay = AUTH_RETRY;
      log.warn(`повторная попытка через ${AUTH_RETRY / 60000} мин (проверьте регистрацию сервера «${cfg.server}» на хабе)`);
    } else {
      if (conn.authenticated) attempt = 0;
      attempt++;
      const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));
      delay = Math.round(base * (0.7 + Math.random() * 0.6));
    }
    // проверки продолжают копиться в буфере (с лимитом), журнал читается
    await sleep(delay);
  }
}

await main();
