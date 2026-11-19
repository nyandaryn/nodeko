import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { useSyncExternalStore } from "react";

type Kind = "ok" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

let toasts: Toast[] = [];
let seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

export function toast(text: string, kind: Kind = "ok", ttl = kind === "error" ? 6000 : 3200) {
  const id = ++seq;
  toasts = [...toasts.slice(-3), { id, kind, text }];
  emit();
  setTimeout(() => dismiss(id), ttl);
}
toast.error = (text: string) => toast(text, "error");
toast.info = (text: string) => toast(text, "info");

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const ICON = { ok: CircleCheck, error: CircleX, info: Info };
const COLOR = { ok: "var(--ok)", error: "var(--down)", info: "var(--accent)" };

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" role="status" aria-live="polite">
      {list.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-pop items-start gap-2.5 rounded-xl border border-line-2 bg-card px-3.5 py-3 text-[13px] shadow-pop"
          >
            <Icon size={17} style={{ color: COLOR[t.kind] }} className="mt-px shrink-0" />
            <span className="flex-1 leading-snug text-ink">{t.text}</span>
            <button className="text-mute hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Закрыть">
              <X size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
