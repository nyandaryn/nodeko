type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.NODEKO_LOG_LEVEL as Level) ?? "info"] ?? 20;

function out(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < min) return;
  const tail = extra && Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
  const line = `${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => out("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => out("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => out("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => out("error", m, e),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
