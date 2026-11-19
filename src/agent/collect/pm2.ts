/**
 * Процессы pm2 через `pm2 jlist` (раз в 30 с, кэш между вызовами).
 * Важно: jlist вызываем только если демон pm2 уже жив — иначе pm2 сам запустит новый демон.
 * Из вывода берутся только безопасные поля; env процессов никогда не читается дальше парсинга.
 */
import fs from "node:fs";
import path from "node:path";
import type { ServiceSample, ServiceState } from "../../shared/protocol.ts";
import { exists, HOME, isExecutable, readText, run } from "../util.ts";

export interface Pm2Config {
  bin?: string;
  node?: string;
}

export function mapPm2State(status: string | undefined): ServiceState {
  switch (status) {
    case "online":
      return "running";
    case "launching":
      return "starting";
    case "stopping":
      return "stopping";
    case "errored":
      return "failed";
    case "one-launch-status":
      return "exited";
    default:
      return "inactive";
  }
}

export interface Pm2Proc {
  name: string;
  pid: number;
  status?: string;
  uptime?: number;
  restarts?: number;
  cpu?: number;
  mem?: number;
  version?: string;
  revision?: string;
  execPath?: string;
  cwd?: string;
  interpreter?: string;
  nodeVersion?: string;
  autorestart?: boolean;
}

/** Разбор `pm2 jlist` с отбрасыванием всего, кроме безопасных полей. */
export function parseJlist(text: string): Pm2Proc[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Pm2Proc[] = [];
  for (const p of arr as Record<string, unknown>[]) {
    const env = (p.pm2_env ?? {}) as Record<string, unknown>;
    const monit = (p.monit ?? {}) as Record<string, unknown>;
    const versioning = (env.versioning ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v && v !== "N/A" ? v : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    out.push({
      name: String(p.name ?? env.name ?? "?"),
      pid: num(p.pid) ?? 0,
      status: str(env.status),
      uptime: num(env.pm_uptime),
      restarts: num(env.restart_time),
      cpu: num(monit.cpu),
      mem: num(monit.memory),
      version: str(env.version),
      revision: str(versioning.revision),
      execPath: str(env.pm_exec_path),
      cwd: str(env.pm_cwd),
      interpreter: str(env.exec_interpreter),
      nodeVersion: str(env.node_version),
      autorestart: typeof env.autorestart === "boolean" ? env.autorestart : undefined,
    });
  }
  return out;
}

function newestNvm(binName: string): string | null {
  const base = path.join(HOME, ".nvm/versions/node");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return null;
  }
  const sorted = dirs
    .filter((d) => /^v\d+/.test(d))
    .sort((a, b) => {
      const pa = a.slice(1).split(".").map(Number);
      const pb = b.slice(1).split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      return 0;
    });
  for (const d of sorted) {
    const p = path.join(base, d, "bin", binName);
    if (exists(p)) return p;
  }
  return null;
}

export class Pm2Collector {
  available = false;
  private cache: Pm2Proc[] = [];
  private cacheAt = 0;
  private bin: string | null = null;
  private node: string | null = null;
  private resolved = false;

  constructor(private readonly cfg: Pm2Config = {}) {}

  private pm2Home(): string {
    return process.env.PM2_HOME || path.join(HOME, ".pm2");
  }

  /** Демон pm2 жив? (pid-файл + процесс существует) */
  daemonAlive(): boolean {
    const pid = Number(readText(path.join(this.pm2Home(), "pm2.pid"))?.trim());
    return Number.isInteger(pid) && pid > 0 && exists(`/proc/${pid}`);
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;
    const bins = [
      this.cfg.bin,
      Bun.which("pm2"),
      path.join(HOME, ".bun/install/global/node_modules/pm2/bin/pm2"),
      path.join(HOME, ".npm-global/bin/pm2"),
      path.join(HOME, ".npm-global/lib/node_modules/pm2/bin/pm2"),
      newestNvm("pm2"),
      "/usr/local/bin/pm2",
      "/usr/bin/pm2",
    ];
    this.bin = bins.find((b): b is string => !!b && exists(b)) ?? null;
    const nodes = [this.cfg.node, Bun.which("node"), newestNvm("node"), "/usr/local/bin/node", "/usr/bin/node"];
    this.node = nodes.find((n): n is string => !!n && isExecutable(n)) ?? null;
  }

  async collect(): Promise<Pm2Proc[]> {
    const now = Date.now();
    if (now - this.cacheAt < 30_000) return this.cache;
    this.cacheAt = now;
    if (!this.daemonAlive()) {
      this.available = false;
      this.cache = [];
      return this.cache;
    }
    this.resolve();
    if (!this.bin || !this.node) {
      this.available = false;
      return (this.cache = []);
    }
    let realBin = this.bin;
    try {
      realBin = fs.realpathSync(this.bin);
    } catch {
      /* как есть */
    }
    const r = await run([this.node, realBin, "jlist"], {
      timeout: 20_000,
      env: { PM2_HOME: this.pm2Home(), PATH: `${path.dirname(this.node)}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    if (r.code !== 0) {
      this.available = false;
      return (this.cache = []);
    }
    this.available = true;
    this.cache = parseJlist(r.stdout);
    return this.cache;
  }
}

export function pm2ToSample(p: Pm2Proc): ServiceSample & { argvExec?: string } {
  const state = mapPm2State(p.status);
  const s: ServiceSample & { argvExec?: string } = {
    key: `pm2:${p.name}`,
    kind: "pm2",
    name: p.name,
    state,
    raw: p.status ?? "unknown",
  };
  if (p.autorestart !== undefined) s.enabled = p.autorestart ? "autorestart" : "no-autorestart";
  if (state === "running" && p.uptime) s.since = p.uptime;
  if (p.pid) s.pid = p.pid;
  if (p.restarts !== undefined) s.restarts = p.restarts;
  if (state === "running") {
    if (p.cpu !== undefined) s.cpu = p.cpu;
    if (p.mem !== undefined) s.mem = p.mem;
  }
  if (p.version) s.version = p.version;
  if (p.revision && /^[0-9a-f]{7,64}$/.test(p.revision)) s.commit = p.revision.slice(0, 12);
  if (p.cwd) s.cwd = p.cwd;
  if (p.execPath) s.exec = p.execPath;
  if (p.interpreter === "node" && p.nodeVersion) s.runtime = `node ${p.nodeVersion}`;
  else if (p.interpreter && p.interpreter.startsWith("/")) s.argvExec = p.interpreter;
  return s;
}
