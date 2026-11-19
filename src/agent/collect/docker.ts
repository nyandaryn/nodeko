/** Контейнеры Docker через unix-сокет Engine API (только чтение). */
import type { ServiceSample, ServiceState } from "../../shared/protocol.ts";
import { readText } from "../util.ts";

interface ContainerListItem {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
  Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[];
}

interface ContainerInspect {
  State?: {
    Status?: string;
    Pid?: number;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    OOMKilled?: boolean;
    Health?: { Status?: string };
  };
  RestartCount?: number;
  HostConfig?: { RestartPolicy?: { Name?: string } };
  Config?: { Image?: string };
}

export function imageTag(image: string | undefined): string | undefined {
  if (!image) return undefined;
  const at = image.indexOf("@");
  if (at >= 0) return image.slice(at + 1, at + 20);
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return image.slice(colon + 1);
  return image.startsWith("sha256:") ? image.slice(7, 19) : "latest";
}

export function mapDockerState(status: string | undefined, exitCode: number | undefined): ServiceState {
  switch (status) {
    case "running":
      return "running";
    case "restarting":
      return "restarting";
    case "removing":
      return "stopping";
    case "created":
    case "paused":
      return "inactive";
    case "exited":
    case "dead":
      return exitCode && exitCode !== 0 ? "failed" : "inactive";
    default:
      return "inactive";
  }
}

function parseDockerTime(s: string | undefined): number | undefined {
  if (!s || s.startsWith("0001-")) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** usage_usec из cpu.stat cgroup v2 */
export function parseCpuStatUsec(text: string | null): number | undefined {
  if (!text) return undefined;
  const m = /^usage_usec (\d+)/m.exec(text);
  return m ? Number(m[1]) : undefined;
}

export class DockerCollector {
  available = false;
  private cpuPrev = new Map<string, { usec: number; at: number }>();
  private inspectCache = new Map<string, { at: number; data: ContainerInspect }>();

  constructor(private readonly socket = "/var/run/docker.sock") {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`http://localhost${path}`, {
      unix: this.socket,
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) throw new Error(`docker ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async collect(): Promise<ServiceSample[]> {
    let list: ContainerListItem[];
    try {
      list = await this.get<ContainerListItem[]>("/containers/json?all=1");
      this.available = true;
    } catch {
      this.available = false;
      return [];
    }
    const now = Date.now();
    const out: ServiceSample[] = [];
    await Promise.all(
      list.map(async (c) => {
        const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
        let ins: ContainerInspect | undefined;
        const cached = this.inspectCache.get(c.Id);
        // inspect нужен для StartedAt/RestartCount/Health; на работающем контейнере обновляем раз в 30 с
        if (cached && now - cached.at < 30_000 && cached.data.State?.Status === c.State) ins = cached.data;
        else {
          try {
            ins = await this.get<ContainerInspect>(`/containers/${c.Id}/json`);
            this.inspectCache.set(c.Id, { at: now, data: ins });
          } catch {
            ins = undefined;
          }
        }
        const st = ins?.State;
        const state = mapDockerState(st?.Status ?? c.State, st?.ExitCode);
        const s: ServiceSample = {
          key: `docker:${name}`,
          kind: "docker",
          name,
          state,
          raw: c.Status ?? c.State ?? "?",
        };
        const project = c.Labels?.["com.docker.compose.project"];
        if (project) s.description = `compose: ${project}`;
        const policy = ins?.HostConfig?.RestartPolicy?.Name;
        if (policy) s.enabled = policy;
        const started = parseDockerTime(st?.StartedAt);
        if (state === "running" && started) s.since = started;
        const finished = parseDockerTime(st?.FinishedAt);
        if (state !== "running" && finished) s.lastRun = finished;
        if (st?.OOMKilled) s.result = "oom-kill";
        if (state === "failed" && st?.ExitCode !== undefined) s.exitCode = st.ExitCode;
        if (st?.Pid) s.pid = st.Pid;
        if (ins?.RestartCount !== undefined) s.restarts = ins.RestartCount;
        if (st?.Health?.Status) s.health = st.Health.Status;
        const image = ins?.Config?.Image ?? c.Image;
        if (image) {
          s.image = image;
          const tag = imageTag(image);
          if (tag) s.version = tag;
        }
        const ports = new Set<number>();
        for (const p of c.Ports ?? []) if (p.PublicPort) ports.add(p.PublicPort);
        if (ports.size) s.ports = [...ports].sort((a, b) => a - b);
        if (state === "running") {
          const cg = cgroupDir(c.Id);
          if (cg) {
            const mem = Number(readText(`${cg}/memory.current`)?.trim());
            if (Number.isFinite(mem) && mem > 0) s.mem = mem;
            const usec = parseCpuStatUsec(readText(`${cg}/cpu.stat`));
            if (usec !== undefined) {
              const prev = this.cpuPrev.get(c.Id);
              s.cpu = prev && usec >= prev.usec && now > prev.at ? Math.round(((usec - prev.usec) / ((now - prev.at) * 1000)) * 10000) / 100 : 0;
              this.cpuPrev.set(c.Id, { usec, at: now });
            }
            const tasks = Number(readText(`${cg}/pids.current`)?.trim());
            if (Number.isFinite(tasks) && tasks > 0) s.tasks = tasks;
          }
        }
        out.push(s);
      }),
    );
    const live = new Set(list.map((c) => c.Id));
    for (const k of this.inspectCache.keys()) if (!live.has(k)) this.inspectCache.delete(k);
    for (const k of this.cpuPrev.keys()) if (!live.has(k)) this.cpuPrev.delete(k);
    return out;
  }
}

function cgroupDir(id: string): string | null {
  for (const p of [`/sys/fs/cgroup/system.slice/docker-${id}.scope`, `/sys/fs/cgroup/docker/${id}`]) {
    if (readText(`${p}/cgroup.procs`) !== null) return p;
  }
  return null;
}
