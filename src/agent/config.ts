/** Конфиг агента и его ключ. Файлы — 0600, каталоги — 0700. */
import fs from "node:fs";
import path from "node:path";
import { generateIdentity, identityFromPem, identityToPem, type Identity } from "../shared/secure.ts";
import { HOME, UID } from "./util.ts";

export interface AgentConfig {
  /** wss://…/agent */
  hub: string;
  /** base64url raw Ed25519 публичный ключ хаба (закреплён) */
  hubKey: string;
  /** id сервера на хабе */
  server: string;
  /** одноразовый токен регистрации; удаляется после успешной регистрации */
  enroll?: string;
  keyFile?: string;
  docker?: string;
  pm2?: { bin?: string; node?: string };
  /** только для root: пользователи, чьи user-юниты наблюдать */
  users?: string[];
}

export function defaultConfigPath(): string {
  return UID === 0 ? "/etc/nodeko-agent/agent.json" : path.join(HOME, ".config/nodeko-agent/agent.json");
}

export function defaultKeyFile(): string {
  return UID === 0 ? "/var/lib/nodeko-agent/agent.key" : path.join(HOME, ".local/share/nodeko-agent/agent.key");
}

export function loadConfig(file: string): AgentConfig {
  const raw = fs.readFileSync(file, "utf8");
  const c = JSON.parse(raw) as Partial<AgentConfig>;
  const errors: string[] = [];
  if (typeof c.hub !== "string" || !/^wss?:\/\//.test(c.hub)) errors.push("hub: ожидается ws(s)://…/agent");
  if (typeof c.hubKey !== "string" || Buffer.from(c.hubKey, "base64url").length !== 32) errors.push("hubKey: 32 байта base64url");
  if (typeof c.server !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(c.server)) errors.push("server: slug [a-z0-9-]");
  if (c.enroll !== undefined && typeof c.enroll !== "string") errors.push("enroll: строка");
  if (errors.length) throw new Error(`конфиг ${file}: ${errors.join("; ")}`);
  if (c.hub!.startsWith("ws://") && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(c.hub!)) {
    // шифрование канала всё равно есть, но без TLS проще мешать соединению — предупреждаем
    console.warn("[agent] WARN hub по ws:// не на localhost — канал зашифрован nodeko, но без TLS");
  }
  return c as AgentConfig;
}

/** Атомарно убрать enroll из конфига (после успешной регистрации). */
export function dropEnrollToken(file: string): void {
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!("enroll" in c)) return;
  delete c.enroll;
  writeSecure(file, `${JSON.stringify(c, null, 2)}\n`);
}

export function writeSecure(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Загрузить ключ агента или создать новый. */
export function loadOrCreateKey(file: string): { identity: Identity; created: boolean } {
  try {
    const pem = fs.readFileSync(file, "utf8");
    const st = fs.statSync(file);
    if (st.mode & 0o077) {
      fs.chmodSync(file, 0o600);
    }
    return { identity: identityFromPem(pem), created: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const identity = generateIdentity();
  writeSecure(file, identityToPem(identity));
  return { identity, created: true };
}
