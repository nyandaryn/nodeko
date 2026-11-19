import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { b64u, fingerprint, generateIdentity, identityFromPem, identityToPem, rawPublic, type Identity } from "../shared/secure.ts";

/** Долговременный Ed25519-ключ хаба: data/hub.key (0600). Его публичная часть закрепляется в агентах. */
function load(): Identity {
  const file = path.join(config.dataDir, "hub.key");
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return identityFromPem(fs.readFileSync(file, "utf8"));
  const id = generateIdentity();
  fs.writeFileSync(file, identityToPem(id), { mode: 0o600, flag: "wx" });
  return id;
}

export const hubIdentity = load();
export const hubPublicRaw = rawPublic(hubIdentity.publicKey);
export const hubPublicKey = b64u.enc(hubPublicRaw);
export const hubFingerprint = fingerprint(hubPublicRaw);
