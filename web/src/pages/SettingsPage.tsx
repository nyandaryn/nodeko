import { Bell, Bot, Gauge, Globe, Server, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Link, useRoute } from "wouter";
import { ChecksSettings } from "./settings/ChecksSettings.tsx";
import { GeneralSettings, NotifySettings, ThresholdSettings } from "./settings/GeneralSettings.tsx";
import { SecuritySettings } from "./settings/SecuritySettings.tsx";
import { ServersSettings } from "./settings/ServersSettings.tsx";
import { TokensSettings } from "./settings/TokensSettings.tsx";

const SECTIONS = [
  { id: "general", label: "Общие", icon: SlidersHorizontal, C: GeneralSettings },
  { id: "notify", label: "Уведомления", icon: Bell, C: NotifySettings },
  { id: "thresholds", label: "Пороги", icon: Gauge, C: ThresholdSettings },
  { id: "servers", label: "Серверы", icon: Server, C: ServersSettings },
  { id: "checks", label: "Проверки", icon: Globe, C: ChecksSettings },
  { id: "tokens", label: "API и ИИ-агент", icon: Bot, C: TokensSettings },
  { id: "security", label: "Безопасность", icon: ShieldCheck, C: SecuritySettings },
] as const;

export function SettingsPage() {
  const [, p] = useRoute("/settings/:section");
  const cur = SECTIONS.find((s) => s.id === p?.section) ?? SECTIONS[0];
  const C = cur.C;
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-[1080px] gap-8 px-4 py-8 max-md:flex-col max-md:gap-5 sm:px-6">
        <nav className="sticky top-6 w-[210px] shrink-0 self-start max-md:static max-md:w-full" aria-label="Разделы настроек">
          <h1 className="mb-4 px-2 text-[22px] font-semibold tracking-tight">Настройки</h1>
          <div className="flex flex-col gap-0.5 max-md:flex-row max-md:-mx-4 max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none]">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = s.id === cur.id;
              return (
                <Link
                  key={s.id}
                  href={`/settings/${s.id}`}
                  className={`flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors ${
                    active ? "bg-card-hi font-medium text-ink shadow-[inset_0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-card hover:text-ink"
                  }`}
                >
                  <Icon size={15} className={active ? "text-accent" : "text-mute"} />
                  {s.label}
                </Link>
              );
            })}
          </div>
        </nav>
        <main className="min-w-0 flex-1 animate-fade-in" key={cur.id}>
          <C />
        </main>
      </div>
    </div>
  );
}

export function SettingsHeader({ title, desc, actions }: { title: string; desc?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4 max-sm:flex-col max-sm:items-start md:pt-[46px]">
      <div className="min-w-0 flex-1">
        <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
        {desc && <p className="mt-1 max-w-[620px] text-[13px] leading-relaxed text-mute">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div
      className={`sticky bottom-4 z-10 mt-6 flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 shadow-pop backdrop-blur transition-all duration-200 ${
        dirty ? "translate-y-0 border-line-2 bg-panel/95 opacity-100" : "pointer-events-none translate-y-2 border-transparent opacity-0"
      }`}
    >
      <span className="text-[13px] text-ink-2">Есть несохранённые изменения</span>
      <div className="flex gap-2">
        <button className="h-8 rounded-lg px-3 text-[13px] text-ink-2 hover:text-ink" onClick={onReset}>
          Отменить
        </button>
        <button
          className="flex h-8 items-center gap-2 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-on-accent hover:bg-accent-2 disabled:opacity-60"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
