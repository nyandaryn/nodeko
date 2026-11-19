import type { ServiceSummary, Status } from "@shared/api.ts";
import {
  ChevronDown,
  Clock3,
  Cog,
  Container,
  Cpu,
  Folder,
  FolderOpen,
  Globe,
  RotateCw,
  Server,
  SquareTerminal,
  TriangleExclamationPoint,
  WifiOff,
} from "lucide-react";
import { memo, type CSSProperties, type ReactNode } from "react";
import { Meter } from "../components/ui/misc.tsx";
import { ago, bytes, dur, ms, pct, rate } from "../lib/format.ts";
import { STATUS, StatusIcon, isProblem, usageColor } from "../lib/status.tsx";
import type { Counts, TreeNode } from "./layout.ts";

export interface NodeProps {
  node: TreeNode;
  selected: boolean;
  dim: boolean;
  highlight: boolean;
  now: number;
  onToggle: (id: string) => void;
}

function shell(node: TreeNode, selected: boolean, dim: boolean, highlight: boolean, extra = ""): { className: string; style: CSSProperties } {
  const m = STATUS[node.status];
  const glow =
    node.status === "down"
      ? `0 0 0 1px color-mix(in oklab, var(--down) 55%, transparent), 0 0 24px -6px color-mix(in oklab, var(--down) 55%, transparent)`
      : node.status === "warn"
        ? `0 0 0 1px color-mix(in oklab, var(--warn) 45%, transparent), 0 0 20px -8px color-mix(in oklab, var(--warn) 50%, transparent)`
        : undefined;
  return {
    className: `tree-node absolute rounded-xl border bg-card transition-[opacity,box-shadow,border-color,transform] duration-200 hover:-translate-y-px ${
      selected ? "border-accent" : "border-line-2 hover:border-[color-mix(in_oklab,var(--line-2),var(--ink)_22%)]"
    } ${dim ? "opacity-[0.22] hover:opacity-80" : ""} ${highlight ? "node-highlight" : ""} ${node.status === "down" ? "node-pulse" : ""} ${extra}`,
    style: {
      left: node.x,
      top: node.y,
      width: node.w,
      height: node.h,
      boxShadow: selected ? "0 0 0 3px var(--accent-soft), var(--shadow)" : (glow ?? "var(--shadow)"),
      ["--ring" as string]: `color-mix(in oklab, ${m.color} 45%, transparent)`,
    },
  };
}

function Rail({ status }: { status: Status }) {
  return (
    <span
      className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-r-full"
      style={{ background: STATUS[status].color, opacity: status === "ok" ? 0.55 : 1 }}
    />
  );
}

function Chevron({ collapsed, onClick, label }: { collapsed: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      data-nopan
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-full border border-line-2 bg-panel text-mute shadow-sm transition-colors hover:border-accent hover:text-ink"
    >
      <ChevronDown size={14} className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />
    </button>
  );
}

export function CountsRow({ counts, compact = false }: { counts: Counts; compact?: boolean }) {
  const order: Status[] = ["down", "warn", "unknown", "pending", "ok", "stopped"];
  return (
    <span className="flex items-center gap-1.5">
      {order
        .filter((s) => counts[s] > 0)
        .map((s) => (
          <span key={s} className="num flex items-center gap-1 text-[11px] text-ink-2" title={STATUS[s].label}>
            <span className="h-[7px] w-[7px] rounded-full" style={{ background: STATUS[s].color }} />
            {counts[s]}
            {!compact && <span className="sr-only">{STATUS[s].label}</span>}
          </span>
        ))}
    </span>
  );
}

// ---------- server ----------

