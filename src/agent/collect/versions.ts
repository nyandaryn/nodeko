/**
 * Версии сервисов: package.json / release.json / git рабочей директории, рантайм (bun/node --version),
 * версия пакета системного бинаря (dpkg/rpm). Всё кэшируется — не чаще раза в 5 минут на сервис.
 */
import fs from "node:fs";
import path from "node:path";
import { exists, HOME, isExecutable, run } from "../util.ts";

export interface AppVersion {
  version?: string;
  commit?: string;
  commitAt?: number;
}

const TTL = 5 * 60_000;

// ---------- git ----------

/** packed-refs → карта ref → sha */
export function parsePackedRefs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const m = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function mtime(p: string): number | undefined {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Найти git-каталог для dir (обычный `.git/` или файл `.git` с `gitdir:`), вверх до limit уровней. */
export function findGitDir(dir: string, limit = 6): string | null {
  let cur = dir;
  for (let i = 0; i <= limit; i++) {
    const dotgit = path.join(cur, ".git");
    try {
      const st = fs.statSync(dotgit);
      if (st.isDirectory()) return dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFile(dotgit) ?? "");
        if (m) return path.resolve(cur, m[1]!.trim());
      }
    } catch {
      /* нет */
    }
    const up = path.dirname(cur);
    if (up === cur || cur === HOME) break;
    cur = up;
  }
  return null;
}

/** HEAD git-каталога → { sha, at } (at — mtime ref-файла как приближение времени коммита/деплоя). */
export function resolveHead(gitDir: string): { sha: string; at?: number } | null {
  const head = readFile(path.join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40,64}$/.test(head)) return { sha: head, at: mtime(path.join(gitDir, "HEAD")) };
  const m = /^ref:\s*(\S+)$/.exec(head);
  if (!m) return null;
  const ref = m[1]!;
  // у worktree общие refs лежат в commondir
  const common = readFile(path.join(gitDir, "commondir"))?.trim();
  const dirs = [gitDir, ...(common ? [path.resolve(gitDir, common)] : [])];
  for (const d of dirs) {
    const loose = path.join(d, ref);
    const sha = readFile(loose)?.trim();
    if (sha && /^[0-9a-f]{40,64}$/.test(sha)) return { sha, at: mtime(loose) };
  }
  for (const d of dirs) {
    const packedPath = path.join(d, "packed-refs");
    const packed = readFile(packedPath);
    if (!packed) continue;
    const sha = parsePackedRefs(packed).get(ref);
    if (sha) return { sha, at: mtime(path.join(d, "logs", ref)) ?? mtime(packedPath) };
  }
  return null;
}

// ---------- package.json / release.json ----------

function readJson(p: string): Record<string, unknown> | null {
  const t = readFile(p);
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function appVersionFromDir(dir: string): AppVersion {
  const out: AppVersion = {};
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return out;
  }
  let cur = real;
  for (let i = 0; i <= 4; i++) {
    if (cur === HOME || cur === "/") break;
    if (!out.version) {
      const pkg = readJson(path.join(cur, "package.json"));
      const v = pkg?.version;
      if (typeof v === "string" && v && v !== "0.0.0") out.version = v;
    }
    if (!out.commit) {
      for (const f of ["release.json", "RELEASE.json", "version.json", "build.json"]) {
        const rel = readJson(path.join(cur, f));
        if (!rel) continue;
        const c = rel.commit ?? rel.gitCommit ?? rel.sha ?? rel.revision;
        if (typeof c === "string" && /^[0-9a-f]{7,64}$/.test(c)) {
          out.commit = c.slice(0, 12);
          const at = rel.builtAt ?? rel.buildTime ?? rel.date;
          const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : NaN;
          if (Number.isFinite(t)) out.commitAt = t;
          if (!out.version && typeof rel.version === "string") out.version = rel.version;
          break;
        }
      }
    }
    if (out.version && out.commit) break;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (!out.commit) {
    const gd = findGitDir(real);
    const head = gd ? resolveHead(gd) : null;
    if (head) {
      out.commit = head.sha.slice(0, 12);
      if (head.at) out.commitAt = Math.round(head.at);
    }
  }
  return out;
}

/** Каталоги-кандидаты: WorkingDirectory и каталог скрипта из argv (если это абсолютный путь к файлу). */
export function candidateDirs(cwd: string | undefined, argv: string[] | undefined): string[] {
  const dirs: string[] = [];
  for (const a of (argv ?? []).slice(1)) {
    if (a.startsWith("/") && /\.(ts|tsx|js|mjs|cjs|py)$/.test(a)) {
      dirs.push(path.dirname(a));
      break;
    }
  }
  if (cwd && cwd !== HOME && cwd !== "/") dirs.push(cwd);
  return dirs;
}

// ---------- рантайм / пакеты ----------

export function runtimeName(execPath: string): "bun" | "node" | "deno" | null {
  const b = path.basename(execPath);
  if (/^bun(-[\w.]+)?$/.test(b)) return "bun";
  if (/^node(js)?(\d+)?$/.test(b)) return "node";
  if (b === "deno") return "deno";
  return null;
}

/** `5:29.5.3-1~ubuntu.24.04~noble` → `29.5.3` (без эпохи и ревизии пакета). */
export function debianUpstream(v: string): string {
  const noEpoch = v.replace(/^\d+:/, "");
  const dash = noEpoch.lastIndexOf("-");
  return dash > 0 ? noEpoch.slice(0, dash) : noEpoch;
}

export function parseVersionOutput(out: string): string | null {
  const m = /v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out);
  return m ? m[1]! : null;
}

