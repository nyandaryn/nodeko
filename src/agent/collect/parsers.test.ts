import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_PATTERN } from "../../shared/protocol.ts";
import { cleanLine, redactArgv } from "../util.ts";
import { imageTag, mapDockerState, parseCpuStatUsec } from "./docker.ts";
import { attribute, compilePattern, decodeMessage, isError } from "./journal.ts";
import { mapPm2State, parseJlist, pm2ToSample } from "./pm2.ts";
import { parseProcNetTcp } from "./ports.ts";
import {
  cpuPercent,
  isRealIface,
  parseCpuModel,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseOsRelease,
  parseProcStat,
  physicalDisks,
} from "./system.ts";
import { cleanWorkingDir, isDenied, isVendorPath, mapState, parseExecStart, parseNum, parseShow, parseUnixTs } from "./systemd.ts";
import { appVersionFromDir, candidateDirs, debianUpstream, parsePackedRefs, parseVersionOutput, resolveHead, runtimeName } from "./versions.ts";

describe("system", () => {
  test("/proc/stat", () => {
    const a = parseProcStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\nbtime 1792671988\n");
    const b = parseProcStat("cpu  150 0 150 850 50 0 0 0 0 0\n");
    expect(a.btime).toBe(1792671988);
    expect(a.cpu).toEqual({ total: 1000, idle: 800 });
    // за интервал: total +200, idle(+iowait) +100 → 50%
    expect(cpuPercent(a.cpu, b.cpu)).toBe(50);
    expect(cpuPercent(null, b.cpu)).toBe(0);
  });

  test("loadavg", () => {
    expect(parseLoadavg("0.38 0.63 0.78 1/673 3630513\n")).toEqual([0.38, 0.63, 0.78]);
  });

  test("meminfo", () => {
    const m = parseMeminfo(
      "MemTotal:        8125760 kB\nMemFree:  1000 kB\nMemAvailable:    3323732 kB\nBuffers:          210040 kB\nCached:          2295264 kB\nSwapCached:       678228 kB\nSwapTotal:      16777212 kB\nSwapFree:       14886892 kB\nSReclaimable: 100 kB\n",
    );
    expect(m.total).toBe(8125760 * 1024);
    expect(m.available).toBe(3323732 * 1024);
    expect(m.used).toBe((8125760 - 3323732) * 1024);
    expect(m.swapUsed).toBe((16777212 - 14886892) * 1024);
    expect(m.cached).toBe((2295264 + 210040 + 100) * 1024);
  });

  test("net/dev filters virtual interfaces", () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1790119508130 96513658    0    0    0     0          0         0 1790119508130 96513658    0    0    0     0       0          0
enp1s0: 2018487358447 981591721    0    0    0     0          0         0 1744732196269 593874786    0    0    0     0       0          0
br-0ee6f4f424be: 170877944 3254157    0    0    0     0          0         0 227262791 3300432    0    0    0     0       0          0
docker0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
vethccf6893: 216436142 3254157    0    0    0     0          0         0 227308737 3301087    0    0    0     0       0          0
`;
    const m = parseNetDev(text);
    expect([...m.keys()]).toEqual(["enp1s0"]);
    expect(m.get("enp1s0")).toEqual({ rx: 2018487358447, tx: 1744732196269 });
    expect(isRealIface("eth0")).toBe(true);
    expect(isRealIface("tailscale0")).toBe(false);
  });

  test("diskstats counts only physical disks", () => {
    const text = `   7       0 loop0 11 0 28 1 0 0 0 0 0 3 1 0 0 0 0 0 0
 253       0 vda 20409173 4189634 1037297333 4470126 37299048 31553778 1838925694 27480482 0 7213716 34018892
 253       2 vda2 20407371 4185549 1037207443 4469774 37299045 31553778 1838925684 27480482 0 8995806 33479761
  11       0 sr0 0 0 0 0 0 0 0 0 0 0 0`;
    const disks = physicalDisks(["loop0", "loop1", "sr0", "vda", "dm-0", "md0", "zram0"]);
    expect(disks).toEqual(["vda"]);
    expect(parseDiskstats(text, disks)).toEqual({ read: 1037297333 * 512, write: 1838925694 * 512 });
  });

  test("mounts: real fs only, root first, dedup by device", () => {
    const text = `sysfs /sys sysfs rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/sda15 /boot/efi vfat rw 0 0
/dev/mapper/luks-1 /home btrfs rw,subvol=/home 0 0
/dev/mapper/luks-1 / btrfs rw,subvol=/root 0 0
/dev/vdb1 /mnt/data\\040disk ext4 rw 0 0
overlay /var/lib/docker/rootfs/overlayfs/x overlay rw 0 0
/dev/vdc /var/lib/docker xfs rw 0 0
`;
    expect(parseMounts(text)).toEqual([
      { dev: "/dev/mapper/luks-1", mount: "/", fstype: "btrfs" },
      { dev: "/dev/vdb1", mount: "/mnt/data disk", fstype: "ext4" },
    ]);
  });

  test("cpu model incl. ARM", () => {
    expect(parseCpuModel("processor\t: 0\nmodel name\t: AMD EPYC-Rome Processor\n")).toBe("AMD EPYC-Rome Processor");
    expect(parseCpuModel("processor\t: 0\nCPU implementer\t: 0x41\nCPU architecture: 8\nCPU part\t: 0xd0c\n")).toBe("ARM Neoverse-N1");
  });

  test("os-release", () => {
    expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n')).toBe("Ubuntu 24.04.4 LTS");
  });
});

describe("systemd", () => {
  const SHOW = `Type=simple
MainPID=2637142
Result=success
NRestarts=0
ExecMainExitTimestamp=
ExecMainStatus=0
ExecStart={ path=/home/deploy/srv/shop/current/runtime/bun ; argv[]=/home/deploy/srv/shop/current/runtime/bun run --no-env-file /home/deploy/srv/shop/current/packages/api/src/index.ts ; ignore_errors=no ; start_time=[@1794856557] ; stop_time=[n/a] ; pid=2637142 ; code=(null) ; status=0/0 }
ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/shop-api.service
MemoryCurrent=1988923392
CPUUsageNSec=23353538986000
TasksCurrent=19
WorkingDirectory=/home/deploy/var/shop/prod
Id=shop-api.service
Description=Shop API
ActiveState=active
SubState=running
FragmentPath=/home/deploy/.config/systemd/user/shop-api.service
UnitFileState=enabled
ActiveEnterTimestamp=@1794856557
InactiveEnterTimestamp=@1794856557

Type=oneshot
MainPID=0
Result=success
NRestarts=0
ExecMainExitTimestamp=@1795053963
ExecMainStatus=0
ExecStart={ path=/home/deploy/shop/backup.sh ; argv[]=/home/deploy/shop/backup.sh ; ignore_errors=no ; start_time=[@1795053930] ; stop_time=[@1795053963] ; pid=3620882 ; code=exited ; status=0 }
ControlGroup=
MemoryCurrent=[not set]
CPUUsageNSec=30910976000
TasksCurrent=[not set]
WorkingDirectory=!/home/deploy
Id=shop-backup.service
Description=Run daily backup of shop DB
ActiveState=inactive
SubState=dead
FragmentPath=/home/deploy/.config/systemd/user/shop-backup.service
UnitFileState=static
ActiveEnterTimestamp=
InactiveEnterTimestamp=@1795053963
`;

  test("parseShow + fields", () => {
    const [api, backup] = parseShow(SHOW);
    expect(api!.Id).toBe("shop-api.service");
    expect(backup!.Id).toBe("shop-backup.service");
    expect(parseUnixTs(api!.ActiveEnterTimestamp)).toBe(1794856557000);
    expect(parseUnixTs("")).toBeUndefined();
    expect(parseNum(api!.MemoryCurrent)).toBe(1988923392);
    expect(parseNum(backup!.MemoryCurrent)).toBeUndefined();
    expect(parseNum("18446744073709551615")).toBeUndefined();
    expect(parseExecStart(api!.ExecStart)).toEqual([
      "/home/deploy/srv/shop/current/runtime/bun",
      "run",
      "--no-env-file",
      "/home/deploy/srv/shop/current/packages/api/src/index.ts",
    ]);
    expect(cleanWorkingDir(backup!.WorkingDirectory)).toBe("/home/deploy");
    expect(cleanWorkingDir("-/srv/app")).toBe("/srv/app");
    expect(mapState(api!, false)).toBe("running");
    expect(mapState(backup!, true)).toBe("exited");
  });

  test("states", () => {
    expect(mapState({ ActiveState: "activating", SubState: "auto-restart" }, false)).toBe("restarting");
    expect(mapState({ ActiveState: "activating", SubState: "start" }, false)).toBe("starting");
    expect(mapState({ ActiveState: "failed", SubState: "failed" }, false)).toBe("failed");
    expect(mapState({ ActiveState: "inactive", SubState: "dead" }, false)).toBe("inactive");
    expect(mapState({ ActiveState: "inactive", SubState: "dead" }, true)).toBe("inactive"); // задача ни разу не запускалась
    expect(mapState({ ActiveState: "active", SubState: "exited" }, false)).toBe("exited");
  });

  test("vendor/deny", () => {
    expect(isVendorPath("/usr/lib/systemd/system/caddy.service")).toBe(true);
    expect(isVendorPath("/lib/systemd/system/x.service")).toBe(true);
    expect(isVendorPath("/run/user/1000/systemd/transient/run-x.service")).toBe(true);
    expect(isVendorPath("/etc/systemd/system/beszel-agent.service")).toBe(false);
    expect(isVendorPath("/home/deploy/.config/systemd/user/shop-api.service")).toBe(false);
    for (const n of ["systemd-journald", "getty@tty1", "ssh", "dbus", "user@1000", "pipewire-pulse", "snap.lxd.daemon", "cron"])
      expect(isDenied(n)).toBe(true);
    for (const n of ["caddy", "crowdsec", "docker", "shop-api", "cloudflared", "beszel-agent", "pm2-deploy"]) expect(isDenied(n)).toBe(false);
  });
});

describe("journal", () => {
  test("attribution", () => {
    expect(attribute({ _SYSTEMD_UNIT: "user@1000.service", _SYSTEMD_USER_UNIT: "shop-api.service" })).toBe("systemd-user:shop-api");
    expect(attribute({ _SYSTEMD_UNIT: "user@1000.service", _SYSTEMD_USER_UNIT: "init.scope", USER_UNIT: "shop-api.service" })).toBe(
      "systemd-user:shop-api",
    );
    expect(attribute({ _SYSTEMD_UNIT: "init.scope", UNIT: "caddy.service" })).toBe("systemd:caddy");
    expect(attribute({ _SYSTEMD_UNIT: "caddy.service" })).toBe("systemd:caddy");
    expect(attribute({ _SYSTEMD_UNIT: "user@1000.service" })).toBeNull();
    expect(attribute({ _SYSTEMD_UNIT: "session-129.scope" })).toBeNull();
    expect(attribute({ CONTAINER_NAME: "pg" })).toBe("docker:pg");
  });

  test("message decoding", () => {
    expect(decodeMessage([104, 105])).toBe("hi");
    expect(decodeMessage(null)).toBe("");
    expect(cleanLine("\x1b[31mERROR\x1b[0m boom\r", 100)).toBe("ERROR boom");
    expect(cleanLine("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("error detection", () => {
    const re = compilePattern("");
    expect(re.source).toBe(DEFAULT_LOG_PATTERN);
    expect(isError(3, "anything", re)).toBe(true);
    expect(isError(6, "  errors: 0,", re)).toBe(false);
    expect(isError(6, "TypeError: x is undefined", re)).toBe(true); // ловится по \b\w*Error\b
    expect(isError(6, "Uncaught TypeError: x", re)).toBe(true); // …а uncaught ловит
    expect(isError(6, '  error: "JollyMaxError: boom"', re)).toBe(true);
    expect(isError(5, "shop-api.service: Main process exited, code=exited, status=1/FAILURE", re)).toBe(true);
    expect(isError(4, "shop-api.service: Failed with result 'exit-code'.", re)).toBe(true);
    expect(isError(6, '{"level":"error","msg":"db down"}', re)).toBe(true);
    expect(isError(6, "GET /api/health 200", re)).toBe(false);
    // невалидный regex от хаба → встроенный
    expect(compilePattern("(").source).toBe(DEFAULT_LOG_PATTERN);
    expect(compilePattern("boom").test("BOOM")).toBe(true);
  });
});

describe("docker", () => {
  test("image tag", () => {
    expect(imageTag("postgres:16")).toBe("16");
    expect(imageTag("ghcr.io/org/app")).toBe("latest");
    expect(imageTag("localhost:5000/app:1.2")).toBe("1.2");
    expect(imageTag("localhost:5000/app")).toBe("latest");
  });
  test("state", () => {
    expect(mapDockerState("running", 0)).toBe("running");
    expect(mapDockerState("exited", 137)).toBe("failed");
    expect(mapDockerState("exited", 0)).toBe("inactive");
    expect(mapDockerState("restarting", 1)).toBe("restarting");
  });
  test("cpu.stat", () => {
    expect(parseCpuStatUsec("usage_usec 123456\nuser_usec 1\n")).toBe(123456);
    expect(parseCpuStatUsec(null)).toBeUndefined();
  });
});

describe("pm2", () => {
  const JLIST = JSON.stringify([
    {
      pid: 1115972,
      name: "redirect.incognito",
      monit: { memory: 48635904, cpu: 0.5 },
      pm2_env: {
        status: "online",
        pm_uptime: 1794552654606,
        restart_time: 2,
        version: "N/A",
        versioning: { revision: "eef865d0e16a3e2434bb289973150285edcbdd1d" },
        pm_exec_path: "/home/deploy/redirect-bot/index.ts",
        exec_interpreter: "/home/deploy/.bun/bin/bun",
        autorestart: true,
        env: { BOT_TOKEN: "secret-value" },
        BOT_TOKEN: "secret-value",
      },
    },
  ]);

  test("jlist keeps only safe fields", () => {
    const [p] = parseJlist(`some warning\n${JLIST}`);
    expect(p!.name).toBe("redirect.incognito");
    expect(p!.version).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("secret-value");
    const s = pm2ToSample(p!);
    expect(s.state).toBe("running");
    expect(s.commit).toBe("eef865d0e16a");
    expect(s.restarts).toBe(2);
    expect(s.argvExec).toBe("/home/deploy/.bun/bin/bun");
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(mapPm2State("errored")).toBe("failed");
  });
});

describe("ports", () => {
  test("/proc/net/tcp LISTEN", () => {
    const text = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0FD7 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 123456 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1002        0 999 1 0000000000000000 20 4 30 10 -1`;
    expect([...parseProcNetTcp(text)]).toEqual([[123456, 4055]]);
  });
});

