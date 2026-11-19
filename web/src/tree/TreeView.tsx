import type { Status } from "@shared/api.ts";
import { Maximize, Minus, Plus, Scan } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { store } from "../lib/storage.ts";
import { STATUS } from "../lib/status.tsx";
import type { TreeLayout, TreeNode } from "./layout.ts";
import { NodeView, nodeDims } from "./nodes.tsx";

interface Viewport {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.12;
const MAX_K = 2;
const GRID = 22;

export interface TreeViewHandle {
  centerOn: (id: string, opts?: { zoom?: number; rightInset?: number }) => void;
  fit: () => void;
}

const edgeColor = (s: Status) =>
  s === "down" ? "var(--down)" : s === "warn" ? "var(--warn)" : s === "unknown" ? "color-mix(in oklab, var(--idle) 80%, transparent)" : "var(--line-2)";

export const TreeView = forwardRef<
  TreeViewHandle,
  {
    layout: TreeLayout;
    selectedId: string | null;
    highlightId: string | null;
    issuesOnly: boolean;
    now: number;
    onSelect: (n: TreeNode) => void;
    onToggle: (id: string) => void;
    rightInset: number;
  }
>(function TreeView({ layout, selectedId, highlightId, issuesOnly, now, onSelect, onToggle, rightInset }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const vp = useRef<Viewport>(store.get<Viewport | null>("viewport", null) ?? { x: 0, y: 0, k: 0 });
  const [, setTick] = useState(0);
  const raf = useRef(0);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const apply = useCallback((animate = false) => {
    const { x, y, k } = vp.current;
    const w = world.current;
    const b = box.current;
    if (!w || !b) return;
    w.style.transition = animate ? "transform 0.38s cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    w.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    b.style.backgroundSize = `${GRID * k}px ${GRID * k}px`;
    b.style.backgroundPosition = `${x}px ${y}px`;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      setTick((t) => t + 1);
      store.set("viewport", vp.current);
    });
  }, []);

