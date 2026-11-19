import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../components/ui/Button.tsx";

export const DRAWER_W = 580;

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside
      data-ui
      className="absolute top-0 right-0 bottom-0 z-30 flex w-full animate-slide-in flex-col border-l border-line-2 bg-panel shadow-pop md:w-[var(--dw)]"
      style={{ ["--dw" as string]: `${DRAWER_W}px` }}
      aria-label="Подробности"
    >
      {children}
    </aside>
  );
}

export function DrawerHeader({
  icon,
  title,
  subtitle,
  status,
  actions,
  onClose,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 px-5 pt-4 pb-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[18px] leading-tight font-semibold tracking-tight">{title}</h2>
          {subtitle && <div className="num mt-1 truncate text-[11.5px] text-mute">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть (Esc)" title="Закрыть (Esc)">
            <X size={17} />
          </Button>
        </div>
      </div>
      {status && <div className="mt-3 flex flex-wrap items-center gap-2">{status}</div>}
    </div>
  );
}

export function DrawerBody({ children, scrollKey }: { children: ReactNode; scrollKey?: string | number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [scrollKey]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-10">
      {children}
    </div>
  );
}

export function PanelSkeleton() {
  return (
    <div className="space-y-4 p-5">
      <div className="skeleton h-7 w-2/3" />
      <div className="skeleton h-4 w-1/3" />
      <div className="grid grid-cols-2 gap-3 pt-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton h-20" />
        ))}
      </div>
      <div className="skeleton h-40" />
    </div>
  );
}
