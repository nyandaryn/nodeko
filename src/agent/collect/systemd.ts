/** Сервисы systemd — системный менеджер и пользовательский (агент работает как user-юнит). */
import type { ServiceKind, ServiceSample, ServiceState } from "../../shared/protocol.ts";
import { HOME, redactArgv, run as defaultRun, UID, userBusEnv } from "../util.ts";

export const SHOW_PROPS = [
  "Id",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "Type",
  "MainPID",
  "ActiveEnterTimestamp",
  "InactiveEnterTimestamp",
  "ExecMainExitTimestamp",
  "NRestarts",
  "MemoryCurrent",
  "CPUUsageNSec",
  "TasksCurrent",
  "Result",
  "ExecMainStatus",
  "Description",
  "FragmentPath",
  "WorkingDirectory",
  "ExecStart",
  "ControlGroup",
  "TriggeredBy",
] as const;

export type UnitProps = Partial<Record<(typeof SHOW_PROPS)[number], string>>;

/** Вывод `systemctl show` для нескольких юнитов: блоки key=value, разделённые пустой строкой. */
export function parseShow(text: string): UnitProps[] {
  const out: UnitProps[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      props[line.slice(0, i)] = line.slice(i + 1);
    }
    if (props.Id) out.push(props as UnitProps);
  }
  return out;
}

/** `@1794856557` (--timestamp=unix) или пусто → ms epoch. */
export function parseUnixTs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^@(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return undefined;
  const sec = Number(m[1]);
  if (!sec) return undefined;
  return sec * 1000 + (m[2] ? Math.round(Number(`0.${m[2]}`) * 1000) : 0);
}

