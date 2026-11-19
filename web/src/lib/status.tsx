import type { Status } from "@shared/api.ts";
import { CircleCheck, CirclePause, CircleQuestionMark, CircleX, Clock, TriangleExclamationPoint, type LucideIcon } from "lucide-react";

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  /** CSS-переменная цвета */
  color: string;
  soft: string;
  /** чем больше — тем хуже (для агрегации «худший статус») */
  weight: number;
}

export const STATUS: Record<Status, StatusMeta> = {
  ok: { label: "В норме", icon: CircleCheck, color: "var(--ok)", soft: "var(--ok-soft)", weight: 1 },
  stopped: { label: "Остановлен", icon: CirclePause, color: "var(--idle)", soft: "var(--idle-soft)", weight: 0 },
  pending: { label: "Ожидает агента", icon: Clock, color: "var(--pend)", soft: "var(--pend-soft)", weight: 2 },
  unknown: { label: "Нет данных", icon: CircleQuestionMark, color: "var(--idle)", soft: "var(--idle-soft)", weight: 3 },
  warn: { label: "Внимание", icon: TriangleExclamationPoint, color: "var(--warn)", soft: "var(--warn-soft)", weight: 4 },
  down: { label: "Сбой", icon: CircleX, color: "var(--down)", soft: "var(--down-soft)", weight: 5 },
};

export const STATUS_ORDER: Status[] = ["down", "warn", "unknown", "pending", "ok", "stopped"];

export function worst(statuses: Iterable<Status>): Status {
  let w: Status = "ok";
  let any = false;
  for (const s of statuses) {
    if (!any || STATUS[s].weight > STATUS[w].weight) w = s;
    any = true;
  }
  return any ? w : "stopped";
}

export const isProblem = (s: Status) => s === "down" || s === "warn" || s === "unknown";

export function StatusIcon({ status, size = 16, className = "" }: { status: Status; size?: number; className?: string }) {
  const m = STATUS[status];
  const Icon = m.icon;
  return <Icon size={size} strokeWidth={2.2} style={{ color: m.color }} className={className} aria-label={m.label} role="img" />;
}

export function StatusPill({ status, label, className = "" }: { status: Status; label?: string; className?: string }) {
  const m = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-1.5 text-[12px] font-medium ${className}`}
      style={{ background: m.soft, color: "var(--ink)" }}
    >
      <StatusIcon status={status} size={14} />
      {label ?? m.label}
    </span>
  );
}

/** Цвет полосы использования ресурса по порогу */
export function usageColor(pct: number | null | undefined, limit = 90): string {
  if (pct == null) return "var(--idle)";
  if (pct >= limit) return "var(--down)";
  if (pct >= limit * 0.85) return "var(--warn)";
  return "var(--accent)";
}