  const fit = useCallback(
    (animate = true) => {
      const b = box.current;
      if (!b) return;
      const { bounds } = layoutRef.current;
      const vw = b.clientWidth - rightInset;
      const vh = b.clientHeight;
      const pad = 48;
      const k = Math.max(MIN_K, Math.min(1, (vw - pad * 2) / bounds.w, (vh - pad * 2) / bounds.h));
      vp.current = {
        k,
        x: (vw - bounds.w * k) / 2 - bounds.x * k,
        y: Math.max(pad, (vh - bounds.h * k) / 2) - bounds.y * k,
      };
      apply(animate);
    },
    [apply, rightInset],
  );

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number, animate = false) => {
      const v = vp.current;
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      const f = k / v.k;
      vp.current = { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
      apply(animate);
    },
    [apply],
  );

  const centerOn = useCallback(
    (id: string, opts?: { zoom?: number; rightInset?: number }) => {
      const n = layoutRef.current.byId.get(id);
      const b = box.current;
      if (!n || !b) return;
      const k = opts?.zoom ? Math.max(vp.current.k, opts.zoom) : vp.current.k;
      const vw = b.clientWidth - (opts?.rightInset ?? rightInset);
      vp.current = { k, x: vw / 2 - (n.x + n.w / 2) * k, y: b.clientHeight / 2 - (n.y + n.h / 2) * k };
      apply(true);
    },
    [apply, rightInset],
  );

  useImperativeHandle(ref, () => ({ centerOn, fit: () => fit(true) }), [centerOn, fit]);

  // первичная раскладка: сохранённый вьюпорт или умное «вписать»
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !layout.nodes.length) return;
    inited.current = true;
    if (vp.current.k > 0) {
      apply(false);
      return;
    }
    fit(false);
    if (vp.current.k < 0.5 && box.current) {
      const first = layout.nodes[0]!;
      const k = 0.62;
      vp.current = { k, x: (box.current.clientWidth - rightInset) / 2 - (first.x + first.w / 2) * k, y: 88 - first.y * k };
      apply(false);
    }
  }, [layout, apply, fit, rightInset]);

  // ---- пан мышью (ЛКМ по фону или по узлу), клик если сдвиг < 4px ----
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; panning: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("[data-nopan],[data-ui]")) return;
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: vp.current.x, oy: vp.current.y, panning: e.button === 1 };
    suppressClick.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.panning && Math.hypot(dx, dy) > 4) {
      d.panning = true;
      try {
        box.current?.setPointerCapture(e.pointerId);
      } catch {
        /* синтетические/завершённые указатели */
      }
      box.current?.classList.add("cursor-grabbing");
    }
    if (d.panning) {
      vp.current = { ...vp.current, x: d.ox + dx, y: d.oy + dy };
      apply(false);
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.panning) suppressClick.current = true;
    drag.current = null;
    box.current?.classList.remove("cursor-grabbing");
    try {
      if (box.current?.hasPointerCapture(e.pointerId)) box.current.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // колесо — зум к курсору (non-passive)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("[data-ui]")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // pinch на трекпаде приходит как wheel+ctrlKey с мелкими дельтами
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016));
      zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // клавиатура: + − 0
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const b = box.current;
      if (!b) return;
      const cx = (b.clientWidth - rightInset) / 2;
      const cy = b.clientHeight / 2;
      if (e.key === "+" || e.key === "=") zoomAt(1.2, cx, cy, true);
      else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.2, cx, cy, true);
      else if (e.key === "0") fit(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt, fit, rightInset]);

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick.current = false;
      return;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    if (!el || (e.target as HTMLElement).closest("[data-nopan]")) return;
    const n = layoutRef.current.byId.get(el.dataset.node!);
    if (n) onSelect(n);
  };

  const nodesLayer = useMemo(
    () =>
      layout.nodes.map((n) => (
        <NodeView
          key={n.id}
          node={n}
          selected={n.id === selectedId}
          highlight={n.id === highlightId}
          dim={nodeDims(n.status, issuesOnly, "counts" in n ? n.counts : undefined)}
          now={now}
          onToggle={onToggle}
        />
      )),
    [layout, selectedId, highlightId, issuesOnly, now, onToggle],
  );

  const { bounds } = layout;
  const pad = 40;

  return (
    <div
      ref={box}
      className="canvas-grid relative h-full w-full touch-none overflow-hidden select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-node],[data-ui]")) fit(true);
      }}
      role="application"
      aria-label="Дерево серверов и сервисов. Перетаскивайте мышью, колесо — масштаб."
    >
      <div ref={world} className="absolute top-0 left-0 origin-top-left will-change-transform">
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{ left: bounds.x - pad, top: bounds.y - pad, width: bounds.w + pad * 2, height: bounds.h + pad * 2 }}
          viewBox={`${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`}
        >
          {layout.edges.map((e) => {
            const target = layout.byId.get(e.id.split(">")[1]!);
            const dim = target ? nodeDims(target.status, issuesOnly, "counts" in target ? target.counts : undefined) : false;
            return (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={edgeColor(e.status)}
                strokeWidth={e.status === "down" || e.status === "warn" ? 1.8 : 1.4}
                strokeDasharray={e.status === "unknown" ? "4 4" : undefined}
                opacity={dim ? 0.25 : 1}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        {nodesLayer}
      </div>

      <Controls
        onZoom={(f) => {
          const b = box.current!;
          zoomAt(f, (b.clientWidth - rightInset) / 2, b.clientHeight / 2, true);
        }}
        onFit={() => fit(true)}
        onReset={() => {
          const b = box.current!;
          zoomAt(1 / vp.current.k, (b.clientWidth - rightInset) / 2, b.clientHeight / 2, true);
        }}
        k={vp.current.k}
        right={rightInset}
      />
      <Minimap layout={layout} vp={vp.current} box={box.current} rightInset={rightInset} onMove={(x, y) => {
        const b = box.current!;
        const k = vp.current.k;
        vp.current = { k, x: (b.clientWidth - rightInset) / 2 - x * k, y: b.clientHeight / 2 - y * k };
        apply(false);
      }} />
    </div>
  );
});

function Controls({ onZoom, onFit, onReset, k, right }: { onZoom: (f: number) => void; onFit: () => void; onReset: () => void; k: number; right: number }) {
  const btn = "flex h-8 w-8 items-center justify-center text-ink-2 transition-colors hover:bg-card-hi hover:text-ink";
  return (
    <div
      data-ui
      className="absolute bottom-4 flex items-center overflow-hidden rounded-xl border border-line-2 bg-panel/95 shadow-card backdrop-blur transition-[right] duration-300"
      style={{ right: right + 16 }}
    >
      <button className={btn} onClick={() => onZoom(1 / 1.25)} aria-label="Отдалить" title="Отдалить (−)">
        <Minus size={15} />
      </button>
      <button className="num h-8 min-w-[52px] px-1 text-[11.5px] text-ink-2 hover:bg-card-hi hover:text-ink" onClick={onReset} title="Масштаб 100%">
        {Math.round(k * 100)}%
      </button>
      <button className={btn} onClick={() => onZoom(1.25)} aria-label="Приблизить" title="Приблизить (+)">
        <Plus size={15} />
      </button>
      <span className="h-5 w-px bg-[var(--line-2)]" />
      <button className={btn} onClick={onFit} aria-label="Вписать" title="Вписать всё (0, двойной клик по фону)">
        <Scan size={15} />
      </button>
    </div>
  );
}

function Minimap({
  layout,
  vp,
  box,
  rightInset,
  onMove,
}: {
  layout: TreeLayout;
  vp: Viewport;
  box: HTMLDivElement | null;
  rightInset: number;
  onMove: (wx: number, wy: number) => void;
}) {
  const W = 196;
  const H = 120;
  const { bounds } = layout;
  const pad = 60;
  const bx = bounds.x - pad;
  const by = bounds.y - pad;
  const bw = bounds.w + pad * 2;
  const bh = bounds.h + pad * 2;
  const s = Math.min(W / bw, H / bh);
  const ox = (W - bw * s) / 2;
  const oy = (H - bh * s) / 2;
  const dragging = useRef(false);
  const [hidden, setHidden] = useState(() => store.get("minimapHidden", false));
  if (!box || vp.k <= 0) return null;
  const vw = (box.clientWidth - rightInset) / vp.k;
  const vh = box.clientHeight / vp.k;
  const vx = -vp.x / vp.k;
  const vy = -vp.y / vp.k;
  const toWorld = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onMove((e.clientX - r.left - ox) / s + bx, (e.clientY - r.top - oy) / s + by);
  };
  if (hidden)
    return (
      <button
        data-ui
        onClick={() => {
          setHidden(false);
          store.set("minimapHidden", false);
        }}
        className="absolute bottom-4 left-4 flex h-8 items-center gap-1.5 rounded-xl border border-line-2 bg-panel/95 px-2.5 text-[12px] text-ink-2 shadow-card hover:text-ink max-md:hidden"
      >
        <Maximize size={13} /> Миникарта
      </button>
    );
  return (
    <div data-ui className="absolute bottom-4 left-4 overflow-hidden rounded-xl border border-line-2 bg-panel/95 shadow-card backdrop-blur max-md:hidden">
      <svg
        width={W}
        height={H}
        className="block cursor-crosshair"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          toWorld(e);
        }}
        onPointerMove={(e) => dragging.current && toWorld(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        <g transform={`translate(${ox},${oy}) scale(${s}) translate(${-bx},${-by})`}>
          {layout.nodes.map((n) => (
            <rect
              key={n.id}
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={10}
              fill={n.status === "ok" || n.status === "stopped" ? "var(--line-2)" : STATUS[n.status].color}
              opacity={n.type === "server" || n.type === "external" ? 1 : 0.85}
            />
          ))}
          <rect x={vx} y={vy} width={vw} height={vh} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={2 / s} rx={6 / s} />
        </g>
      </svg>
      <button
        className="absolute top-1 right-1 rounded px-1 text-[10px] text-mute hover:text-ink"
        onClick={() => {
          setHidden(true);
          store.set("minimapHidden", true);
        }}
        aria-label="Скрыть миникарту"
      >
        ✕
      </button>
    </div>
  );
}
