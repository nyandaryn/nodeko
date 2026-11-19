import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "../components/ui/misc.tsx";
import { StatusIcon } from "../lib/status.tsx";
import type { TreeNode } from "./layout.ts";

export interface SearchItem {
  id: string;
  type: TreeNode["type"];
  /** id узлов, которые нужно развернуть, чтобы элемент стал виден */
  expand: string[];
  route: string | null;
  label: string;
  sub: string;
  status: TreeNode["status"];
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export function SearchPalette({ open, onClose, items, onPick }: { open: boolean; onClose: () => void; items: SearchItem[]; onPick: (i: SearchItem) => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      input.current?.focus();
    }
  }, [open]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.slice(0, 50);
    const scored = items
      .map((i) => {
        const l = i.label.toLowerCase();
        const sub = i.sub.toLowerCase();
        const score = l.startsWith(s) ? 0 : l.includes(s) ? 1 : sub.includes(s) ? 2 : -1;
        return { i, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.i.label.localeCompare(b.i.label, "ru"));
    return scored.slice(0, 50).map((x) => x.i);
  }, [q, items]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-start justify-center p-4 pt-[12vh]">
      <div className="fixed inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-[560px] animate-pop overflow-hidden rounded-2xl border border-line-2 bg-panel shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={17} className="text-mute" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Сервер, сервис или проверка…"
            className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-mute"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && results[idx]) {
                onPick(results[idx]!);
              } else if (e.key === "Escape") onClose();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-mute">Ничего не найдено</div>}
          {results.map((r, i) => {
            const Icon = r.icon;
            return (
              <button
                key={r.id}
                data-idx={i}
                onMouseEnter={() => setIdx(i)}
                onClick={() => onPick(r)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${i === idx ? "bg-card-hi" : ""}`}
              >
                <Icon size={15} className="shrink-0 text-mute" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{r.label}</span>
                  <span className="num block truncate text-[11px] text-mute">{r.sub}</span>
                </span>
                <StatusIcon status={r.status} size={15} />
                {i === idx && <CornerDownLeft size={13} className="text-mute" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

