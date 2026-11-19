import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import { useUi } from "../lib/ui-store.ts";

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** CSS-переменная, например `--s1` */
  color: string;
  /** заливка под линией (только для одиночной серии) */
  area?: boolean;
  dash?: boolean;
  width?: number;
  /** полупрозрачная вторичная линия (например, максимум) */
  faint?: boolean;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return c;
}

const BINARY_INCRS = [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4].flatMap((b) => [1, 2, 5, 10, 20, 50, 100, 200, 500].map((m) => m * b));

const fmtTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const fmtTip = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function tooltipPlugin(series: ChartSeries[], fmt: (v: number) => string, colors: string[]): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className =
          "pointer-events-none absolute z-10 hidden min-w-[132px] rounded-lg border border-line-2 bg-panel px-2.5 py-2 text-[12px] shadow-pop";
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const idx = u.cursor.idx;
        if (idx == null || u.cursor.left == null || u.cursor.left < 0) {
          tip.classList.add("hidden");
          return;
        }
        const t = u.data[0][idx];
        if (t == null) return;
        tip.replaceChildren();
        const head = document.createElement("div");
        head.className = "mb-1 text-[11px] text-mute";
        head.textContent = fmtTip.format(t * 1000);
        tip.appendChild(head);
        series.forEach((s, i) => {
          const v = u.data[i + 1]?.[idx];
          const row = document.createElement("div");
          row.className = "flex items-center gap-2 leading-[18px]";
          const key = document.createElement("span");
          key.className = "inline-block h-[2px] w-3 shrink-0 rounded";
          key.style.background = colors[i]!;
          if (s.faint) key.style.opacity = "0.55";
          const val = document.createElement("span");
          val.className = "num font-semibold text-ink";
          val.textContent = v == null ? "—" : fmt(v);
          const lab = document.createElement("span");
          lab.className = "text-mute";
          lab.textContent = s.label;
          row.append(key, val, lab);
          tip.appendChild(row);
        });
        tip.classList.remove("hidden");
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const ow = u.over.clientWidth;
        let x = u.cursor.left + 12;
        if (x + w > ow) x = u.cursor.left - w - 12;
        const y = Math.max(0, Math.min((u.cursor.top ?? 0) - h / 2, u.over.clientHeight - h));
        tip.style.left = `${Math.max(0, x)}px`;
        tip.style.top = `${y}px`;
      },
    },
  };
}

export function TimeChart({
  t,
  series,
  fmt,
  height = 160,
  yMax,
  syncKey,
  loading,
  binary,
  yCeil,
}: {
  t: number[];
  series: ChartSeries[];
  fmt: (v: number) => string;
  height?: number;
  /** фиксированный максимум оси (например 100 для процентов) */
  yMax?: number;
  syncKey?: string;
  loading?: boolean;
  /** значения в байтах — деления оси кратны степеням 1024 */
  binary?: boolean;
  /** автомасштаб, но не выше этого значения (CPU %) */
  yCeil?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const { theme } = useUi();
  const hasData = useMemo(() => t.length > 1 && series.some((s) => s.values.some((v) => v != null)), [t, series]);
  const sig = series.map((s) => `${s.label}|${s.color}|${s.area}|${s.dash}|${s.faint}`).join(";");

  // пересоздание при смене темы/набора серий
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const colors = series.map((s) => cssVar(s.color));
    const grid = cssVar("--grid");
    const axis = cssVar("--mute");
    const axisFont = "10.5px 'JetBrains Mono Variable', ui-monospace, monospace";
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      padding: [8, 20, 0, 0],
      legend: { show: false },
      cursor: {
        sync: syncKey ? { key: syncKey } : undefined,
        drag: { x: false, y: false },
        points: { size: 7, width: 2, fill: cssVar("--panel") },
        y: false,
      },
      scales: {
        x: { time: true },
        y: {
          range: (_u, _min, max) => {
            if (yMax != null) return [0, yMax];
            let m = max == null || !Number.isFinite(max) || max <= 0 ? 1 : max * 1.15;
            if (yCeil != null) m = Math.min(yCeil, Math.max(m, yCeil / 10));
            return [0, m];
          },
        },
      },
      axes: [
        {
          stroke: axis,
          font: axisFont,
          grid: { show: false },
          ticks: { stroke: grid, width: 1, size: 4 },
          size: 30,
          gap: 4,
          space: 70,
          values: (u, splits) => {
            // диапазон берём из текущих данных: при смене периода график не пересоздаётся
            const xs = u.data[0];
            const span = xs.length > 1 ? xs[xs.length - 1]! - xs[0]! : 3600;
            return splits.map((s) => (span > 2 * 86400 ? fmtDay.format(s * 1000) : fmtTime.format(s * 1000)));
          },
        },
        {
          stroke: axis,
          font: axisFont,
          size: 58,
          gap: 6,
          space: 32,
          incrs: binary ? BINARY_INCRS : undefined,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map((v) => fmt(v)),
        },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: s.faint ? withAlpha(colors[i]!, 0.5) : colors[i],
          width: s.width ?? (s.faint ? 1.25 : 2),
          dash: s.dash ? [4, 4] : undefined,
          spanGaps: false,
          points: { show: false },
          fill: s.area
            ? (u: uPlot, si: number) => {
                // градиент от максимума серии вниз, чтобы заливка была видна и у низких значений
                let mx = 0;
                for (const v of u.data[si] ?? []) if (v != null && v > mx) mx = v;
                const bottom = u.bbox.top + u.bbox.height;
                const top = Math.min(u.valToPos(mx, "y", true), bottom - 1);
                const g = u.ctx.createLinearGradient(0, top, 0, bottom);
                g.addColorStop(0, withAlpha(colors[i]!, 0.24));
                g.addColorStop(1, withAlpha(colors[i]!, 0.02));
                return g;
              }
            : undefined,
        })),
      ],
      plugins: [tooltipPlugin(series, fmt, colors)],
    };
    const data = [t, ...series.map((s) => s.values)] as uPlot.AlignedData;
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => {
      if (plot.current && el.clientWidth > 0) plot.current.setSize({ width: el.clientWidth, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, sig, height, yMax, yCeil, syncKey, binary]);

  // обновление данных без пересоздания
  useEffect(() => {
    plot.current?.setData([t, ...series.map((s) => s.values)] as uPlot.AlignedData);
  }, [t, series]);

  return (
    <div className={`relative transition-opacity ${loading ? "opacity-50" : ""}`}>
      <div ref={ref} style={{ height }} />
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-mute">нет данных за период</div>
      )}
    </div>
  );
}

export function ChartCard({
  title,
  value,
  legend,
  children,
}: {
  title: string;
  value?: React.ReactNode;
  legend?: { label: string; color: string; faint?: boolean; dash?: boolean }[];
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-card px-3.5 pt-3 pb-2">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2.5">
          <h4 className="text-[13px] font-medium text-ink">{title}</h4>
          {value != null && <span className="num text-[12px] text-ink-2">{value}</span>}
        </div>
        {legend && legend.length > 1 && (
          <div className="flex flex-wrap items-center gap-3">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                <span
                  className="inline-block h-[2px] w-3.5 rounded"
                  style={{
                    background: l.dash ? `repeating-linear-gradient(90deg, var(${l.color}) 0 3px, transparent 3px 5px)` : `var(${l.color})`,
                    opacity: l.faint ? 0.55 : 1,
                  }}
                />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