/** Число из systemctl show, отбрасывая `[not set]` и UINT64_MAX. */
export function parseNum(v: string | undefined): number | undefined {
  if (!v || !/^\d+$/.test(v)) return undefined;
  if (v === "18446744073709551615") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** `{ path=/x ; argv[]=/x a b ; … }` → argv. Берётся первая команда. */
export function parseExecStart(v: string | undefined): string[] {
  if (!v) return [];
  const m = /argv\[\]=(.*?) ; (?:ignore_errors|flags)=/.exec(v);
  const raw = m?.[1] ?? /path=([^ ;]+)/.exec(v)?.[1] ?? "";
  return raw.split(" ").filter(Boolean);
}

export function cleanWorkingDir(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const p = v.replace(/^[!\-+@:~]+/, "");
  if (!p.startsWith("/")) return p === "" || v.includes("~") ? HOME : undefined;
  return p;
}

export function isVendorPath(p: string | undefined): boolean {
  if (!p) return true;
  return /^\/(usr\/)?lib\//.test(p) || p.startsWith("/usr/share/") || p.startsWith("/run/");
}

/** Юниты ОС, которые не интересны как «сервисы». */
const DENY = [
  /^systemd-/, /^dbus(-|\.|$)/, /^dbus-broker/, /^getty@/, /^serial-getty@/, /^autovt@/, /^container-getty@/, /^console-/,
  /^ssh(d)?$/, /^cron(d)?$/, /^anacron$/, /^rsyslog$/, /^syslog$/, /^polkit$/, /^unattended-upgrades$/, /^user@/,
  /^user-runtime-dir@/, /^multipathd$/, /^networkd-dispatcher$/, /^NetworkManager(-|$)/, /^udisks2$/, /^ModemManager$/,
  /^snapd/, /^snap\./, /^packagekit/, /^fwupd/, /^irqbalance$/, /^qemu-guest-agent$/, /^chrony(d)?$/, /^atd$/,
  /^accounts-daemon$/, /^lvm2/, /^apport/, /^cloud-/, /^upower$/, /^thermald$/, /^wpa_supplicant/, /^apparmor$/,
  /^ufw$/, /^e2scrub/, /^fstrim$/, /^logrotate$/, /^man-db$/, /^motd-news$/, /^dpkg-db-backup$/, /^setvtrgb$/,
  /^keyboard-setup$/, /^kmod/, /^plymouth/, /^blk-availability$/, /^open-vm-tools$/, /^vmtoolsd$/, /^vgauth/,
  /^iscsid?$/, /^open-iscsi$/, /^finalrd$/, /^gpg-agent/, /^dirmngr/, /^keyboxd/, /^pipewire/, /^wireplumber/,
  /^filter-chain$/, /^xdg-/, /^at-spi/, /^gvfs/, /^obex$/, /^evolution-/, /^tracker-/, /^gnome-/, /^org\.gnome\./,
  /^app-/, /^ua-/, /^ubuntu-advantage/, /^esm-cache$/, /^secureboot-/, /^grub-/, /^rsync$/, /^sysstat/,
  /^modprobe@/, /^lxd-agent/, /^hv-/, /^google-/, /^waagent$/, /^walinuxagent$/, /^ec2-/, /^amazon-ssm/,
  /^auditd$/, /^firewalld$/, /^rtkit-daemon$/, /^avahi-daemon$/, /^cups/, /^bluetooth$/, /^colord$/, /^switcheroo/,
  /^power-profiles/, /^bolt$/, /^gdm$/, /^sddm$/, /^lightdm$/, /^gssproxy$/, /^rpcbind$/, /^nfs-/, /^rpc-/,
  /^smartd$/, /^mdmonitor$/, /^mcelog$/, /^abrt/, /^sssd/, /^dnf-/, /^rpm-ostree/, /^flatpak/, /^geoclue$/,
  /^low-memory-monitor$/, /^uresourced$/, /^zram/, /^akmods/, /^nvidia-/, /^libvirt/, /^virt/, /^mutter/,
  /^xrdp-sesman$/, /^ssh-agent$/, /^p11-kit/, /^grafana-agent$/, /^update-notifier/, /^pollinate$/,
  /^kerneloops$/, /^whoopsie$/, /^speech-dispatcher/, /^ntp(d|sec)?$/, /^unbound-anchor$/, /^mlocate$/, /^plocate/,
  /^initrd-/, /^dracut/, /^emergency$/, /^rescue$/, /^quotaon/, /^ldconfig$/, /^nftables$/, /^iptables$/, /^netfilter-/,
  /^ifup@/, /^networking$/, /^resolvconf/, /^hibagent/, /^podman-/, /^containerd$/, /^docker\.socket$/,
];

export function isDenied(name: string): boolean {
  return DENY.some((re) => re.test(name));
}

/** Нормализованное состояние. */
export function mapState(p: UnitProps, job: boolean): ServiceState {
  const active = p.ActiveState ?? "";
  const sub = p.SubState ?? "";
  switch (active) {
    case "active":
    case "reloading":
    case "refreshing":
      return sub === "exited" ? "exited" : "running";
    case "activating":
      return sub === "auto-restart" || sub === "auto-restart-queued" ? "restarting" : "starting";
    case "deactivating":
      return "stopping";
    case "failed":
      return "failed";
    default:
      if (job && parseUnixTs(p.ExecMainExitTimestamp ?? p.InactiveEnterTimestamp) && (p.Result ?? "success") === "success")
        return "exited";
      return "inactive";
  }
}

interface CpuPrev {
  ns: number;
  at: number;
}

export interface SystemdUnitSample extends ServiceSample {
  /** путь cgroup (для портов), не уходит на хаб */
  cgroup?: string;
  /** argv ExecStart (для версий), не уходит на хаб */
  argv?: string[];
}

export class SystemdCollector {
  private cpuPrev = new Map<string, CpuPrev>();
  caps = { system: false, user: false };

  constructor(
    private readonly users: string[] = [],
    /** запуск команд; подменяется в проверках парсеров */
    private readonly run: typeof defaultRun = defaultRun,
    private readonly uid: number = UID,
  ) {}

  async collect(): Promise<SystemdUnitSample[]> {
    const scopes: { kind: ServiceKind; args: string[]; env?: Record<string, string>; user: boolean }[] = [
      { kind: "systemd", args: [], user: false },
    ];
    if (this.uid !== 0) scopes.push({ kind: "systemd-user", args: ["--user"], env: userBusEnv(), user: true });
    else for (const u of this.users) scopes.push({ kind: "systemd-user", args: ["--user", "-M", `${u}@`], user: true });

    const results = await Promise.all(scopes.map((s) => this.collectScope(s.kind, s.args, s.env, s.user)));
    this.caps.system = results[0] !== null;
    this.caps.user = results.slice(1).some((r) => r !== null);
    return results.flatMap((r) => r ?? []);
  }

  private async collectScope(
    kind: ServiceKind,
    args: string[],
    env: Record<string, string> | undefined,
    user: boolean,
  ): Promise<SystemdUnitSample[] | null> {
    const list = await this.run(["systemctl", ...args, "list-units", "--type=service", "--all", "--no-pager", "-o", "json"], {
      env,
      timeout: 15_000,
    });
    if (list.code !== 0) return null;
    let units: { unit: string; load: string; active: string }[];
    try {
      units = JSON.parse(list.stdout);
    } catch {
      return null;
    }
    const names = new Set<string>();
    for (const u of units) {
      if (!u.unit.endsWith(".service") || u.load === "not-found" || u.load === "masked") continue;
      const base = u.unit.slice(0, -8);
      if (isDenied(base)) continue;
      names.add(u.unit);
    }
    // свои незагруженные (например, выключенные) user-юниты
    if (user) {
      const files = await this.run(["systemctl", ...args, "list-unit-files", "--type=service", "--no-pager", "-o", "json"], {
        env,
        timeout: 15_000,
      });
      if (files.code === 0) {
        try {
          for (const f of JSON.parse(files.stdout) as { unit_file: string; state: string }[]) {
            if (!f.unit_file.endsWith(".service") || f.unit_file.includes("@.")) continue;
            if (["generated", "transient", "masked", "alias", "linked-runtime", "enabled-runtime"].includes(f.state)) continue;
            if (isDenied(f.unit_file.slice(0, -8))) continue;
            names.add(f.unit_file);
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (names.size === 0) return [];

    const props: UnitProps[] = [];
    const all = [...names];
    for (let i = 0; i < all.length; i += 80) {
      const chunk = all.slice(i, i + 80);
      const r = await this.run(
        ["systemctl", ...args, "show", "--timestamp=unix", "--no-pager", "-p", SHOW_PROPS.join(","), "--", ...chunk],
        { env, timeout: 15_000 },
      );
      if (r.code !== 0 && !r.stdout) continue;
      props.push(...parseShow(r.stdout));
    }

    const now = Date.now();
    const out: SystemdUnitSample[] = [];
    for (const p of props) {
      if (!p.Id?.endsWith(".service") || p.LoadState === "not-found" || p.LoadState === "masked") continue;
      // временные (systemd-run) и сгенерированные юниты — не сервисы
      if (p.UnitFileState === "transient" || p.UnitFileState === "generated") continue;
      const name = p.Id.slice(0, -8);
      const vendor = isVendorPath(p.FragmentPath);
      const active = p.ActiveState ?? "inactive";
      // пакетные юниты — только если что-то делают или упали
      if (vendor && !["active", "activating", "reloading", "deactivating", "failed", "refreshing"].includes(active)) continue;
      // пользовательские пакетные юниты (pipewire и т.п.) — только упавшие или из нашего denylist-фильтра уже убраны
      const job = p.Type === "oneshot" || /\.timer\b/.test(p.TriggeredBy ?? "");
      const state = mapState(p, job);
      // пакетные oneshot-юниты — это задачи загрузки ОС (netplan, multipathd…): только если упали
      if (vendor && job && state !== "failed") continue;
      const key = `${kind}:${name}`;
      const argv = parseExecStart(p.ExecStart);
      const s: SystemdUnitSample = {
        key,
        kind,
        name,
        state,
        raw: `${active}/${p.SubState ?? "?"}`,
        vendor,
      };
      if (p.Description && p.Description !== p.Id) s.description = p.Description;
      if (p.UnitFileState) s.enabled = p.UnitFileState;
      if (job) s.job = true;
      const enterTs = parseUnixTs(p.ActiveEnterTimestamp);
      if ((state === "running" || (state === "exited" && !job)) && enterTs) s.since = enterTs;
      if (job) {
        const last = parseUnixTs(p.ExecMainExitTimestamp) ?? parseUnixTs(p.InactiveEnterTimestamp);
        if (last) s.lastRun = last;
      }
      if (p.Result) s.result = p.Result;
      const exitCode = parseNum(p.ExecMainStatus);
      if (exitCode !== undefined && (state === "failed" || job)) s.exitCode = exitCode;
      const pid = parseNum(p.MainPID);
      if (pid) s.pid = pid;
      const restarts = parseNum(p.NRestarts);
      if (restarts !== undefined) s.restarts = restarts;
      const mem = parseNum(p.MemoryCurrent);
      if (mem !== undefined && state !== "inactive") s.mem = mem;
      const tasks = parseNum(p.TasksCurrent);
      if (tasks !== undefined && state !== "inactive") s.tasks = tasks;
      const cpuNs = parseNum(p.CPUUsageNSec);
      if (cpuNs !== undefined) {
        const prev = this.cpuPrev.get(key);
        if (prev && cpuNs >= prev.ns && now > prev.at && state === "running") {
          s.cpu = Math.round(((cpuNs - prev.ns) / ((now - prev.at) * 1e6)) * 10000) / 100;
        } else if (state === "running") s.cpu = 0;
        this.cpuPrev.set(key, { ns: cpuNs, at: now });
      }
      const cwd = cleanWorkingDir(p.WorkingDirectory);
      if (cwd) s.cwd = cwd;
      if (argv.length) {
        s.exec = redactArgv(argv);
        s.argv = argv;
      }
      if (p.ControlGroup) s.cgroup = p.ControlGroup;
      out.push(s);
    }
    // не держим память по исчезнувшим юнитам
    if (this.cpuPrev.size > out.length * 2 + 100) {
      const live = new Set(out.map((s) => s.key));
      for (const k of this.cpuPrev.keys()) if (!live.has(k)) this.cpuPrev.delete(k);
    }
    return out;
  }
}