export class VersionResolver {
  private app = new Map<string, { at: number; v: AppVersion }>();
  private runtime = new Map<string, string | null>();
  private pkg = new Map<string, { at: number; v: string | null }>();
  private dpkg: boolean | null = null;
  private rpm: boolean | null = null;

  appVersion(cacheKey: string, cwd: string | undefined, argv: string[] | undefined): AppVersion {
    const now = Date.now();
    const c = this.app.get(cacheKey);
    if (c && now - c.at < TTL) return c.v;
    const out: AppVersion = {};
    for (const d of candidateDirs(cwd, argv)) {
      const v = appVersionFromDir(d);
      if (!out.version && v.version) out.version = v.version;
      if (!out.commit && v.commit) {
        out.commit = v.commit;
        if (v.commitAt) out.commitAt = v.commitAt;
      }
      if (out.version && out.commit) break;
    }
    this.app.set(cacheKey, { at: now, v: out });
    return out;
  }

  /** `bun 1.4.4` / `node 22.16.0` для интерпретаторов; кэш по пути+mtime. */
  async runtimeOf(execPath: string): Promise<string | null> {
    const kind = runtimeName(execPath);
    if (!kind || !execPath.startsWith("/")) return null;
    const key = `${execPath}@${mtime(execPath) ?? 0}`;
    if (this.runtime.has(key)) return this.runtime.get(key)!;
    let v: string | null = null;
    if (isExecutable(execPath)) {
      const r = await run([execPath, "--version"], { timeout: 5000, maxOutput: 4096 });
      const ver = r.code === 0 ? parseVersionOutput(r.stdout) : null;
      v = ver ? `${kind} ${ver}` : null;
    }
    this.runtime.set(key, v);
    return v;
  }

  /** Версия пакета, которому принадлежит бинарь (dpkg или rpm). Для бинарей из /home — null. */
  async packageVersion(execPath: string): Promise<string | null> {
    if (!execPath.startsWith("/") || execPath.startsWith(HOME) || execPath.startsWith("/home/")) return null;
    const now = Date.now();
    const c = this.pkg.get(execPath);
    if (c && now - c.at < TTL * 12) return c.v;
    let real = execPath;
    try {
      real = fs.realpathSync(execPath);
    } catch {
      /* как есть */
    }
    let v: string | null = null;
    if (this.dpkg === null) this.dpkg = exists("/usr/bin/dpkg-query");
    if (this.rpm === null) this.rpm = exists("/usr/bin/rpm");
    if (this.dpkg) {
      for (const p of real === execPath ? [real] : [real, execPath]) {
        const s = await run(["dpkg-query", "-S", p], { timeout: 5000, maxOutput: 8192 });
        const pkg = s.code === 0 ? /^([^:,\s]+)(?::[^:\s]+)?(?:,[^:]*)?:\s/.exec(s.stdout)?.[1] : undefined;
        if (!pkg) continue;
        const w = await run(["dpkg-query", "-W", "-f=${Version}", pkg], { timeout: 5000, maxOutput: 1024 });
        if (w.code === 0 && w.stdout.trim()) {
          v = debianUpstream(w.stdout.trim());
          break;
        }
      }
    } else if (this.rpm) {
      const r = await run(["rpm", "-qf", "--qf", "%{VERSION}", real], { timeout: 5000, maxOutput: 1024 });
      if (r.code === 0 && r.stdout.trim() && !r.stdout.includes("not owned")) v = r.stdout.trim();
    }
    this.pkg.set(execPath, { at: now, v });
    return v;
  }
}
