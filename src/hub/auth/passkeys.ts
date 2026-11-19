import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import crypto from "node:crypto";
import type { PasskeyItem } from "../../shared/api.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { getSettings } from "../settings.ts";
import { getUser, type UserRow } from "./core.ts";

interface PasskeyRow {
  id: string;
  user_id: number;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used: number | null;
}

export class PasskeyError extends Error {}

/** RP ID и допустимые Origin выводятся из publicUrl (в dev — ещё и из dev-origin'ов). */
function rp() {
  const pub = new URL(getSettings().publicUrl);
  const origins = [pub.origin];
  if (!config.production) origins.push(...config.devOrigins);
  return { rpID: pub.hostname, origins };
}

// одноразовые челленджи, 5 минут
const challenges = new Map<string, { challenge: string; kind: "reg" | "auth"; userId?: number; exp: number }>();

function putChallenge(v: { challenge: string; kind: "reg" | "auth"; userId?: number }): string {
  const now = Date.now();
  for (const [k, c] of challenges) if (c.exp < now) challenges.delete(k);
  if (challenges.size > 500) challenges.delete(challenges.keys().next().value!);
  const id = crypto.randomBytes(16).toString("hex");
  challenges.set(id, { ...v, exp: now + 5 * 60_000 });
  return id;
}

function takeChallenge(id: string, kind: "reg" | "auth") {
  const c = typeof id === "string" ? challenges.get(id) : undefined;
  if (c) challenges.delete(id);
  if (!c || c.kind !== kind || c.exp < Date.now()) throw new PasskeyError("запрос устарел — попробуйте ещё раз");
  return c;
}

const toItem = (r: PasskeyRow): PasskeyItem => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastUsed: r.last_used,
  deviceType: r.device_type,
  backedUp: !!r.backed_up,
});

export function listPasskeys(): PasskeyItem[] {
  return (db.query("SELECT * FROM passkeys ORDER BY created_at").all() as PasskeyRow[]).map(toItem);
}

export function passkeyCount(): number {
  return (db.query("SELECT count(*) AS n FROM passkeys").get() as { n: number }).n;
}

export function renamePasskey(id: string, name: string): PasskeyItem {
  const n = String(name ?? "").trim().slice(0, 60);
  if (!n) throw new PasskeyError("пустое имя");
  const r = db.query("UPDATE passkeys SET name = ? WHERE id = ? RETURNING *").get(n, id) as PasskeyRow | null;
  if (!r) throw new PasskeyError("нет такого ключа");
  return toItem(r);
}

export function deletePasskey(id: string): boolean {
  return db.query("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
}

export async function registrationOptions(user: UserRow) {
  const { rpID } = rp();
  const existing = db.query("SELECT id, transports FROM passkeys WHERE user_id = ?").all(user.id) as Pick<PasskeyRow, "id" | "transports">[];
  const options = await generateRegistrationOptions({
    rpName: "nodeko",
    rpID,
    userName: user.username,
    userDisplayName: user.username,
    userID: new Uint8Array(user.webauthn_id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return { challengeId: putChallenge({ challenge: options.challenge, kind: "reg", userId: user.id }), options };
}

export async function registrationVerify(user: UserRow, challengeId: string, response: RegistrationResponseJSON, name: string): Promise<PasskeyItem> {
  const c = takeChallenge(challengeId, "reg");
  if (c.userId !== user.id) throw new PasskeyError("запрос от другого пользователя");
  const { rpID, origins } = rp();
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    throw new PasskeyError(`passkey не принят: ${e instanceof Error ? e.message : e}`);
  }
  if (!v.verified || !v.registrationInfo) throw new PasskeyError("passkey не подтверждён");
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const row = db
    .query(
      `INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, device_type, backed_up, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      credential.id,
      user.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      String(name ?? "").trim().slice(0, 60) || "Passkey",
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      Date.now(),
    ) as PasskeyRow;
  return toItem(row);
}

export async function authenticationOptions() {
  const { rpID } = rp();
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  return { challengeId: putChallenge({ challenge: options.challenge, kind: "auth" }), options };
}

export async function authenticationVerify(challengeId: string, response: AuthenticationResponseJSON): Promise<UserRow> {
  const c = takeChallenge(challengeId, "auth");
  const row = typeof response?.id === "string" ? (db.query("SELECT * FROM passkeys WHERE id = ?").get(response.id) as PasskeyRow | null) : null;
  if (!row) throw new PasskeyError("этот passkey не зарегистрирован");
  const { rpID, origins } = rp();
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    throw new PasskeyError(`passkey не принят: ${e instanceof Error ? e.message : e}`);
  }
  if (!v.verified) throw new PasskeyError("passkey не подтверждён");
  db.query("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?").run(v.authenticationInfo.newCounter, Date.now(), row.id);
  const user = getUser(row.user_id);
  if (!user) throw new PasskeyError("пользователь не найден");
  return user;
}
