/**
 * Ошибки из journald: один долгоживущий `journalctl -f -o json`, классификация строк по сервисам.
 * journalctl сам показывает только то, что пользователю агента разрешено читать.
 */
import { DEFAULT_LOG_PATTERN, LIMITS, type LogLine } from "../../shared/protocol.ts";
import { cleanLine, log, run, userBusEnv } from "../util.ts";

export interface JournalEntry {
  MESSAGE?: string | number[] | null;
  PRIORITY?: string;
  _SYSTEMD_UNIT?: string;
  _SYSTEMD_USER_UNIT?: string;
  UNIT?: string;
  USER_UNIT?: string;
  _UID?: string;
  CONTAINER_NAME?: string;
  __REALTIME_TIMESTAMP?: string;
  SYSLOG_IDENTIFIER?: string;
}

const svc = (u: string | undefined) => (u && u.endsWith(".service") ? u.slice(0, -8) : null);

/** К какому сервису относится строка журнала (ключ ServiceSample) или null. */
export function attribute(e: JournalEntry): string | null {
  // сообщения пользовательского менеджера о юните («Main process exited…»)
  const userUnit = svc(e.USER_UNIT);
  if (userUnit) return `systemd-user:${userUnit}`;
  const userOwn = svc(e._SYSTEMD_USER_UNIT);
  if (userOwn) return `systemd-user:${userOwn}`;
  // сообщения системного менеджера о юните
  const unit = svc(e.UNIT);
  if (unit && !unit.startsWith("user@")) return `systemd:${unit}`;
  const own = svc(e._SYSTEMD_UNIT);
  if (own && !own.startsWith("user@")) return `systemd:${own}`;
  if (e.CONTAINER_NAME) return `docker:${e.CONTAINER_NAME}`;
  return null;
}

export function decodeMessage(m: JournalEntry["MESSAGE"]): string {
  if (m == null) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return Buffer.from(m).toString("utf8");
  return String(m);
}

export function compilePattern(src: string | undefined): RegExp {
  const s = (src ?? "").trim();
  if (s && s.length <= 2000) {
    try {
      return new RegExp(s, "i");
    } catch {
      log.warn("logPattern от хаба не компилируется — используется встроенный");
    }
  }
  return new RegExp(DEFAULT_LOG_PATTERN, "i");
}

export function isError(prio: number, msg: string, re: RegExp): boolean {
  return prio <= 3 || re.test(msg);
}

export class JournalWatcher {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  private pattern: RegExp = compilePattern("");
  private pending: LogLine[] = [];
  private perKey = new Map<string, number>();
  private dropped = new Map<string, number>();
  private counts = new Map<string, number>();
  private backoff = 5000;
  caps = { system: false, user: false };

  setPattern(src: string): void {
    this.pattern = compilePattern(src);
  }

  /** Что агенту доступно в журнале (для HostInfo.caps). */
  async probe(): Promise<void> {
    const sys = await run(["journalctl", "--system", "-n", "1", "-q", "-o", "cat", "--no-pager"], { timeout: 10_000, maxOutput: 65536 });
    this.caps.system = sys.code === 0 && sys.stdout.trim().length > 0;
    const usr = await run(["journalctl", "--user", "-n", "1", "-q", "-o", "cat", "--no-pager"], {
      timeout: 10_000,
      maxOutput: 65536,
      env: userBusEnv(),
    });
    this.caps.user = usr.code === 0 && usr.stdout.trim().length > 0;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        this.proc = Bun.spawn(
          [
            "journalctl",
            "-f",
            "-o",
            "json",
            "-n",
            "0",
            "--no-pager",
            "--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT,UNIT,USER_UNIT,_UID,CONTAINER_NAME,__REALTIME_TIMESTAMP,SYSLOG_IDENTIFIER",
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C", SYSTEMD_COLORS: "0" } },
        );
        await this.consume(this.proc.stdout as ReadableStream<Uint8Array>);
        await this.proc.exited;
      } catch (e) {
        log.warn(`journalctl: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.proc = null;
      if (this.stopped) break;
      // долго проработал — значит, это не постоянная ошибка; сбрасываем бэкофф
      if (Date.now() - startedAt > 60_000) this.backoff = 5000;
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(this.backoff * 2, 60_000);
    }
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(line);
      }
      // защита от гигантской строки без перевода строки
      if (buf.length > 1024 * 1024) buf = "";
    }
  }

  handleLine(line: string): void {
    let e: JournalEntry;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const key = attribute(e);
    if (!key) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const raw = decodeMessage(e.MESSAGE);
    if (!raw) return;
    const prio = Number(e.PRIORITY ?? 6);
    const msg = cleanLine(raw, LIMITS.logLineLen);
    if (!msg || !isError(Number.isFinite(prio) ? prio : 6, msg, this.pattern)) return;
    const n = this.perKey.get(key) ?? 0;
    if (n >= LIMITS.logsPerServicePerSnap || this.pending.length >= LIMITS.logsPerSnap) {
      this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
      return;
    }
    this.perKey.set(key, n + 1);
    const us = Number(e.__REALTIME_TIMESTAMP);
    this.pending.push({ key, ts: Number.isFinite(us) && us > 0 ? Math.floor(us / 1000) : Date.now(), prio, msg });
  }

  /** Забрать накопленное с прошлого снимка. counts — строк лога по сервису за это время. */
  drain(): { logs: LogLine[]; dropped: Record<string, number>; counts: Map<string, number> } {
    const out = {
      logs: this.pending,
      dropped: Object.fromEntries(this.dropped),
      counts: this.counts,
    };
    this.pending = [];
    this.perKey = new Map();
    this.dropped = new Map();
    this.counts = new Map();
    return out;
  }

  /** Вернуть строки обратно (кадр не отправлен) — с соблюдением лимитов. */
  requeue(logs: LogLine[]): void {
    for (const l of logs) {
      if (this.pending.length >= LIMITS.logsPerSnap) break;
      this.pending.push(l);
      this.perKey.set(l.key, (this.perKey.get(l.key) ?? 0) + 1);
    }
  }
}
