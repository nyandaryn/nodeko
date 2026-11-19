import type { FsUsage } from "../shared/protocol.ts";
import { db, parseJson } from "./db.ts";
import { addEvent } from "./events.ts";
import { errMsg, log } from "./log.ts";
import { pct, type ServerAlerts, type ServerRow, type ServiceRow } from "./model.ts";
import { serviceLabel } from "./services.ts";
import { effectiveThresholds, getSettings } from "./settings.ts";

/** Каждые 5 с: offline-детект, уведомления о падениях после антидребезга. Каждые 30 с — пороги. */
export function startMonitor(): void {
  let n = 0;
  setInterval(() => {
    try {
      checkOffline();
      notifyServiceDowns();
      if (n++ % 6 === 0) evaluateThresholds();
    } catch (e) {
      log.error("monitor", { error: errMsg(e) });
    }
  }, 5000);
}

function checkOffline(): void {
  const now = Date.now();
  const servers = db.query("SELECT * FROM servers WHERE last_seen IS NOT NULL AND status != 'down'").all() as ServerRow[];
  for (const s of servers) {
    const th = effectiveThresholds(parseJson(s.overrides_json));
    if (now - s.last_seen! < th.offlineSeconds * 1000) continue;
    db.query("UPDATE servers SET status = 'down', status_reason = 'нет связи с агентом', status_since = ? WHERE id = ?").run(
      s.last_seen,
      s.id,
    );
    addEvent({
      level: "error",
      type: "server.offline",
      serverId: s.id,
      title: `${s.name} — нет связи`,
      message: `последние данные ${new Date(s.last_seen!).toISOString().replace("T", " ").slice(0, 19)} UTC`,
      notify: "serverOffline",
    });
  }
}

function notifyServiceDowns(): void {
  const now = Date.now();
  const delay = getSettings().serviceDownDelay * 1000;
  const rows = db
    .query(
      `SELECT sv.* FROM services sv JOIN servers s ON s.id = sv.server_id
       WHERE sv.status = 'down' AND sv.notified_down = 0 AND sv.down_since IS NOT NULL AND s.status IN ('ok', 'warn')`,
    )
    .all() as ServiceRow[];
  for (const r of rows) {
    if (now - r.down_since! < delay) continue;
    db.query("UPDATE services SET notified_down = 1 WHERE id = ?").run(r.id);
    if (!r.tracked) continue;
    addEvent({
      level: "error",
      type: "service.down",
      serverId: r.server_id,
      serviceId: r.id,
      title: `${serviceLabel(r)} — не работает`,
      message: r.status_reason,
      notify: r.muted ? null : "serviceDown",
    });
  }
}

const qAvg = db.query(
  "SELECT avg(cpu) AS cpu, avg(mem) AS mem, count(*) AS n FROM m_server WHERE server_id = ? AND tier = 0 AND ts >= ?",
);

export function evaluateThresholds(): void {
  const now = Date.now();
  const s = getSettings();
  const servers = db.query("SELECT * FROM servers WHERE status IN ('ok', 'warn')").all() as ServerRow[];
  for (const srv of servers) {
    const th = effectiveThresholds(parseJson(srv.overrides_json), s);
    const alerts: ServerAlerts = parseJson<ServerAlerts>(srv.alerts_json) ?? {};
    const before = JSON.stringify(alerts);
    const reasons: string[] = [];

    for (const kind of ["cpu", "mem"] as const) {
      const minutes = th[kind].minutes;
      const a = qAvg.get(srv.id, Math.floor(now / 1000) - minutes * 60) as { cpu: number | null; mem: number | null; n: number };
      const expected = (minutes * 60) / s.agentInterval;
      const value = a[kind];
      const label = kind === "cpu" ? "CPU" : "RAM";
      if (value !== null && a.n >= expected * 0.7) {
        if (!alerts[kind] && value >= th[kind].pct) {
          alerts[kind] = { since: now, value: Math.round(value) };
          addEvent({
            level: "warn",
            type: `alert.${kind}`,
            serverId: srv.id,
            title: `${srv.name} — ${label} ${Math.round(value)}%`,
            message: `в среднем ≥ ${th[kind].pct}% за ${minutes} мин`,
            notify: "thresholds",
          });
        } else if (alerts[kind] && value < th[kind].pct - 5) {
          addEvent({ level: "ok", type: "alert.clear", serverId: srv.id, title: `${srv.name} — ${label} в норме (${Math.round(value)}%)`, notify: "thresholds" });
          alerts[kind] = null;
        } else if (alerts[kind]) alerts[kind]!.value = Math.round(value);
      }
      if (alerts[kind]) reasons.push(`${label} ${alerts[kind]!.value}% ≥ ${th[kind].pct}%`);
    }

    const fsList = parseJson<FsUsage[]>(srv.fs_json) ?? [];
    let worst: { mount: string; p: number } | null = null;
    for (const f of fsList) {
      if (f.total < 512 * 1024 * 1024) continue; // мелкие (boot/efi) не считаем
      const p = pct(f.used, f.total);
      if (!worst || p > worst.p) worst = { mount: f.mount, p };
    }
    if (worst) {
      if (!alerts.disk && worst.p >= th.disk.pct) {
        alerts.disk = { since: now, value: Math.round(worst.p), mount: worst.mount };
        addEvent({ level: "warn", type: "alert.disk", serverId: srv.id, title: `${srv.name} — диск ${worst.mount} заполнен на ${Math.round(worst.p)}%`, message: `порог ${th.disk.pct}%`, notify: "thresholds" });
      } else if (alerts.disk && worst.p < th.disk.pct - 2) {
        addEvent({ level: "ok", type: "alert.clear", serverId: srv.id, title: `${srv.name} — место на диске в норме (${Math.round(worst.p)}%)`, notify: "thresholds" });
        alerts.disk = null;
      } else if (alerts.disk) alerts.disk = { ...alerts.disk, value: Math.round(worst.p), mount: worst.mount };
      if (alerts.disk) reasons.push(`диск ${alerts.disk.mount} ${alerts.disk.value}% ≥ ${th.disk.pct}%`);
    }

    const status = reasons.length ? "warn" : "ok";
    const reason = reasons.length ? reasons.join(", ") : null;
    if (JSON.stringify(alerts) !== before || status !== srv.status || reason !== srv.status_reason) {
      db.query(
        "UPDATE servers SET alerts_json = ?, status = ?, status_reason = ?, status_since = CASE WHEN status = ? THEN status_since ELSE ? END WHERE id = ? AND status IN ('ok','warn')",
      ).run(JSON.stringify(alerts), status, reason, status, now, srv.id);
    }
  }
}
