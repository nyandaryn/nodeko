/** Какие TCP-порты слушают процессы сервиса: /proc/net/tcp{,6} (LISTEN) × /proc/<pid>/fd. */
import fs from "node:fs";
import { readText } from "../util.ts";

/** inode → порт для сокетов в состоянии LISTEN (0A). */
export function parseProcNetTcp(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const local = f[1]!;
    const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    const inode = Number(f[9]);
    if (port > 0 && inode > 0) out.set(inode, port);
  }
  return out;
}

export function listeningInodes(): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const [k, v] of parseProcNetTcp(readText(f) ?? "")) out.set(k, v);
  }
  return out;
}

/** PID'ы cgroup (с вложенными на один уровень). */
export function cgroupPids(cgroup: string): number[] {
  const base = `/sys/fs/cgroup${cgroup}`;
  const pids: number[] = [];
  const add = (dir: string) => {
    for (const l of (readText(`${dir}/cgroup.procs`) ?? "").split("\n")) {
      const n = Number(l);
      if (n > 0) pids.push(n);
    }
  };
  add(base);
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) add(`${base}/${d.name}`);
  } catch {
    /* нет cgroup */
  }
  return pids;
}

export function portsOfPids(pids: number[], listening: Map<number, number>): number[] {
  const ports = new Set<number>();
  for (const pid of pids.slice(0, 64)) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // чужой процесс — нет прав
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith("socket:[")) continue;
      const port = listening.get(Number(target.slice(8, -1)));
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Кэш портов по сервисам, обновляется раз в minInterval. */
export class PortsResolver {
  private cache = new Map<string, number[]>();
  private at = 0;

  constructor(private readonly minInterval = 60_000) {}

  due(): boolean {
    return Date.now() - this.at >= this.minInterval;
  }

  refresh(targets: { key: string; pids: number[] }[]): void {
    this.at = Date.now();
    const listening = listeningInodes();
    const next = new Map<string, number[]>();
    for (const t of targets) {
      const ports = portsOfPids(t.pids, listening);
      if (ports.length) next.set(t.key, ports);
    }
    this.cache = next;
  }

  get(key: string): number[] | undefined {
    return this.cache.get(key);
  }
}
