import crypto from "node:crypto";
import type { SessionItem, TokenCreated, TokenItem, TokenScope } from "../../shared/api.ts";
import { b64u, safeEqual, sha256 } from "../../shared/secure.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";

// ---------- пользователи ----------

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  webauthn_id: Uint8Array;
  created_at: number;
}

export function getUser(id: number): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function userByName(username: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | null;
}

export function userCount(): number {
  return (db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n;
}

export function validatePassword(p: string): string | null {
  if (typeof p !== "string" || p.length < 10) return "пароль — минимум 10 символов";
  if (p.length > 256) return "пароль слишком длинный";
  return null;
}

export async function createUser(username: string, password: string): Promise<UserRow> {
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw new Error("логин: латиница/цифры/._-, 2..32");
  const err = validatePassword(password);
  if (err) throw new Error(err);
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  return db
    .query("INSERT INTO users(username, password_hash, webauthn_id, created_at) VALUES(?, ?, ?, ?) RETURNING *")
    .get(username, hash, crypto.randomBytes(32), Date.now()) as UserRow;
}

export async function setPassword(userId: number, password: string): Promise<void> {
  const err = validatePassword(password);
  if (err) throw new Error(err);
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
}

// хэш-пустышка для выравнивания времени ответа при несуществующем логине
const DUMMY = await Bun.password.hash(crypto.randomBytes(16).toString("hex"), { algorithm: "argon2id" });

export async function verifyLogin(username: string, password: string): Promise<UserRow | null> {
  const u = typeof username === "string" && username.length <= 64 ? userByName(username) : null;
  const ok = await Bun.password.verify(typeof password === "string" ? password.slice(0, 256) : "", u?.password_hash ?? DUMMY);
  return u && ok ? u : null;
}

// ---------- сессии ----------

export const SESSION_COOKIE = config.production ? "__Host-nodeko" : "nodeko_sid";
const IDLE = 30 * 86_400_000;
const ABSOLUTE = 90 * 86_400_000;

export interface SessionRow {
  id: string;
  token_hash: Uint8Array;
  user_id: number;
  method: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export function createSession(userId: number, method: string, ip: string | null, ua: string | null): { token: string; row: SessionRow } {
  const token = b64u.enc(crypto.randomBytes(32));
  const id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const row = db
    .query(
      "INSERT INTO sessions(id, token_hash, user_id, method, created_at, last_seen, expires_at, ip, user_agent) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(id, sha256(token), userId, method, now, now, now + IDLE, ip, ua?.slice(0, 300) ?? null) as SessionRow;
  return { token, row };
}

export function sessionByToken(token: string): SessionRow | null {
  if (!token || token.length > 100) return null;
  const row = db.query("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token)) as SessionRow | null;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || now - row.created_at > ABSOLUTE) {
    db.query("DELETE FROM sessions WHERE id = ?").run(row.id);
    return null;
  }
  if (now - row.last_seen > 10 * 60_000) {
    db.query("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?").run(now, now + IDLE, row.id);
  }
  return row;
}

export function deleteSession(id: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(id);
}

export function listSessions(currentId: string | null): SessionItem[] {
  return (db.query("SELECT * FROM sessions ORDER BY last_seen DESC").all() as SessionRow[]).map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    ip: s.ip,
    userAgent: s.user_agent,
    current: s.id === currentId,
    method: s.method,
  }));
}

export function sessionCookie(token: string, maxAgeSec = IDLE / 1000): string {
  const secure = config.production ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeSec)}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = config.production ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ---------- API-токены: nk_<12 hex id>_<43 base64url secret> ----------

interface TokenRow {
  id: string;
  name: string;
  scope: TokenScope;
  secret_hash: Uint8Array;
  hint: string;
  created_at: number;
  last_used: number | null;
}

const toItem = (r: TokenRow): TokenItem => ({ id: r.id, name: r.name, scope: r.scope, createdAt: r.created_at, lastUsed: r.last_used, hint: r.hint });

export function createToken(name: string, scope: TokenScope): TokenCreated {
  const n = String(name ?? "").trim().slice(0, 60);
  if (!n) throw new Error("name: пустое имя");
  if (scope !== "read" && scope !== "admin") throw new Error("scope: read или admin");
  const id = crypto.randomBytes(6).toString("hex");
  const secret = b64u.enc(crypto.randomBytes(32));
  const row = db
    .query("INSERT INTO api_tokens(id, name, scope, secret_hash, hint, created_at) VALUES(?, ?, ?, ?, ?, ?) RETURNING *")
    .get(id, n, scope, sha256(secret), secret.slice(-4), Date.now()) as TokenRow;
  return { ...toItem(row), token: `nk_${id}_${secret}` };
}

export function listTokens(): TokenItem[] {
  return (db.query("SELECT * FROM api_tokens ORDER BY created_at DESC").all() as TokenRow[]).map(toItem);
}

export function deleteToken(id: string): boolean {
  return db.query("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
}

export function verifyToken(raw: string): { id: string; name: string; scope: TokenScope } | null {
  const m = /^nk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!m) return null;
  const row = db.query("SELECT * FROM api_tokens WHERE id = ?").get(m[1]!) as TokenRow | null;
  if (!row || !safeEqual(row.secret_hash, sha256(m[2]!))) return null;
  const now = Date.now();
  if (!row.last_used || now - row.last_used > 60_000) db.query("UPDATE api_tokens SET last_used = ? WHERE id = ?").run(now, row.id);
  return { id: row.id, name: row.name, scope: row.scope };
}

// ---------- лимиты попыток входа ----------

const attempts = new Map<string, number[]>();
let globalFails: number[] = [];
const WINDOW = 15 * 60_000;

export function loginBlocked(ip: string): number | null {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW);
  globalFails = globalFails.filter((t) => now - t < WINDOW);
  if (list.length) attempts.set(ip, list);
  else attempts.delete(ip);
  if (list.length >= 8) return Math.ceil((list[0]! + WINDOW - now) / 1000);
  if (globalFails.length >= 40) return Math.ceil((globalFails[0]! + WINDOW - now) / 1000);
  return null;
}

export function loginFailed(ip: string): void {
  const now = Date.now();
  attempts.set(ip, [...(attempts.get(ip) ?? []), now]);
  globalFails.push(now);
}

export function loginSucceeded(ip: string): void {
  attempts.delete(ip);
}