export const ServerNode = memo(function ServerNode({ node, selected, dim, highlight, now, onToggle }: NodeProps) {
  if (node.type !== "server") return null;
  const s = node.server;
  const n = s.now;
  const problems = node.counts.down + node.counts.warn + node.counts.unknown;
  const offline = s.status === "down" && !s.connected && s.enrolled;
  const sh = shell(node, selected, dim, highlight, "rounded-2xl");
  return (
    <div className={sh.className} style={sh.style} data-node={node.id}>
      <Rail status={node.status} />
      <div className="flex h-full flex-col justify-between px-4 pt-3 pb-3">
        <div className="flex items-start gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line"
            style={{ background: STATUS[node.status].soft }}
          >
            {offline ? <WifiOff size={17} style={{ color: "var(--down)" }} /> : <Server size={17} style={{ color: STATUS[node.status].color }} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold tracking-tight text-ink">{s.name}</span>
              {s.agentOutdated && (
                <span className="num rounded border border-[color-mix(in_oklab,var(--warn)_40%,transparent)] px-1 text-[9.5px] tracking-wide text-[var(--warn)] uppercase">
                  агент устарел
                </span>
              )}
            </div>
            <div className="truncate text-[11.5px] text-mute">
              {s.host ? `${s.host.hostname} · ${s.host.os.replace(/ LTS$/, "")}` : s.status === "pending" ? "агент ещё не подключался" : s.id}
            </div>
          </div>
          <StatusIcon status={node.status} size={18} className="mt-0.5 shrink-0" />
        </div>

        {s.status === "pending" ? (
          <div className="rounded-lg border border-dashed border-line-2 px-3 py-2 text-[11.5px] leading-snug text-mute">
            Ожидает подключения агента — команда установки в настройках сервера
          </div>
        ) : (
          <div className={`grid grid-cols-3 gap-3 ${offline ? "opacity-45" : ""}`}>
            {(
              [
                ["CPU", n?.cpu],
                ["RAM", n?.mem],
                ["DISK", n?.disk],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="micro !text-[9.5px]">{k}</span>
                  <span className="num text-[11.5px] text-ink">{pct(v)}</span>
                </div>
                <Meter value={v} color={usageColor(v)} />
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-[11px]">
          {offline ? (
            <span className="flex items-center gap-1.5 font-medium text-[var(--down)]">
              нет связи {s.lastSeen ? dur(now - s.lastSeen, 1) : ""}
            </span>
          ) : n ? (
            <span className="num flex min-w-0 items-center gap-2.5 truncate text-mute">
              <span title="приём">↓ {rate(n.netRx)}</span>
              <span title="отдача">↑ {rate(n.netTx)}</span>
              <span title="аптайм">up {dur(n.uptime * 1000, 1)}</span>
            </span>
          ) : (
            <span />
          )}
          {node.collapsed ? (
            <CountsRow counts={node.counts} compact />
          ) : problems > 0 ? (
            <span
              className="num flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium text-ink"
              style={{ background: node.counts.down ? "var(--down-soft)" : "var(--warn-soft)" }}
            >
              <TriangleExclamationPoint size={11} style={{ color: node.counts.down ? "var(--down)" : "var(--warn)" }} />
              {problems}
            </span>
          ) : null}
        </div>
      </div>
      {node.hasChildren && (
        <div className="absolute -bottom-3 left-1/2 -translate-x-1/2">
          <Chevron collapsed={node.collapsed} onClick={() => onToggle(node.id)} label={node.collapsed ? "Развернуть" : "Свернуть"} />
        </div>
      )}
    </div>
  );
});

export const ExternalNode = memo(function ExternalNode({ node, selected, dim, highlight, onToggle }: NodeProps) {
  if (node.type !== "external") return null;
  const sh = shell(node, selected, dim, highlight, "rounded-2xl");
  return (
    <div className={sh.className} style={sh.style} data-node={node.id}>
      <Rail status={node.status} />
      <div className="flex h-full items-center gap-3 px-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-accent-soft">
          <Globe size={17} style={{ color: "var(--accent)" }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">Внешние проверки</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mute">
            {node.total} шт. · проверяет хаб
          </div>
        </div>
        <CountsRow counts={node.counts} compact />
      </div>
      <div className="absolute -bottom-3 left-1/2 -translate-x-1/2">
        <Chevron collapsed={node.collapsed} onClick={() => onToggle(node.id)} label={node.collapsed ? "Развернуть" : "Свернуть"} />
      </div>
    </div>
  );
});

// ---------- group ----------

export const GroupNode = memo(function GroupNode({ node, selected, dim, highlight, onToggle }: NodeProps) {
  if (node.type !== "group") return null;
  const sh = shell(node, selected, dim, highlight, "cursor-pointer");
  const Icon = node.collapsed ? Folder : FolderOpen;
  return (
    <div className={sh.className} style={sh.style} data-node={node.id}>
      <div className="flex h-full items-center gap-2.5 pr-2 pl-[7px]">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-card-hi">
          <Icon size={15} className="text-ink-2" />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-ink">{node.name}</span>
          <span className="num text-[11px] text-mute">{node.size}</span>
        </div>
        {node.collapsed ? <CountsRow counts={node.counts} compact /> : <StatusIcon status={node.status} size={15} />}
        <Chevron collapsed={node.collapsed} onClick={() => onToggle(node.id)} label={node.collapsed ? "Развернуть группу" : "Свернуть группу"} />
      </div>
    </div>
  );
});

// ---------- service ----------

const KIND_ICON = { systemd: Cog, "systemd-user": SquareTerminal, docker: Container, pm2: Cpu } as const;
export const KIND_LABEL = { systemd: "systemd", "systemd-user": "systemd --user", docker: "docker", pm2: "pm2" } as const;

export function serviceIcon(s: ServiceSummary) {
  if (s.role === "job") return Clock3;
  return KIND_ICON[s.kind] ?? Cog;
}

export function serviceSubline(s: ServiceSummary, now: number): string {
  if (s.missing) return "пропал из системы";
  if (s.role === "job") {
    const mark = s.status === "down" ? "✗" : "✓";
    return s.lastRun ? `задача · ${ago(s.lastRun, now)} ${mark}` : "задача · не запускалась";
  }
  switch (s.state) {
    case "running":
      return s.since ? `up ${dur(now - s.since)}` : "работает";
    case "exited":
      return "выполнен";
    case "starting":
      return "запускается…";
    case "restarting":
      return "перезапуск…";
    case "stopping":
      return "останавливается…";
    case "failed":
      return `упал ${dur(now - s.statusSince, 1)} назад`;
    case "inactive":
      return s.status === "down" ? `не запущен ${dur(now - s.statusSince, 1)}` : "остановлен";
    default:
      return s.status === "unknown" ? "нет данных" : "—";
  }
}

function Chip({ children, tone, title }: { children: ReactNode; tone: "down" | "warn" | "neutral" | "ok"; title: string }) {
  const bg = tone === "down" ? "var(--down-soft)" : tone === "warn" ? "var(--warn-soft)" : tone === "ok" ? "var(--ok-soft)" : "var(--card-hi)";
  return (
    <span title={title} className="num flex h-[17px] items-center gap-0.5 rounded px-1 text-[10.5px] leading-none text-ink" style={{ background: bg }}>
      {children}
    </span>
  );
}

export const ServiceNode = memo(function ServiceNode({ node, selected, dim, highlight, now }: NodeProps) {
  if (node.type !== "service") return null;
  const s = node.service;
  const Icon = serviceIcon(s);
  const sh = shell(node, selected, dim, highlight, `cursor-pointer ${s.missing ? "!border-dashed" : ""}`);
  const chkOk = node.checks.filter((c) => c.status === "ok").length;
  return (
    <div className={sh.className} style={sh.style} data-node={node.id}>
      <Rail status={node.status} />
      <div className="flex h-full flex-col justify-center gap-1 pr-2.5 pl-3.5">
        <div className="flex items-center gap-2">
          <Icon size={14} className="shrink-0 text-mute" />
          <span className={`truncate text-[13px] font-medium ${s.missing ? "text-mute line-through decoration-line-2" : "text-ink"}`}>
            {s.displayName ?? s.name}
          </span>
          <StatusIcon status={node.status} size={15} className="ml-auto shrink-0" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="num min-w-0 flex-1 truncate text-[11px] text-mute">
            {serviceSubline(s, now)}
            {s.mem != null && s.state === "running" ? ` · ${bytes(s.mem)}` : ""}
          </span>
          {s.errors1h > 0 && (
            <Chip tone="down" title={`ошибок за час: ${s.errors1h}`}>
              ! {s.errors1h > 999 ? "999+" : s.errors1h}
            </Chip>
          )}
          {(s.restarts ?? 0) > 0 && (
            <Chip tone="neutral" title={`перезапусков: ${s.restarts}`}>
              <RotateCw size={9} />
              {s.restarts}
            </Chip>
          )}
          {node.checks.length > 0 && (
            <Chip tone={chkOk === node.checks.length ? "ok" : "down"} title="проверки (ok/всего)">
              <Globe size={9} />
              {chkOk}/{node.checks.length}
            </Chip>
          )}
        </div>
      </div>
    </div>
  );
});

export const CheckNode = memo(function CheckNode({ node, selected, dim, highlight }: NodeProps) {
  if (node.type !== "check") return null;
  const c = node.check;
  const sh = shell(node, selected, dim, highlight, "cursor-pointer");
  const beats = c.beats.slice(-16);
  return (
    <div className={sh.className} style={sh.style} data-node={node.id}>
      <Rail status={node.status} />
      <div className="flex h-full flex-col justify-center gap-1 pr-2.5 pl-3.5">
        <div className="flex items-center gap-2">
          <Globe size={14} className="shrink-0 text-mute" />
          <span className="truncate text-[13px] font-medium text-ink">{c.name}</span>
          <StatusIcon status={node.status} size={15} className="ml-auto shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <span className="num min-w-0 flex-1 truncate text-[11px] text-mute">
            {!c.enabled
              ? "выключена"
              : c.last
                ? c.last.ok
                  ? `${c.type === "http" ? `HTTP ${c.last.code ?? ""}` : "TCP"} · ${ms(c.last.ms)}`
                  : (c.last.err ?? "сбой")
                : "ещё не проверялась"}
          </span>
          <span className="flex h-3 shrink-0 items-end gap-px">
            {beats.map((b, i) => (
              <span key={i} className="h-full w-[3px] rounded-[1px]" style={{ background: b ? "var(--ok)" : "var(--down)", opacity: b ? 0.7 : 1 }} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
});

export function NodeView(p: NodeProps) {
  switch (p.node.type) {
    case "server":
      return <ServerNode {...p} />;
    case "external":
      return <ExternalNode {...p} />;
    case "group":
      return <GroupNode {...p} />;
    case "service":
      return <ServiceNode {...p} />;
    case "check":
      return <CheckNode {...p} />;
  }
}

export const nodeDims = (status: Status, issuesOnly: boolean, counts?: Counts) => {
  if (!issuesOnly) return false;
  if (isProblem(status) || status === "pending") return false;
  if (counts && counts.down + counts.warn + counts.unknown > 0) return false;
  return true;
};
