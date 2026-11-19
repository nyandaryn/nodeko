import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { hubPublicKey } from "../identity.ts";
import { hubWsUrl } from "../servers.ts";
import { getSettings } from "../settings.ts";

/**
 * Установка агента: `curl -fsSL <hub>/install/agent.sh | sh -s -- --server <id> --token <токен>`.
 * Скрипт содержит закреплённый ключ хаба и sha256 бинарей; бинари не секретны.
 */
interface Manifest {
  version: string;
  sha256: { x64: string; arm64: string };
}

function manifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.agentDist, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export async function installRoute(url: URL): Promise<Response> {
  const name = url.pathname.slice("/install/".length);
  if (name === "agent.sh") {
    const m = manifest();
    if (!m || !fs.existsSync(config.installTemplate)) return new Response("агент не собран на хабе: bun run build:agent\n", { status: 503 });
    const script = fs
      .readFileSync(config.installTemplate, "utf8")
      .replaceAll("__HUB_URL__", getSettings().publicUrl)
      .replaceAll("__HUB_WS__", hubWsUrl())
      .replaceAll("__HUB_KEY__", hubPublicKey)
      .replaceAll("__SHA_X64__", m.sha256.x64)
      .replaceAll("__SHA_ARM64__", m.sha256.arm64)
      .replaceAll("__VERSION__", m.version);
    return new Response(script, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
  }
  const bin = /^nodeko-agent-linux-(x64|arm64)$/.exec(name);
  if (bin) {
    const file = path.join(config.agentDist, name);
    if (!fs.existsSync(file)) return new Response("not found\n", { status: 404 });
    return new Response(Bun.file(file), {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` },
    });
  }
  return new Response("not found\n", { status: 404 });
}
