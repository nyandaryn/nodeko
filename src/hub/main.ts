import { startAgentPings } from "./agents.ts";
import { scheduleHubChecks } from "./checks.ts";
import { config, HUB_VERSION } from "./config.ts";
import { db } from "./db.ts";
import { hubFingerprint } from "./identity.ts";
import { log } from "./log.ts";
import { startMaintenance } from "./maintenance.ts";
import { startMonitor } from "./monitor.ts";
import { startHttp } from "./http/server.ts";
import { getSettings } from "./settings.ts";

log.info(`nodeko hub ${HUB_VERSION}`, { data: config.dataDir, publicUrl: getSettings().publicUrl, hubKey: hubFingerprint });

const server = startHttp();
startMonitor();
startMaintenance();
startAgentPings();
scheduleHubChecks();

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info(`остановка (${sig})`);
  server.stop(true);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
