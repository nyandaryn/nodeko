import type { Settings, SettingsPatch, Thresholds } from "../shared/api.ts";
import { DEFAULT_LOG_PATTERN, DEFAULT_PING_TARGET } from "../shared/protocol.ts";
import { config } from "./config.ts";
import { db, parseJson } from "./db.ts";

/** Внутреннее представление: как Settings, но с секретом бота. */
export interface SettingsInternal extends Omit<Settings, "notify"> {
  notify: {
    telegram: { enabled: boolean; chatId: string; threadId: string | null; botToken: string | null };
    events: Settings["notify"]["events"];
  };
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpu: { pct: 90, minutes: 5 },
  mem: { pct: 90, minutes: 5 },
  disk: { pct: 90 },
  offlineSeconds: 60,
};

function defaults(): SettingsInternal {
  return {
    publicUrl: config.publicUrl,
    agentInterval: 10,
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
    serviceDownDelay: 30,
    notify: {
      telegram: { enabled: false, chatId: "", threadId: null, botToken: null },
      events: {
        serverOffline: true,
        serviceDown: true,
        serviceRestart: false,
        checkDown: true,
        thresholds: true,
        recovery: true,
        certExpiry: true,
        newService: false,
      },
    },
    logPattern: "",
    pingTarget: DEFAULT_PING_TARGET,
    retention: { rawHours: 48, minuteDays: 30, quarterDays: 400, eventsDays: 90, logsDays: 14 },
    certWarnDays: 14,
  };
}

function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over) || base === null || typeof base !== "object") {
    return over as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

let cache: SettingsInternal | null = null;
const listeners: ((s: SettingsInternal) => void)[] = [];

export function getSettings(): SettingsInternal {
  if (cache) return cache;
  const row = db.query("SELECT value FROM settings WHERE key = 'main'").get() as { value: string } | null;
  cache = deepMerge(defaults(), parseJson(row?.value) ?? {});
  if (process.env.NODEKO_PUBLIC_URL) cache.publicUrl = config.publicUrl;
  return cache;
}

export function onSettingsChange(fn: (s: SettingsInternal) => void): void {
  listeners.push(fn);
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class ValidationError extends Error {}

export function patchSettings(p: SettingsPatch): SettingsInternal {
  const cur = getSettings();
  const next = deepMerge(cur, {
    ...p,
    notify: p.notify
      ? {
          telegram: p.notify.telegram
            ? Object.fromEntries(
                Object.entries(p.notify.telegram).filter(([k, v]) => !(k === "botToken" && v === undefined)),
              )
            : undefined,
          events: p.notify.events,
        }
      : undefined,
  }) as SettingsInternal;

  // валидация и нормализация
  try {
    const u = new URL(next.publicUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    next.publicUrl = u.origin;
  } catch {
    throw new ValidationError("publicUrl: нужен http(s)://адрес");
  }
  next.agentInterval = clamp(Math.round(next.agentInterval), 5, 300);
  next.serviceDownDelay = clamp(Math.round(next.serviceDownDelay), 0, 3600);
  next.certWarnDays = clamp(Math.round(next.certWarnDays), 1, 90);
  const t = next.thresholds;
  t.cpu.pct = clamp(t.cpu.pct, 1, 100);
  t.cpu.minutes = clamp(Math.round(t.cpu.minutes), 1, 120);
  t.mem.pct = clamp(t.mem.pct, 1, 100);
  t.mem.minutes = clamp(Math.round(t.mem.minutes), 1, 120);
  t.disk.pct = clamp(t.disk.pct, 1, 100);
  t.offlineSeconds = clamp(Math.round(t.offlineSeconds), 20, 3600);
  const r = next.retention;
  r.rawHours = clamp(Math.round(r.rawHours), 6, 24 * 14);
  r.minuteDays = clamp(Math.round(r.minuteDays), 2, 180);
  r.quarterDays = clamp(Math.round(r.quarterDays), 30, 3650);
  r.eventsDays = clamp(Math.round(r.eventsDays), 7, 3650);
  r.logsDays = clamp(Math.round(r.logsDays), 1, 365);
  if (next.logPattern) {
    try {
      new RegExp(next.logPattern, "i");
    } catch {
      throw new ValidationError("logPattern: неверное регулярное выражение");
    }
  }
  if (!/^[\w.-]+:\d{1,5}$/.test(next.pingTarget)) throw new ValidationError("pingTarget: ожидается host:port");
  const tg = next.notify.telegram;
  tg.chatId = String(tg.chatId ?? "").trim();
  tg.threadId = tg.threadId ? String(tg.threadId).trim() || null : null;
  if (tg.botToken !== null && tg.botToken !== undefined) {
    tg.botToken = String(tg.botToken).trim() || null;
    if (tg.botToken && !/^\d+:[\w-]{30,}$/.test(tg.botToken)) throw new ValidationError("неверный формат токена бота");
  }
  if (tg.chatId && !/^-?\d+$|^@\w+$/.test(tg.chatId)) throw new ValidationError("chatId: число или @канал");

  db.query("INSERT INTO settings(key, value) VALUES('main', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(next),
  );
  cache = next;
  for (const fn of listeners) fn(next);
  return next;
}

export function publicSettings(s = getSettings()): Settings {
  const { botToken, ...tg } = s.notify.telegram;
  return { ...s, notify: { telegram: { ...tg, botTokenSet: !!botToken }, events: s.notify.events } };
}

export function effectiveLogPattern(s = getSettings()): string {
  return s.logPattern || DEFAULT_LOG_PATTERN;
}

export function effectiveThresholds(overrides: Partial<Thresholds> | null, s = getSettings()): Thresholds {
  return deepMerge(structuredClone(s.thresholds), overrides ?? {});
}
