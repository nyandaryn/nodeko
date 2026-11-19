import type { EventItem, EventLevel } from "@shared/api.ts";
import { Bell, CircleCheck, CircleX, Info, TriangleExclamationPoint } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "../components/ui/Button.tsx";
import { Segmented, Select } from "../components/ui/Field.tsx";
import { Empty } from "../components/ui/misc.tsx";
import { ago, dateFull, dayLabel, timeOnly } from "../lib/format.ts";
import { useEvents, useOverview, type EventFilter } from "../lib/queries.ts";

const LEVEL: Record<EventLevel, { icon: typeof Info; color: string; label: string }> = {
  error: { icon: CircleX, color: "var(--down)", label: "Ошибка" },
  warn: { icon: TriangleExclamationPoint, color: "var(--warn)", label: "Предупреждение" },
  ok: { icon: CircleCheck, color: "var(--ok)", label: "Восстановление" },
  info: { icon: Info, color: "var(--accent)", label: "Инфо" },
};

function targetHref(e: EventItem): string | null {
  if (e.checkId != null) return `/chk/${e.checkId}`;
  if (e.serviceId != null) return `/svc/${e.serviceId}`;
  if (e.serverId) return `/s/${encodeURIComponent(e.serverId)}`;
  return null;
}

function EventRow({ e, compact, serverName }: { e: EventItem; compact?: boolean; serverName?: string }) {
  const [, nav] = useLocation();
  const L = LEVEL[e.level] ?? LEVEL.info;
  const Icon = L.icon;
  const href = targetHref(e);
  return (
    <button
      disabled={!href}
      onClick={() => href && nav(href)}
      className="group grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-2.5 text-left transition-colors enabled:hover:bg-card-hi"
    >
      <Icon size={16} style={{ color: L.color }} className="mt-0.5" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px] text-ink">{e.title}</span>
          {!compact && serverName && <span className="num text-[11px] text-mute">{serverName}</span>}
        </div>
        {e.message && <div className="mt-0.5 line-clamp-2 text-[12.5px] break-words text-ink-2">{e.message}</div>}
        <div className="num mt-0.5 text-[10.5px] text-mute">
          {e.type}
          {e.actor ? ` · ${e.actor}` : ""}
        </div>
      </div>
      <div className="num text-right text-[11.5px] whitespace-nowrap text-mute" title={dateFull(e.ts)}>
        {compact ? ago(e.ts) : timeOnly(e.ts)}
      </div>
    </button>
  );
}

export function EventList({ filter, compact }: { filter: EventFilter; compact?: boolean }) {
  const q = useEvents(filter, compact ? 20 : 50);
  const ov = useOverview();
  const names = useMemo(() => new Map((ov.data?.servers ?? []).map((s) => [s.id, s.name])), [ov.data]);
  const items = q.data?.pages.flat() ?? [];
  if (q.isLoading)
    return (
      <div className="space-y-2">
        {Array.from({ length: compact ? 4 : 8 }, (_, i) => (
          <div key={i} className="skeleton h-12" />
        ))}
      </div>
    );
  if (!items.length)
    return (
      <Empty icon={<Bell size={26} />} title="Событий нет">
        Здесь появятся падения и восстановления, перезапуски, превышения порогов и изменения настроек.
      </Empty>
    );
  const groups: { day: string; items: EventItem[] }[] = [];
  for (const e of items) {
    const day = dayLabel(e.ts);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return (
    <div className="space-y-4">
      {compact ? (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {items.map((e) => (
            <EventRow key={e.id} e={e} compact />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day}>
            <h3 className="micro mb-2 px-1 first-letter:uppercase">{g.day}</h3>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {g.items.map((e) => (
                <EventRow key={e.id} e={e} serverName={e.serverId ? (names.get(e.serverId) ?? e.serverId) : undefined} />
              ))}
            </div>
          </section>
        ))
      )}
      {q.hasNextPage && (
        <Button variant="subtle" className="w-full justify-center" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          Показать ещё
        </Button>
      )}
    </div>
  );
}

export function EventsPage() {
  const [level, setLevel] = useState<"" | EventLevel>("");
  const [server, setServer] = useState("");
  const ov = useOverview();
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-[920px] px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">События</h1>
            <p className="mt-1 text-[13px] text-mute">Падения, восстановления, пороги и изменения конфигурации — обновляется автоматически.</p>
          </div>
        </div>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: "", label: "Все" },
              { value: "error", label: "Ошибки" },
              { value: "warn", label: "Предупр." },
              { value: "ok", label: "Восстановл." },
              { value: "info", label: "Инфо" },
            ]}
          />
          <Select value={server} onChange={(e) => setServer(e.target.value)} className="!h-8 !w-[200px] text-[13px]">
            <option value="">Все серверы</option>
            {(ov.data?.servers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <EventList filter={{ level: level || undefined, server: server || undefined }} />
      </div>
    </div>
  );
}
