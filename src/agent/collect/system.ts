/** Метрики хоста из /proc и statfs. Парсеры — чистые функции (тесты в system.test.ts). */
import fs from "node:fs";
import os from "node:os";
import type { FsUsage, HostInfo, SysMetrics } from "../../shared/protocol.ts";
import { readText } from "../util.ts";

// ---------- парсеры ----------

export interface CpuTimes {
  total: number;
  idle: number;
}

/** Агрегатная строка `cpu` из /proc/stat. idle = idle + iowait. */
export function parseProcStat(text: string): { cpu: CpuTimes; btime: number | null } {
  let cpu: CpuTimes = { total: 0, idle: 0 };
  let btime: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("cpu ")) {
      const v = line.trim().split(/\s+/).slice(1).map(Number);
      // user nice system idle iowait irq softirq steal guest guest_nice; guest уже входит в user
      const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
      cpu = { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait };
    } else if (line.startsWith("btime ")) {
      btime = Number(line.slice(6).trim());
    }
  }
  return { cpu, btime };
}

export function cpuPercent(prev: CpuTimes | null, cur: CpuTimes): number {
  if (!prev) return 0;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return clamp(100 * (1 - di / dt), 0, 100);
}

export function parseLoadavg(text: string): [number, number, number] {
  const [a = "0", b = "0", c = "0"] = text.trim().split(/\s+/);
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0];
}

export interface MemInfo {
  total: number;
  available: number;
  used: number;
  cached: number;
  swapTotal: number;
  swapUsed: number;
}

export function parseMeminfo(text: string): MemInfo {
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) kv.set(m[1]!, Number(m[2]) * 1024);
  }
  const g = (k: string) => kv.get(k) ?? 0;
  const total = g("MemTotal");
  // MemAvailable есть с ядра 3.14; на совсем старых — приближение
  const available = kv.has("MemAvailable") ? g("MemAvailable") : g("MemFree") + g("Buffers") + g("Cached");
  const swapTotal = g("SwapTotal");
  return {
    total,
    available,
    used: Math.max(0, total - available),
    cached: g("Cached") + g("Buffers") + g("SReclaimable"),
    swapTotal,
    swapUsed: Math.max(0, swapTotal - g("SwapFree")),
  };
}

const VIRTUAL_IFACE =
  /^(lo|docker\d*|veth|br-|virbr|vnet|cni|flannel|cali|kube|tailscale|wg|tun|tap|zt|dummy|ifb|lxc|lxd|podman|vxlan|genev|nebula|ip6tnl|sit|gre)/;

export function isRealIface(name: string): boolean {
  return !VIRTUAL_IFACE.test(name);
}

/** /proc/net/dev → байты rx/tx по реальным интерфейсам. */
export function parseNetDev(text: string): Map<string, { rx: number; tx: number }> {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name || name.includes("|") || !isRealIface(name)) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    out.set(name, { rx: f[0]!, tx: f[8]! });
  }
  return out;
}

/** Физические диски из списка /sys/block (без loop/ram/sr/zram/dm/md/nbd). */
export function physicalDisks(names: string[]): string[] {
  return names.filter((n) => !/^(loop|ram|sr|zram|dm-|md|nbd|fd|rbd|drbd)/.test(n));
}

/** /proc/diskstats → байты чтения/записи по заданным устройствам (сектора по 512 байт). */
export function parseDiskstats(text: string, disks: string[]): { read: number; write: number } {
  const set = new Set(disks);
  let read = 0;
  let write = 0;
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (!set.has(f[2]!)) continue;
    read += Number(f[5]) * 512;
    write += Number(f[9]) * 512;
  }
  return { read, write };
}

const REAL_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "bcachefs", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs"]);
const SKIP_MOUNT = /^\/(proc|sys|dev|run|snap|boot|var\/lib\/(docker|containerd|kubelet|lxd|containers)|var\/snap)(\/|$)/;

export interface MountEntry {
  dev: string;
  mount: string;
  fstype: string;
}

/** /proc/mounts → реальные ФС без дублей по устройству; `/` первой. */
export function parseMounts(text: string): MountEntry[] {
  const unesc = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const all: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 3) continue;
    const dev = unesc(f[0]!);
    const mount = unesc(f[1]!);
    const fstype = f[2]!;
    if (!REAL_FS.has(fstype)) continue;
    if (mount !== "/" && SKIP_MOUNT.test(mount)) continue;
    if (fstype !== "zfs" && !dev.startsWith("/dev/") && !/^(nfs|cifs)/.test(fstype)) continue;
    all.push({ dev, mount, fstype });
  }
  // `/` первой, затем по длине пути, дубли устройства (btrfs-сабволюмы, bind-mount) отбрасываем
  all.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.length - b.mount.length));
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const m of all) {
    if (seen.has(m.dev)) continue;
    seen.add(m.dev);
    out.push(m);
  }
  return out;
}

const ARM_PARTS: Record<string, string> = {
  "0xd03": "Cortex-A53", "0xd04": "Cortex-A35", "0xd05": "Cortex-A55", "0xd07": "Cortex-A57", "0xd08": "Cortex-A72",
  "0xd09": "Cortex-A73", "0xd0a": "Cortex-A75", "0xd0b": "Cortex-A76", "0xd0c": "Neoverse-N1", "0xd0d": "Cortex-A77",
  "0xd40": "Neoverse-V1", "0xd41": "Cortex-A78", "0xd44": "Cortex-X1", "0xd46": "Cortex-A510", "0xd47": "Cortex-A710",
  "0xd48": "Cortex-X2", "0xd49": "Neoverse-N2", "0xd4f": "Neoverse-V2", "0xd8e": "Neoverse-N3", "0xd84": "Neoverse-V3",
};

