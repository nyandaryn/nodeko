import { db, metaGet, metaSet } from "./db.ts";
import { errMsg, log } from "./log.ts";
import { getSettings } from "./settings.ts";

/**
 * Агрегация метрик: tier0 (сырые) → tier1 (1 мин) → tier2 (15 мин), только завершённые интервалы.
 * Удаление старого по настройкам хранения.
 */
function rollup(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const s = getSettings();

  // tier0 → tier1
  const end1 = Math.floor(nowSec / 60) * 60;
  const start1 = Number(metaGet("rollup1") ?? end1 - s.retention.rawHours * 3600);
  if (end1 > start1) {
    db.transaction(() => {
      db.query(
        `INSERT OR REPLACE INTO m_server(server_id, tier, ts, cpu, cpu_max, mem, mem_used, swap_used, disk, disk_read, disk_write, net_rx, net_tx, load1, ping, n)
         SELECT server_id, 1, (ts / 60) * 60 AS b, avg(cpu), max(coalesce(cpu_max, cpu)), avg(mem), avg(mem_used), avg(swap_used), avg(disk),
                avg(disk_read), avg(disk_write), avg(net_rx), avg(net_tx), avg(load1), avg(ping), count(*)
         FROM m_server WHERE tier = 0 AND ts >= ? AND ts < ? GROUP BY server_id, b`,
      ).run(start1, end1);
      db.query(
        `INSERT OR REPLACE INTO m_service(service_id, tier, ts, cpu, cpu_max, mem, mem_max, n)
         SELECT service_id, 1, (ts / 60) * 60 AS b, avg(cpu), max(coalesce(cpu_max, cpu)), avg(mem), max(coalesce(mem_max, mem)), count(*)
         FROM m_service WHERE tier = 0 AND ts >= ? AND ts < ? GROUP BY service_id, b`,
      ).run(start1, end1);
      metaSet("rollup1", String(end1));
    })();
  }

  // tier1 → tier2 (по уже свёрнутым минутам)
  const end2 = Math.floor(end1 / 900) * 900;
  const start2 = Number(metaGet("rollup2") ?? end2 - s.retention.minuteDays * 86400);
  if (end2 > start2) {
    db.transaction(() => {
      db.query(
        `INSERT OR REPLACE INTO m_server(server_id, tier, ts, cpu, cpu_max, mem, mem_used, swap_used, disk, disk_read, disk_write, net_rx, net_tx, load1, ping, n)
         SELECT server_id, 2, (ts / 900) * 900 AS b,
                sum(cpu * n) / sum(n), max(cpu_max), sum(mem * n) / sum(n), sum(mem_used * n) / sum(n), sum(swap_used * n) / sum(n),
                sum(disk * n) / sum(n), sum(disk_read * n) / sum(n), sum(disk_write * n) / sum(n), sum(net_rx * n) / sum(n),
                sum(net_tx * n) / sum(n), sum(load1 * n) / sum(n), sum(ping * n) / sum(n), sum(n)
         FROM m_server WHERE tier = 1 AND ts >= ? AND ts < ? GROUP BY server_id, b`,
      ).run(start2, end2);
      db.query(
        `INSERT OR REPLACE INTO m_service(service_id, tier, ts, cpu, cpu_max, mem, mem_max, n)
         SELECT service_id, 2, (ts / 900) * 900 AS b, sum(cpu * n) / sum(n), max(cpu_max), sum(mem * n) / sum(n), max(mem_max), sum(n)
         FROM m_service WHERE tier = 1 AND ts >= ? AND ts < ? GROUP BY service_id, b`,
      ).run(start2, end2);
      metaSet("rollup2", String(end2));
    })();
  }
}

function prune(): void {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const r = getSettings().retention;
  const raw = nowSec - r.rawHours * 3600;
  const min = nowSec - r.minuteDays * 86400;
  const q = nowSec - r.quarterDays * 86400;
  db.transaction(() => {
    for (const t of ["m_server", "m_service"]) {
      db.query(`DELETE FROM ${t} WHERE tier = 0 AND ts < ?`).run(raw);
      db.query(`DELETE FROM ${t} WHERE tier = 1 AND ts < ?`).run(min);
      db.query(`DELETE FROM ${t} WHERE tier = 2 AND ts < ?`).run(q);
    }
    db.query("DELETE FROM check_results WHERE ts < ?").run(now - Math.max(r.minuteDays, 30) * 86_400_000);
    db.query("DELETE FROM events WHERE ts < ?").run(now - r.eventsDays * 86_400_000);
    db.query("DELETE FROM logs WHERE ts < ?").run(now - r.logsDays * 86_400_000);
    db.query("DELETE FROM log_counts WHERE minute < ?").run(Math.floor(now / 60_000) - r.logsDays * 1440);
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(now);
    // не больше 2000 строк-ошибок на сервис
    db.query(
      `DELETE FROM logs WHERE id IN (
         SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY service_id ORDER BY ts DESC) AS rn FROM logs) WHERE rn > 2000)`,
    ).run();
  })();
}

export function startMaintenance(): void {
  const safe = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      log.error(`maintenance: ${name}`, { error: errMsg(e) });
    }
  };
  safe("rollup", rollup)();
  setInterval(safe("rollup", rollup), 60_000);
  setTimeout(safe("prune", prune), 30_000);
  setInterval(safe("prune", prune), 3600_000);
  setInterval(safe("optimize", () => db.exec("PRAGMA optimize")), 24 * 3600_000);
}
