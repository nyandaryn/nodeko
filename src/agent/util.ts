/** Мелкие утилиты агента: запуск фиксированных команд с таймаутом, лог, чтение файлов. */
import fs from "node:fs";
import os from "node:os";

export const log = {
  info: (msg: string) => console.log(`[agent] ${msg}`),
  warn: (msg: string) => console.warn(`[agent] WARN ${msg}`),
  error: (msg: string) => console.error(`[agent] ERROR ${msg}`),
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Запустить команду (argv, без shell) с таймаутом. Никогда не бросает: при ошибке запуска code = -1.
 * Агент исполняет только собственные фиксированные команды — ничего из конфига хаба сюда не попадает.
 */
export async function run(
  cmd: string[],
  opts: { timeout?: number; env?: Record<string, string | undefined>; maxOutput?: number } = {},
): Promise<RunResult> {
  const timeout = opts.timeout ?? 10_000;
  const max = opts.maxOutput ?? 32 * 1024 * 1024;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env, LC_ALL: "C", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "" },
    });
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>, max),
      readCapped(proc.stderr as ReadableStream<Uint8Array>, 64 * 1024),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size < max) {
      chunks.push(value);
      size += value.length;
    }
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

export function readText(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function exists(path: string): boolean {
  try {
    fs.accessSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

export const HOME = os.homedir();
export const UID = typeof process.getuid === "function" ? process.getuid() : -1;

/** Окружение для `systemctl --user` / `journalctl --user`, когда агент запущен юнитом без сессии. */
export function userBusEnv(uid = UID): Record<string, string> {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  };
}

/** Удалить ANSI-escape и управляющие символы (кроме табуляции). */
export function cleanLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
  const t = out.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Не даём аргументам командной строки унести секреты на хаб. */
export function redactArgv(argv: string[], maxLen = 300): string {
  const secretKey = /(token|pass(word)?|secret|key|auth|cred|api[-_]?key|dsn)/i;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!;
    const prev = i > 0 ? argv[i - 1]! : "";
    if (/^--?[\w-]+$/.test(prev) && secretKey.test(prev)) a = "***";
    else if (/^--?[\w.-]+=/.test(a) || /^[A-Z_][A-Z0-9_]*=/.test(a)) {
      const eq = a.indexOf("=");
      if (secretKey.test(a.slice(0, eq))) a = `${a.slice(0, eq)}=***`;
    } else if (/^[A-Za-z0-9+/=_-]{32,}$/.test(a) && !a.startsWith("/")) a = "***";
    // URL с логином/паролем
    a = a.replace(/(\w+:\/\/)[^/@\s:]+:[^/@\s]+@/g, "$1***@");
    out.push(a);
  }
  const s = out.join(" ");
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
