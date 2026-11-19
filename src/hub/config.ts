import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const env = process.env;

export const HUB_VERSION = "1.0.0";

export const config = {
  root,
  dataDir: path.resolve(env.NODEKO_DATA ?? path.join(os.homedir(), ".local/share/nodeko")),
  host: env.NODEKO_HOST ?? "127.0.0.1",
  port: Number(env.NODEKO_PORT ?? 4170),
  /** начальное значение publicUrl (дальше — настройка в БД) */
  publicUrl: (env.NODEKO_PUBLIC_URL ?? "http://localhost:4170").replace(/\/+$/, ""),
  production: env.NODE_ENV === "production",
  webDist: path.resolve(env.NODEKO_WEB_DIST ?? path.join(root, "web/dist")),
  agentDist: path.resolve(env.NODEKO_AGENT_DIST ?? path.join(root, "dist/agent")),
  installTemplate: path.resolve(env.NODEKO_INSTALL_TEMPLATE ?? path.join(root, "deploy/agent/install.sh")),
  /** дополнительные разрешённые Origin для dev (через запятую) */
  devOrigins: (env.NODEKO_DEV_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
