const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];

export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? nf0.format(v) : nf1.format(v);
  return `${n < 0 ? "−" : ""}${s} ${UNITS[i]}`;
}

export function rate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${bytes(n)}/с`;
}

export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 10 && n > 0 ? nf1.format(n) : nf0.format(n)}%`;
}

export function num(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return digits === 0 ? nf0.format(n) : digits === 2 ? nf2.format(n) : nf1.format(n);
}

export function ms(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `${nf2.format(n / 1000)} с` : `${nf0.format(n)} мс`;
}

/** Длительность в мс → «3д 4ч», «4ч 12м», «12м», «45с». */
export function dur(msv: number | null | undefined, parts = 2): string {
  if (msv == null || !Number.isFinite(msv)) return "—";
  let s = Math.max(0, Math.floor(msv / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const out: string[] = [];
  if (d) out.push(`${d}д`);
  if (h) out.push(`${h}ч`);
  if (m) out.push(`${m}м`);
  if (!d && !h && (s || out.length === 0)) out.push(`${s}с`);
  return out.slice(0, parts).join(" ");
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "никогда";
  const diff = now - ts;
  if (diff < 0) return `через ${dur(-diff, 1)}`;
  if (diff < 45_000) return "только что";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  if (diff < 30 * 86_400_000) {
    const d = Math.floor(diff / 86_400_000);
    return `${d} ${plural(d, "день", "дня", "дней")} назад`;
  }
  return dateShort(ts);
}

const dtf = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dtfFull = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
const tf = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayF = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
const dayShortF = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export const dateTime = (ts: number) => dtf.format(ts);
export const dateFull = (ts: number) => dtfFull.format(ts);
export const dateShort = (ts: number) => dShort.format(ts);
export const timeOnly = (ts: number) => tf.format(ts);
export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const t = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, t)) return `Сегодня, ${dayShortF.format(ts)}`;
  t.setDate(t.getDate() - 1);
  if (sameDay(d, t)) return `Вчера, ${dayShortF.format(ts)}`;
  return dayF.format(ts);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function daysUntil(ts: number | null | undefined): number | null {
  if (ts == null) return null;
  return Math.floor((ts - Date.now()) / 86_400_000);
}

const dmF = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
/** «28 нояб.» — без года и времени */
export const dayMonth = (ts: number) => dmF.format(ts);
