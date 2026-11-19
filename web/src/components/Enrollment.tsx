import type { ServerEnrollment, Thresholds } from "@shared/api.ts";
import { KeyRound, ShieldCheck } from "lucide-react";
import { dateTime, dur } from "../lib/format.ts";
import { Input } from "./ui/Field.tsx";
import { CopyField } from "./ui/misc.tsx";

export function EnrollmentView({ e }: { e: ServerEnrollment }) {
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-2">
        Выполните команду на сервере <b className="text-ink">{e.serverId}</b> от пользователя, под которым работают приложения. Агент установится как
        user-юнит systemd, сгенерирует свой ключ и зарегистрируется одноразовым токеном.
      </p>
      <CopyField label="Команда установки" value={e.installCommand} multiline />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-card px-3 py-2.5">
          <div className="micro mb-1 flex items-center gap-1.5">
            <KeyRound size={12} /> Токен действует
          </div>
          <div className="num text-[13px]">
            до {dateTime(e.expiresAt)} <span className="text-mute">({dur(e.expiresAt - Date.now(), 1)})</span>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-card px-3 py-2.5">
          <div className="micro mb-1 flex items-center gap-1.5">
            <ShieldCheck size={12} /> Отпечаток ключа хаба
          </div>
          <div className="num text-[13px]">{e.hubKeyFingerprint}</div>
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-mute">
        Токен показывается один раз и сгорает после первой регистрации. Агент закрепляет ключ хаба — подменить хаб по пути (в том числе на
        Cloudflare) нельзя.
      </p>
    </div>
  );
}

export type ThresholdDraft = {
  cpuPct: string;
  cpuMin: string;
  memPct: string;
  memMin: string;
  diskPct: string;
  offline: string;
};

export const draftFrom = (t: Partial<Thresholds> | null | undefined): ThresholdDraft => ({
  cpuPct: t?.cpu?.pct != null ? String(t.cpu.pct) : "",
  cpuMin: t?.cpu?.minutes != null ? String(t.cpu.minutes) : "",
  memPct: t?.mem?.pct != null ? String(t.mem.pct) : "",
  memMin: t?.mem?.minutes != null ? String(t.mem.minutes) : "",
  diskPct: t?.disk?.pct != null ? String(t.disk.pct) : "",
  offline: t?.offlineSeconds != null ? String(t.offlineSeconds) : "",
});

/** Черновик → Thresholds (полные, для дефолтов) */
export function draftToFull(d: ThresholdDraft, base: Thresholds): Thresholds {
  const n = (s: string, f: number) => (s.trim() === "" || !Number.isFinite(Number(s)) ? f : Number(s));
  return {
    cpu: { pct: n(d.cpuPct, base.cpu.pct), minutes: n(d.cpuMin, base.cpu.minutes) },
    mem: { pct: n(d.memPct, base.mem.pct), minutes: n(d.memMin, base.mem.minutes) },
    disk: { pct: n(d.diskPct, base.disk.pct) },
    offlineSeconds: n(d.offline, base.offlineSeconds),
  };
}

/** Черновик → переопределения (только заданные поля; пусто → null) */
export function draftToOverrides(d: ThresholdDraft, base: Thresholds): Partial<Thresholds> | null {
  const v = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
  const o: Partial<Thresholds> = {};
  if (v(d.cpuPct) != null || v(d.cpuMin) != null) o.cpu = { pct: v(d.cpuPct) ?? base.cpu.pct, minutes: v(d.cpuMin) ?? base.cpu.minutes };
  if (v(d.memPct) != null || v(d.memMin) != null) o.mem = { pct: v(d.memPct) ?? base.mem.pct, minutes: v(d.memMin) ?? base.mem.minutes };
  if (v(d.diskPct) != null) o.disk = { pct: v(d.diskPct)! };
  if (v(d.offline) != null) o.offlineSeconds = v(d.offline)!;
  return Object.keys(o).length ? o : null;
}

export function ThresholdsForm({ d, set, placeholders }: { d: ThresholdDraft; set: (d: ThresholdDraft) => void; placeholders?: Thresholds }) {
  const row = (label: string, desc: string, a: keyof ThresholdDraft, aUnit: string, b?: keyof ThresholdDraft, bUnit?: string, pa?: number, pb?: number) => (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 py-3 max-[480px]:grid-cols-1">
      <div>
        <div className="text-[13.5px] text-ink">{label}</div>
        <div className="mt-0.5 text-[12px] text-mute">{desc}</div>
      </div>
      <div className="flex items-center gap-2">
        <Unit value={d[a]} onChange={(v) => set({ ...d, [a]: v })} unit={aUnit} placeholder={pa} />
        {b && <Unit value={d[b]} onChange={(v) => set({ ...d, [b]: v })} unit={bUnit!} placeholder={pb} prefix="дольше" />}
      </div>
    </div>
  );
  const p = placeholders;
  return (
    <div className="divide-y divide-line">
      {row("CPU", "Средняя загрузка выше порога дольше указанного времени", "cpuPct", "%", "cpuMin", "мин", p?.cpu.pct, p?.cpu.minutes)}
      {row("Память", "Использование RAM выше порога", "memPct", "%", "memMin", "мин", p?.mem.pct, p?.mem.minutes)}
      {row("Диск", "Заполнение любой файловой системы", "diskPct", "%", undefined, undefined, p?.disk.pct)}
      {row("Нет связи", "Через сколько без данных сервер считается недоступным", "offline", "сек", undefined, undefined, p?.offlineSeconds)}
    </div>
  );
}

function Unit({ value, onChange, unit, placeholder, prefix }: { value: string; onChange: (v: string) => void; unit: string; placeholder?: number; prefix?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-mute">
      {prefix && <span>{prefix}</span>}
      <span className="relative">
        <Input
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder={placeholder != null ? String(placeholder) : ""}
          className="num !h-8 !w-[84px] pr-9 text-right"
        />
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-mute">{unit}</span>
      </span>
    </label>
  );
}