export function parseCpuModel(cpuinfo: string): string {
  const name = /^(?:model name|Model Name|cpu model)\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim();
  if (name) return name;
  const impl = /^CPU implementer\s*:\s*(\S+)/m.exec(cpuinfo)?.[1];
  const part = /^CPU part\s*:\s*(\S+)/m.exec(cpuinfo)?.[1];
  if (part) {
    const known = impl === "0x41" ? ARM_PARTS[part.toLowerCase()] : undefined;
    return known ? `ARM ${known}` : `ARM (${impl ?? "?"}/${part})`;
  }
  return os.cpus()[0]?.model ?? "unknown";
}

export function parseOsRelease(text: string): string {
  const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text);
  return m?.[1] ?? "Linux";
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

// ---------- коллектор ----------

export function machineArch(): string {
  try {
    return os.machine();
  } catch {
    return process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  }
}

export function collectHostBase(): Omit<HostInfo, "agentVersion" | "caps"> {
  const meminfo = parseMeminfo(readText("/proc/meminfo") ?? "");
  const stat = parseProcStat(readText("/proc/stat") ?? "");
  const cpuinfo = readText("/proc/cpuinfo") ?? "";
  const cores = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || os.cpus().length || 1;
  return {
    hostname: os.hostname(),
    os: parseOsRelease(readText("/etc/os-release") ?? readText("/usr/lib/os-release") ?? ""),
    kernel: (readText("/proc/sys/kernel/osrelease") ?? os.release()).trim(),
    arch: machineArch(),
    cpuModel: parseCpuModel(cpuinfo),
    cores,
    memTotal: meminfo.total,
    bootTime: stat.btime ? stat.btime * 1000 : Date.now() - os.uptime() * 1000,
    user: os.userInfo().username,
  };
}

export class SystemCollector {
  private prevCpu: CpuTimes | null = null;
  private prevNet: { rx: number; tx: number; at: number } | null = null;
  private prevDisk: { read: number; write: number; at: number } | null = null;
  private disks: string[] = [];
  private disksAt = 0;

  /** Метрики без ping (ping меряется параллельно снаружи). */
  collect(): Omit<SysMetrics, "ping"> {
    const now = performance.now();
    const stat = parseProcStat(readText("/proc/stat") ?? "");
    const cpu = cpuPercent(this.prevCpu, stat.cpu);
    this.prevCpu = stat.cpu;

    const mem = parseMeminfo(readText("/proc/meminfo") ?? "");

    // net
    const ifaces = parseNetDev(readText("/proc/net/dev") ?? "");
    let rxTotal = 0;
    let txTotal = 0;
    for (const v of ifaces.values()) {
      rxTotal += v.rx;
      txTotal += v.tx;
    }
    let rx = 0;
    let tx = 0;
    if (this.prevNet) {
      const dt = (now - this.prevNet.at) / 1000;
      if (dt > 0) {
        rx = Math.max(0, (rxTotal - this.prevNet.rx) / dt);
        tx = Math.max(0, (txTotal - this.prevNet.tx) / dt);
      }
    }
    this.prevNet = { rx: rxTotal, tx: txTotal, at: now };

    // disk io
    if (now - this.disksAt > 300_000 || this.disks.length === 0) {
      try {
        this.disks = physicalDisks(fs.readdirSync("/sys/block"));
      } catch {
        this.disks = [];
      }
      this.disksAt = now;
    }
    const io = parseDiskstats(readText("/proc/diskstats") ?? "", this.disks);
    let read = 0;
    let write = 0;
    if (this.prevDisk) {
      const dt = (now - this.prevDisk.at) / 1000;
      if (dt > 0) {
        read = Math.max(0, (io.read - this.prevDisk.read) / dt);
        write = Math.max(0, (io.write - this.prevDisk.write) / dt);
      }
    }
    this.prevDisk = { ...io, at: now };

    return {
      cpu: round(cpu, 2),
      load: parseLoadavg(readText("/proc/loadavg") ?? ""),
      mem: { total: mem.total, used: mem.used, available: mem.available, cached: mem.cached },
      swap: { total: mem.swapTotal, used: mem.swapUsed },
      fs: collectFs(),
      disk: { read: Math.round(read), write: Math.round(write) },
      net: { rx: Math.round(rx), tx: Math.round(tx), rxTotal, txTotal },
      uptime: Math.round(Number((readText("/proc/uptime") ?? "0").split(" ")[0]) || os.uptime()),
      procs: countProcs(),
    };
  }
}

function collectFs(): FsUsage[] {
  const mounts = parseMounts(readText("/proc/mounts") ?? "");
  const out: FsUsage[] = [];
  for (const m of mounts) {
    try {
      const s = fs.statfsSync(m.mount);
      const used = (s.blocks - s.bfree) * s.bsize;
      // как df: процент считается от used + avail (без зарезервированных root-блоков)
      const total = used + s.bavail * s.bsize;
      if (total <= 0) continue;
      out.push({ mount: m.mount, dev: m.dev, fstype: m.fstype, total, used });
    } catch {
      /* нет доступа / отмонтирована */
    }
  }
  return out;
}

function countProcs(): number {
  try {
    let n = 0;
    for (const d of fs.readdirSync("/proc")) if (d.charCodeAt(0) >= 48 && d.charCodeAt(0) <= 57) n++;
    return n;
  } catch {
    return 0;
  }
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
