/**
 * Защищённый канал агент ↔ хаб поверх WebSocket — не зависит от TLS (Cloudflare его терминирует).
 *
 * Схема (SIGMA-подобная, взаимная аутентификация + forward secrecy):
 *   1. агент → хаб  hs1 { agentKey(Ed25519 pub), eph(X25519 pub), nonce }
 *   2. хаб → агент  hs2 { eph, nonce, sig = Sign_hub(T("hub")) }
 *      агент проверяет подпись ЗАКРЕПЛЁННЫМ публичным ключом хаба (из конфига агента) — MITM невозможен.
 *   3. обе стороны: dh = X25519(eph, peerEph); ключи = HKDF-SHA256(dh, salt=nonceA‖nonceH, info="nodeko/1 keys"‖T)
 *   4. агент → хаб  первый ЗАШИФРОВАННЫЙ кадр { t:"auth", sig = Sign_agent(T("agent")), server, enroll? }
 *      хаб проверяет подпись и что ключ агента привязан к серверу (или валиден одноразовый токен регистрации).
 * Транскрипт T(role) = SHA-256("nodeko/1" ‖ role ‖ agentKey ‖ ephA ‖ nonceA ‖ ephH ‖ nonceH ‖ hubKey).
 *
 * Кадр: [flags:1][counter:8 BE][AES-256-GCM ciphertext ‖ tag:16], nonce GCM = 0x00000000 ‖ counter,
 * AAD = flags ‖ counter. Счётчик строго +1 на каждый кадр в каждом направлении — повтор, пропуск или
 * перестановка кадра рвут соединение. flags bit0 = полезная нагрузка сжата deflate-raw.
 */
import crypto, { type KeyObject } from "node:crypto";

const PROTO = "nodeko/1";

export const b64u = {
  enc: (b: Uint8Array): string => Buffer.from(b).toString("base64url"),
  dec: (s: string): Buffer => Buffer.from(s, "base64url"),
};

export interface Identity {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function generateIdentity(): Identity {
  return crypto.generateKeyPairSync("ed25519");
}

export function identityToPem(id: Identity): string {
  return String(id.privateKey.export({ format: "pem", type: "pkcs8" }));
}

export function identityFromPem(pem: string): Identity {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("ключ не Ed25519");
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

/** raw 32 байта публичного ключа (Ed25519 или X25519) */
export function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("не OKP-ключ");
  return b64u.dec(jwk.x);
}

function okpPublic(raw: Uint8Array, crv: "Ed25519" | "X25519"): KeyObject {
  if (raw.length !== 32) throw new Error(`неверная длина ключа ${crv}`);
  return crypto.createPublicKey({ key: { kty: "OKP", crv, x: b64u.enc(raw) }, format: "jwk" });
}

export const ed25519Public = (raw: Uint8Array) => okpPublic(raw, "Ed25519");

/** Короткий отпечаток ключа для людей: первые 16 hex SHA-256, группами по 4. */
export function fingerprint(raw: Uint8Array): string {
  const h = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return h.match(/.{4}/g)!.join(":");
}

function transcript(
  role: "hub" | "agent",
  p: { agentKey: Buffer; ephA: Buffer; nonceA: Buffer; ephH: Buffer; nonceH: Buffer; hubKey: Buffer },
): Buffer {
  return crypto
    .createHash("sha256")
    .update(PROTO)
    .update(role)
    .update(p.agentKey)
    .update(p.ephA)
    .update(p.nonceA)
    .update(p.ephH)
    .update(p.nonceH)
    .update(p.hubKey)
    .digest();
}

function deriveKeys(dh: Buffer, nonceA: Buffer, nonceH: Buffer, th: Buffer) {
  const okm = Buffer.from(
    crypto.hkdfSync("sha256", dh, Buffer.concat([nonceA, nonceH]), Buffer.concat([Buffer.from(`${PROTO} keys`), th]), 64),
  );
  return { a2h: okm.subarray(0, 32), h2a: okm.subarray(32, 64) };
}

/** Шифрованный дуплекс. Не потокобезопасен (и не нужно: JS однопоточный). */
export class SecureChannel {
  private sendCtr = 0n;
  private recvCtr = 0n;

  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {}

  seal(obj: unknown): Uint8Array {
    let payload: Buffer = Buffer.from(JSON.stringify(obj));
    let flags = 0;
    if (payload.length > 1024) {
      payload = Buffer.from(Bun.deflateSync(payload as Uint8Array<ArrayBuffer>));
      flags |= 1;
    }
    const head = Buffer.alloc(9);
    head[0] = flags;
    head.writeBigUInt64BE(this.sendCtr, 1);
    const iv = Buffer.alloc(12);
    head.copy(iv, 4, 1, 9);
    const c = crypto.createCipheriv("aes-256-gcm", this.sendKey, iv);
    c.setAAD(head);
    const ct = Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
    this.sendCtr++;
    return Buffer.concat([head, ct]);
  }

