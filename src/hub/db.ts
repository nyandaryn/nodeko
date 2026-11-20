import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * Схема хаба. Миграции — упорядоченный список; применённые номера в PRAGMA user_version.
 * Метрики: tier 0 — сырые снимки (ts = UNIX-секунды приёма), 1 — минутные, 2 — 15-минутные агрегаты.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    webauthn_id BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE passkeys(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    name TEXT NOT NULL,
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used INTEGER
  );
  CREATE TABLE api_tokens(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    secret_hash BLOB NOT NULL,
    hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER
  );

  CREATE TABLE servers(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    agent_key BLOB,
    enroll_hash BLOB,
    enroll_expires INTEGER,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    host_json TEXT,
    now_json TEXT,
    fs_json TEXT,
    overrides_json TEXT,
    alerts_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    status_reason TEXT,
    status_since INTEGER NOT NULL
  );
  CREATE TABLE services(
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT,
    group_name TEXT,
    tracked INTEGER NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0,
    sample_json TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    status_reason TEXT,
    status_since INTEGER NOT NULL,
    down_since INTEGER,
    notified_down INTEGER NOT NULL DEFAULT 0,
    last_restarts INTEGER,
    last_restart_at INTEGER,
    UNIQUE(server_id, key)
  );
  CREATE TABLE checks(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    runner TEXT NOT NULL DEFAULT 'hub',
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    interval INTEGER NOT NULL,
    timeout INTEGER NOT NULL,
    expect TEXT,
    keyword TEXT,
    method TEXT NOT NULL DEFAULT 'GET',
    insecure INTEGER NOT NULL DEFAULT 0,
    retries INTEGER NOT NULL DEFAULT 2,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    status_reason TEXT,
    status_since INTEGER NOT NULL,
    fails INTEGER NOT NULL DEFAULT 0,
    last_json TEXT,
    cert_expires INTEGER,
    cert_notified INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE check_results(
    check_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    code INTEGER,
    ms INTEGER,
    err TEXT,
    PRIMARY KEY(check_id, ts)
  ) WITHOUT ROWID;

  CREATE TABLE m_server(
    server_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL, cpu_max REAL, mem REAL, mem_used REAL, swap_used REAL, disk REAL,
    disk_read REAL, disk_write REAL, net_rx REAL, net_tx REAL, load1 REAL, ping REAL,
    n INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(server_id, tier, ts)
  ) WITHOUT ROWID;
  CREATE TABLE m_service(
    service_id INTEGER NOT NULL,
    tier INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL, cpu_max REAL, mem REAL, mem_max REAL,
    n INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(service_id, tier, ts)
  ) WITHOUT ROWID;

  CREATE TABLE logs(
    id INTEGER PRIMARY KEY,
    service_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    prio INTEGER NOT NULL,
    msg TEXT NOT NULL
  );
  CREATE INDEX logs_svc_ts ON logs(service_id, ts);
  CREATE INDEX logs_ts ON logs(ts);
  CREATE TABLE log_counts(
    service_id INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY(service_id, minute)
  ) WITHOUT ROWID;

  CREATE TABLE events(
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    server_id TEXT,
    service_id INTEGER,
    check_id INTEGER,
    title TEXT NOT NULL,
    message TEXT,
    actor TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  CREATE INDEX events_svc ON events(service_id, ts);
  CREATE INDEX events_srv ON events(server_id, ts);
  `,
  // 2: база знаний — заметки (markdown) и все их версии
  `
  CREATE TABLE notes(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    servers_json TEXT NOT NULL DEFAULT '[]',
    services_json TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    rev INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE note_revisions(
    note_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    actor TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    servers_json TEXT NOT NULL,
    services_json TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY(note_id, rev)
  ) WITHOUT ROWID;
  `,
];

function open(): Database {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDir, "nodeko.db");
  const db = new Database(file, { create: true, strict: true });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}

export const db = open();

export function metaGet(key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function metaSet(key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function parseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
