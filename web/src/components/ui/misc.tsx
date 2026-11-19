import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "../../lib/toast.tsx";

export function Card({ children, className = "", pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`rounded-xl border border-line bg-card shadow-card ${pad ? "p-4" : ""} ${className}`}>{children}</div>;
}

export function Section({
  title,
  desc,
  actions,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div>
          <h3 className="micro">{title}</h3>
          {desc && <p className="mt-1 text-[12.5px] text-mute">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "down" | "accent" | "idle";
  className?: string;
  title?: string;
}) {
  const t = {
    neutral: "bg-card-hi text-ink-2 border-line",
    ok: "bg-ok-soft text-ink border-transparent",
    warn: "bg-warn-soft text-ink border-transparent",
    down: "bg-down-soft text-ink border-transparent",
    accent: "bg-accent-soft text-ink border-transparent",
    idle: "bg-idle-soft text-ink-2 border-transparent",
  }[tone];
  return (
    <span title={title} className={`inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11.5px] font-medium whitespace-nowrap ${t} ${className}`}>
      {children}
    </span>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="num inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-2 bg-sunken px-1 text-[10.5px] text-mute">
    {children}
  </kbd>
);

export const Skeleton = ({ className = "" }: { className?: string }) => <div className={`skeleton ${className}`} />;

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-mute">{icon}</div>}
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-sm text-[12.5px] leading-relaxed text-mute">{children}</div>}
    </div>
  );
}

export async function copyText(text: string, what = "Скопировано") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast.error("Не удалось скопировать — выделите текст вручную");
  }
}

export function CopyField({ value, label, secret = false, multiline = false }: { value: string; label?: string; secret?: boolean; multiline?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      {label && <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">{label}</div>}
      <div className="group relative rounded-lg border border-line-2 bg-sunken">
        <pre
          className={`num overflow-x-auto px-3 py-2.5 pr-12 text-[12px] leading-relaxed text-ink ${multiline ? "whitespace-pre-wrap break-all" : "whitespace-pre"} ${secret ? "select-all" : ""}`}
        >
          {value}
        </pre>
        <button
          type="button"
          className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-line bg-card text-ink-2 hover:text-ink"
          onClick={async () => {
            await copyText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
          aria-label="Копировать"
        >
          {done ? <Check size={14} style={{ color: "var(--ok)" }} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number | null; tone?: "down" | "warn" }[];
}) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-5 [scrollbar-width:none]" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={`relative -mb-px flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
            value === t.value ? "border-accent text-ink" : "border-transparent text-mute hover:text-ink"
          }`}
        >
          {t.label}
          {t.count != null && t.count > 0 && (
            <span
              className="num rounded-full px-1.5 text-[10.5px] leading-[16px]"
              style={{
                background: t.tone === "down" ? "var(--down-soft)" : t.tone === "warn" ? "var(--warn-soft)" : "var(--card-hi)",
                color: "var(--ink)",
              }}
            >
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode, { mono?: boolean; title?: string }?][] }) {
  return (
    <dl className="divide-y divide-line rounded-xl border border-line bg-card">
      {rows.map(([k, v, o], i) => (
        <div key={i} className="grid grid-cols-[140px_1fr] items-baseline gap-3 px-3.5 py-2 text-[13px] max-[480px]:grid-cols-[110px_1fr]">
          <dt className="text-mute">{k}</dt>
          <dd className={`min-w-0 break-words text-ink ${o?.mono ? "num text-[12.5px]" : ""}`} title={o?.title}>
            {v ?? <span className="text-mute">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({ value, color, className = "" }: { value: number | null | undefined; color: string; className?: string }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={`h-[5px] overflow-hidden rounded-full bg-[var(--line)] ${className}`}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: color }} />
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  icon,
  meter,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  meter?: { value: number | null | undefined; color: string };
}) {
  return (
    <div className="rounded-xl border border-line bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-mute">
        {icon}
        <span className="micro">{label}</span>
      </div>
      <div
        className={`num mt-1.5 truncate leading-tight font-medium tracking-tight text-ink ${typeof value !== "string" || value.length <= 8 ? "text-[19px]" : value.length <= 10 ? "text-[16px]" : "text-[14px]"}`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-mute">{sub}</div>}
      {meter && <Meter value={meter.value} color={meter.color} className="mt-2" />}
    </div>
  );
}