describe("versions", () => {
  test("packed-refs", () => {
    const m = parsePackedRefs(
      "# pack-refs with: peeled fully-peeled sorted\n334a5af0e03c538c67411e74d585cc7b438125da refs/heads/main\n^aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    );
    expect(m.get("refs/heads/main")).toBe("334a5af0e03c538c67411e74d585cc7b438125da");
  });

  test("git dir, worktree and release.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodeko-ver-"));
    try {
      // обычный репозиторий с packed-refs
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(repo, ".git/packed-refs"), "1111111111111111111111111111111111111111 refs/heads/main\n");
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "2.3.4" }));
      fs.mkdirSync(path.join(repo, "apps/api"), { recursive: true });
      expect(appVersionFromDir(path.join(repo, "apps/api"))).toMatchObject({ version: "2.3.4", commit: "111111111111" });

      // worktree: .git — файл с gitdir, refs в commondir
      const wt = path.join(tmp, "wt");
      const wtGit = path.join(repo, ".git/worktrees/wt");
      fs.mkdirSync(wtGit, { recursive: true });
      fs.mkdirSync(path.join(repo, ".git/refs/heads"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git/refs/heads/feature"), "2222222222222222222222222222222222222222\n");
      fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/feature\n");
      fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
      fs.mkdirSync(wt);
      fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
      expect(resolveHead(wtGit)?.sha).toBe("2222222222222222222222222222222222222222");
      expect(appVersionFromDir(wt).commit).toBe("222222222222");

      // релиз с release.json (как в типичном деплое) через симлинк current
      const rel = path.join(tmp, "releases/r1");
      fs.mkdirSync(path.join(rel, "packages/api/src"), { recursive: true });
      fs.writeFileSync(path.join(rel, "packages/api/package.json"), JSON.stringify({ version: "1.10.3" }));
      fs.writeFileSync(
        path.join(rel, "release.json"),
        JSON.stringify({ commit: "334a5af0e03c538c67411e74d585cc7b438125da", builtAt: "2026-11-15T19:14:13Z" }),
      );
      fs.symlinkSync(rel, path.join(tmp, "current"));
      const dirs = candidateDirs("/home/x/var", [`${tmp}/current/runtime/bun`, "run", `${tmp}/current/packages/api/src/index.ts`]);
      expect(dirs[0]).toBe(`${tmp}/current/packages/api/src`);
      expect(appVersionFromDir(dirs[0]!)).toEqual({ version: "1.10.3", commit: "334a5af0e03c", commitAt: Date.parse("2026-11-15T19:14:13Z") });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runtime and package version strings", () => {
    expect(runtimeName("/home/deploy/srv/shop/current/runtime/bun")).toBe("bun");
    expect(runtimeName("/home/deploy/.nvm/versions/node/v22.16.0/bin/node")).toBe("node");
    expect(runtimeName("/home/deploy/.nvm/versions/node/v22.16.0/bin/npm")).toBeNull();
    expect(parseVersionOutput("1.4.4\n")).toBe("1.4.4");
    expect(parseVersionOutput("v22.16.0\n")).toBe("22.16.0");
    expect(debianUpstream("5:29.5.3-1~ubuntu.24.04~noble")).toBe("29.5.3");
    expect(debianUpstream("2.10.2")).toBe("2.10.2");
  });
});

describe("redaction", () => {
  test("secrets in argv", () => {
    expect(redactArgv(["/usr/bin/cloudflared", "tunnel", "run", "--token", "eyJhIjoiYWJjIn0"])).toBe("/usr/bin/cloudflared tunnel run --token ***");
    expect(redactArgv(["app", "--api-key=abc", "--port=80"])).toBe("app --api-key=*** --port=80");
    expect(redactArgv(["app", "postgres://user:pw@db/x"])).toBe("app postgres://***@db/x");
    expect(redactArgv(["app", "A".repeat(40)])).toBe("app ***");
    expect(redactArgv(["bun", "run", "start"])).toBe("bun run start");
  });
});
