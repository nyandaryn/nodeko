/** Сборка снимка: система + сервисы (systemd/docker/pm2) + версии + порты + ошибки журнала + проверки. */
import { tcpPing } from "../shared/checks.ts";
import {
  AGENT_VERSION,
  DEFAULT_PING_TARGET,
  LIMITS,
  type HostInfo,
  type ServiceSample,
  type SnapMsg,
} from "../shared/protocol.ts";
import { CheckRunner } from "./checks.ts";
import { DockerCollector } from "./collect/docker.ts";
import { JournalWatcher } from "./collect/journal.ts";
import { Pm2Collector, pm2ToSample, type Pm2Config } from "./collect/pm2.ts";
import { cgroupPids, PortsResolver } from "./collect/ports.ts";
import { collectHostBase, SystemCollector } from "./collect/system.ts";
import { SystemdCollector, type SystemdUnitSample } from "./collect/systemd.ts";
import { runtimeName, VersionResolver } from "./collect/versions.ts";
import { exists } from "./util.ts";

export interface CollectorOptions {
  docker?: string;
  pm2?: Pm2Config;
  /** только для агента под root: чьи user-юниты смотреть (`systemctl --user -M <user>@`) */
  users?: string[];
}

const PUBLIC_FIELDS: (keyof ServiceSample)[] = [
  "key", "kind", "name", "description", "state", "raw", "enabled", "job", "vendor", "since", "lastRun", "result",
  "exitCode", "pid", "restarts", "cpu", "mem", "tasks", "ports", "version", "commit", "commitAt", "runtime", "cwd",
  "exec", "image", "health", "logRate",
];

