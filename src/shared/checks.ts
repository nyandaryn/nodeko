/**
 * Выполнение HTTP/TCP-проверок — общий код хаба (проверки «снаружи») и агента («изнутри» сервера).
 * Возвращает только код/задержку/ошибку — тело ответа никуда не уходит.
 */
import net from "node:net";
import tls from "node:tls";
import type { CheckDef, CheckResult } from "./protocol.ts";

const MAX_BODY_SCAN = 1024 * 1024;
const UA = "nodeko-check/1.0";

export function parseExpect(expect: string | null | undefined): (code: number) => boolean {
  const spec = (expect ?? "").trim();
  if (!spec) return (c) => c >= 200 && c < 400;
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) throw new Error(`неверный формат кодов: ${p}`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return [Math.min(a, b), Math.max(a, b)] as const;
  });
  return (c) => ranges.some(([a, b]) => c >= a && c <= b);
}

export function validateCheckTarget(type: CheckDef["type"], target: string): string | null {
  if (type === "http") {
    try {
      const u = new URL(target);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "только http:// или https://";
      return null;
    } catch {
      return "неверный URL";
    }
  }
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return "ожидается host:port";
  return null;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    if (e.name === "TimeoutError" || e.name === "AbortError") return "таймаут";
    return (code ? `${code}: ` : "") + e.message.slice(0, 300);
  }
  return String(e).slice(0, 300);
}

export async function runHttpCheck(c: CheckDef): Promise<CheckResult> {
  const started = performance.now();
  const t = Date.now();
  try {
    const res = await fetch(c.target, {
      method: c.method ?? "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(c.timeout),
      headers: { "user-agent": UA, accept: "*/*" },
      tls: c.insecure ? { rejectUnauthorized: false } : undefined,
    } as RequestInit);
    let ok = parseExpect(c.expect)(res.status);
    let err: string | undefined;
    if (!ok) err = `HTTP ${res.status}`;
    if (ok && c.keyword && c.method !== "HEAD") {
      const body = await readCapped(res, MAX_BODY_SCAN);
      if (!body.includes(c.keyword)) {
        ok = false;
        err = "ключевое слово не найдено";
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    const ms = Math.round(performance.now() - started);
    return { id: c.id, t, ok, code: res.status, ms, ...(err ? { err } : {}) };
  } catch (e) {
    return { id: c.id, t, ok: false, ms: Math.round(performance.now() - started), err: errText(e) };
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

export function runTcpCheck(c: CheckDef): Promise<CheckResult> {
  const t = Date.now();
  const started = performance.now();
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(c.target);
  if (!m) return Promise.resolve({ id: c.id, t, ok: false, err: "ожидается host:port" });
  return new Promise((resolve) => {
    const sock = net.connect({ host: m[1], port: Number(m[2]) });
    const done = (r: CheckResult) => {
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ id: c.id, t, ok: false, err: "таймаут", ms: c.timeout }), c.timeout);
    sock.once("connect", () => {
      clearTimeout(timer);
      done({ id: c.id, t, ok: true, ms: Math.round(performance.now() - started) });
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      done({ id: c.id, t, ok: false, err: errText(e), ms: Math.round(performance.now() - started) });
    });
  });
}

export function runCheck(c: CheckDef): Promise<CheckResult> {
  return c.type === "tcp" ? runTcpCheck(c) : runHttpCheck(c);
}

/** Срок действия TLS-сертификата https-цели (ms epoch) или null. */
export function tlsCertExpiry(target: string, timeout = 8000): Promise<number | null> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return Promise.resolve(null);
  }
  if (u.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const sock = tls.connect({
      host: u.hostname,
      port: Number(u.port || 443),
      servername: u.hostname,
      rejectUnauthorized: false,
    });
    const finish = (v: number | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeout);
    sock.once("secureConnect", () => {
      try {
        const cert = sock.getPeerCertificate();
        const v = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
        finish(Number.isFinite(v) ? v : null);
      } catch {
        finish(null);
      }
    });
    sock.once("error", () => finish(null));
  });
}

/** TCP-connect задержка до host:port, ms (для метрики «интернет»). */
export async function tcpPing(target: string, timeout = 3000): Promise<number | null> {
  const r = await runTcpCheck({ id: 0, type: "tcp", target, interval: 0, timeout });
  return r.ok ? (r.ms ?? null) : null;
}