  open(frame: Uint8Array, maxBytes: number): unknown {
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    if (buf.length < 9 + 16) throw new Error("кадр слишком короткий");
    const flags = buf[0]!;
    const ctr = buf.readBigUInt64BE(1);
    if (ctr !== this.recvCtr) throw new Error("нарушен порядок кадров (повтор или пропуск)");
    const head = buf.subarray(0, 9);
    const iv = Buffer.alloc(12);
    head.copy(iv, 4, 1, 9);
    const d = crypto.createDecipheriv("aes-256-gcm", this.recvKey, iv);
    d.setAAD(head);
    d.setAuthTag(buf.subarray(buf.length - 16));
    let payload = Buffer.concat([d.update(buf.subarray(9, buf.length - 16)), d.final()]);
    this.recvCtr++;
    if (flags & 1) {
      // защита от deflate-бомбы: проверяем размер после распаковки
      payload = Buffer.from(Bun.inflateSync(payload));
      if (payload.length > maxBytes * 8) throw new Error("кадр слишком большой после распаковки");
    }
    return JSON.parse(payload.toString("utf8"));
  }
}

// ---------- сторона агента ----------

export interface AgentHandshake {
  hs1: { t: "hs1"; v: 1; agentKey: string; eph: string; nonce: string };
  finish(
    hs2: { eph: string; nonce: string; sig: string },
    auth: { server: string; enroll?: string; agentVersion: string },
  ): { channel: SecureChannel; authFrame: Uint8Array };
}

export function agentHandshake(identity: Identity, pinnedHubKey: Uint8Array): AgentHandshake {
  const eph = crypto.generateKeyPairSync("x25519");
  const ephA = rawPublic(eph.publicKey);
  const nonceA = crypto.randomBytes(32);
  const agentKey = rawPublic(identity.publicKey);
  const hubKey = Buffer.from(pinnedHubKey);
  return {
    hs1: { t: "hs1", v: 1, agentKey: b64u.enc(agentKey), eph: b64u.enc(ephA), nonce: b64u.enc(nonceA) },
    finish(hs2, auth) {
      const ephH = b64u.dec(hs2.eph);
      const nonceH = b64u.dec(hs2.nonce);
      if (nonceH.length !== 32) throw new Error("hs2: неверный nonce");
      const p = { agentKey, ephA, nonceA, ephH, nonceH, hubKey };
      const ok = crypto.verify(null, transcript("hub", p), ed25519Public(hubKey), b64u.dec(hs2.sig));
      if (!ok) throw new Error("подпись хаба не сходится с закреплённым ключом — возможна подмена хаба");
      const dh = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: okpPublic(ephH, "X25519") });
      const keys = deriveKeys(dh, nonceA, nonceH, transcript("hub", p));
      const channel = new SecureChannel(keys.a2h, keys.h2a);
      const sig = crypto.sign(null, transcript("agent", p), identity.privateKey);
      const authFrame = channel.seal({ t: "auth", sig: b64u.enc(sig), ...auth });
      return { channel, authFrame };
    },
  };
}

// ---------- сторона хаба ----------

export interface HubHandshake {
  hs2: { t: "hs2"; eph: string; nonce: string; sig: string };
  agentKey: Buffer;
  channel: SecureChannel;
  /** проверить подпись агента из кадра auth */
  verifyAgent(sigB64: string): boolean;
}

export function hubHandshake(
  identity: Identity,
  hs1: { v: number; agentKey: string; eph: string; nonce: string },
): HubHandshake {
  if (hs1.v !== 1) throw new Error("неподдерживаемая версия протокола");
  const agentKey = b64u.dec(hs1.agentKey);
  const ephA = b64u.dec(hs1.eph);
  const nonceA = b64u.dec(hs1.nonce);
  if (agentKey.length !== 32 || ephA.length !== 32 || nonceA.length !== 32) throw new Error("hs1: неверные длины");
  const eph = crypto.generateKeyPairSync("x25519");
  const ephH = rawPublic(eph.publicKey);
  const nonceH = crypto.randomBytes(32);
  const hubKey = rawPublic(identity.publicKey);
  const p = { agentKey, ephA, nonceA, ephH, nonceH, hubKey };
  const thHub = transcript("hub", p);
  const sig = crypto.sign(null, thHub, identity.privateKey);
  const dh = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: okpPublic(ephA, "X25519") });
  const keys = deriveKeys(dh, nonceA, nonceH, thHub);
  const agentPub = ed25519Public(agentKey);
  return {
    hs2: { t: "hs2", eph: b64u.enc(ephH), nonce: b64u.enc(nonceH), sig: b64u.enc(sig) },
    agentKey,
    channel: new SecureChannel(keys.h2a, keys.a2h),
    verifyAgent(sigB64) {
      try {
        return crypto.verify(null, transcript("agent", p), agentPub, b64u.dec(sigB64));
      } catch {
        return false;
      }
    },
  };
}

/** Сравнение секретов за постоянное время. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sha256(data: string | Uint8Array): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

export function randomToken(bytes = 32): string {
  return b64u.enc(crypto.randomBytes(bytes));
}