function publicSample(s: ServiceSample): ServiceSample {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) {
    const v = s[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out as unknown as ServiceSample;
}

export class Collector {
  readonly system = new SystemCollector();
  readonly systemd: SystemdCollector;
  readonly docker: DockerCollector;
  readonly pm2: Pm2Collector;
  readonly journal = new JournalWatcher();
  readonly versions = new VersionResolver();
  readonly ports = new PortsResolver();
  readonly checks = new CheckRunner();
  pingTarget = DEFAULT_PING_TARGET;
  private dockerSocket: string;
  private lastSnapAt = 0;

  constructor(opts: CollectorOptions = {}) {
    this.dockerSocket = opts.docker ?? "/var/run/docker.sock";
    this.systemd = new SystemdCollector(opts.users ?? []);
    this.docker = new DockerCollector(this.dockerSocket);
    this.pm2 = new Pm2Collector(opts.pm2 ?? {});
  }

  /** Первый проход: базовые дельты CPU/сети, проба доступов. */
  async prime(withJournal = true): Promise<void> {
    this.system.collect();
    await Promise.all([this.collectServices(), this.journal.probe()]);
    if (withJournal) this.journal.start();
    this.lastSnapAt = Date.now();
  }

  hostInfo(): HostInfo {
    return {
      ...collectHostBase(),
      agentVersion: AGENT_VERSION,
      caps: {
        systemdUser: this.systemd.caps.user,
        systemdSystem: this.systemd.caps.system,
        journalSystem: this.journal.caps.system,
        journalUser: this.journal.caps.user,
        docker: this.docker.available,
        pm2: this.pm2.available,
      },
    };
  }

  private async collectServices(): Promise<ServiceSample[]> {
    const [units, containers, procs] = await Promise.all([
      this.systemd.collect().catch(() => [] as SystemdUnitSample[]),
      exists(this.dockerSocket) ? this.docker.collect().catch(() => [] as ServiceSample[]) : Promise.resolve([] as ServiceSample[]),
      this.pm2.collect().catch(() => []),
    ]);

    // версии
    await Promise.all(
      units.map(async (u) => {
        const argv = u.argv ?? [];
        const app = this.versions.appVersion(u.key, u.cwd, argv);
        if (app.version) u.version = app.version;
        if (app.commit) u.commit = app.commit;
        if (app.commitAt) u.commitAt = app.commitAt;
        if (u.name === "nodeko-agent") u.version = AGENT_VERSION;
        let bin = argv[0];
        if (!bin) return;
        // обёртки: `bash -c "/usr/bin/x …"`, `env X=1 /usr/bin/x` — версия у того, что они запускают
        const base = bin.split("/").pop() ?? "";
        if (/^(ba|da|z)?sh$/.test(base)) {
          const inner = argv[1] === "-c" ? /^\s*(\/[^\s;&|]+)/.exec(argv[2] ?? "")?.[1] : undefined;
          if (!inner) return;
          bin = inner;
        } else if (base === "env") {
          bin = argv.slice(1).find((a) => a.startsWith("/")) ?? "";
          if (!bin) return;
        } else if (/^(python[\d.]*|perl|ruby|php[\d.]*)$/.test(base)) {
          return;
        }
        if (runtimeName(bin)) {
          const rt = await this.versions.runtimeOf(bin);
          if (rt) u.runtime = rt;
        } else if (!u.version) {
          const pv = await this.versions.packageVersion(bin);
          if (pv) u.version = pv;
        }
      }),
    );
    const pm2Samples = await Promise.all(
      procs.map(async (p) => {
        const s = pm2ToSample(p);
        if (s.argvExec) {
          const rt = await this.versions.runtimeOf(s.argvExec);
          if (rt) s.runtime = rt;
        }
        if (!s.version || !s.commit) {
          const app = this.versions.appVersion(s.key, s.cwd, s.exec ? ["x", s.exec] : []);
          if (!s.version && app.version) s.version = app.version;
          if (!s.commit && app.commit) s.commit = app.commit;
        }
        return s;
      }),
    );

    // порты (раз в минуту)
    if (this.ports.due()) {
      const targets: { key: string; pids: number[] }[] = [];
      for (const u of units) {
        if (u.state !== "running") continue;
        const pids = u.cgroup ? cgroupPids(u.cgroup) : [];
        if (!pids.length && u.pid) pids.push(u.pid);
        if (pids.length) targets.push({ key: u.key, pids });
      }
      for (const p of pm2Samples) if (p.pid && p.state === "running") targets.push({ key: p.key, pids: [p.pid] });
      this.ports.refresh(targets);
    }
    for (const s of [...units, ...pm2Samples]) {
      const ports = this.ports.get(s.key);
      if (ports) s.ports = ports;
    }

    return [...units, ...containers, ...pm2Samples];
  }

  async snapshot(): Promise<SnapMsg> {
    const now = Date.now();
    const dt = this.lastSnapAt ? Math.max(0.001, (now - this.lastSnapAt) / 1000) : 0;
    this.lastSnapAt = now;
    const sys = this.system.collect();
    const [ping, services] = await Promise.all([tcpPing(this.pingTarget, 3000).catch(() => null), this.collectServices()]);
    const j = this.journal.drain();
    // строки журнала уходят только по сервисам, которые есть в снимке (ssh, logind и т.п. — нет)
    const known = new Set(services.map((s) => s.key));
    const logs = j.logs.filter((l) => known.has(l.key));
    const dropped = Object.fromEntries(Object.entries(j.dropped).filter(([k]) => known.has(k)));
    for (const s of services) {
      const c = j.counts.get(s.key);
      if (c && dt > 0) s.logRate = Math.round((c / dt) * 60 * 10) / 10;
    }
    const svc = services.slice(0, LIMITS.services).map(publicSample);
    return {
      t: "snap",
      ts: now,
      dt: Math.round(dt * 1000) / 1000,
      m: { ...sys, ping },
      svc,
      chk: this.checks.drain(),
      logs,
      ...(Object.keys(dropped).length ? { dropped } : {}),
    };
  }

  stop(): void {
    this.journal.stop();
    this.checks.stop();
  }
}
