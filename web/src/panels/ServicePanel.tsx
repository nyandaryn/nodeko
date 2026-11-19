import type { CheckSummary, MetricsRange, ServiceDetail } from "@shared/api.ts";
import { useMutation } from "@tanstack/react-query";
import { BellOff, ChevronRight, CircleDot, Clock3, Cpu, Eraser, MemoryStick, ScrollText, TriangleExclamationPoint } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Heartbeat } from "../components/Heartbeat.tsx";
import { RangePicker } from "../components/RangePicker.tsx";
import { ChartCard, TimeChart } from "../components/TimeChart.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Field, Input, Select, Switch, Textarea } from "../components/ui/Field.tsx";
import { Confirm } from "../components/ui/Modal.tsx";
import { Badge, Empty, KV, Section, Stat, Tabs } from "../components/ui/misc.tsx";
import { del, errMsg, patch } from "../lib/api.ts";
import { ago, bytes, dateFull, dateTime, dur, ms, num, pct, timeOnly } from "../lib/format.ts";
import { invalidateLive, useService, useServiceLogs, useServiceMetrics } from "../lib/queries.ts";
import { STATUS, StatusIcon, StatusPill } from "../lib/status.tsx";
import { toast } from "../lib/toast.tsx";
import { KIND_LABEL, serviceIcon, serviceSubline } from "../tree/nodes.tsx";
import { EventList } from "../pages/EventsPage.tsx";
import { DrawerBody, DrawerHeader, PanelSkeleton } from "./Drawer.tsx";

type Tab = "overview" | "charts" | "errors" | "events" | "settings";

export function ServicePanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: s, error, isLoading } = useService(id);
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => setTab("overview"), [id]);
  if (isLoading) return <PanelSkeleton />;
  if (error || !s)
    return (
      <>
        <DrawerHeader icon={<CircleDot size={22} className="text-mute" />} title={`Сервис #${id}`} onClose={onClose} />
        <DrawerBody>
          <Empty title="Сервис не найден">{errMsg(error)}</Empty>
        </DrawerBody>
      </>
    );
  const Icon = serviceIcon(s);
  return (
    <>
      <DrawerHeader
        icon={
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line" style={{ background: STATUS[s.status].soft }}>
            <Icon size={19} style={{ color: STATUS[s.status].color }} />
          </span>
        }
        title={s.displayName ?? s.name}
        subtitle={
          <span>
            <Link href={`/s/${encodeURIComponent(s.serverId)}`} className="hover:text-ink hover:underline">
              {s.serverId}
            </Link>
            {s.group ? ` / ${s.group}` : ""} · {s.key}
          </span>
        }
        status={
          <>
            <StatusPill status={s.status} />
            {s.statusReason && <span className="text-[12.5px] text-ink-2">{s.statusReason}</span>}
            <span className="text-[12px] text-mute">· {ago(s.statusSince)}</span>
            {s.muted && (
              <Badge tone="idle">
                <BellOff size={11} /> без уведомлений
              </Badge>
            )}
            {!s.tracked && <Badge tone="idle">скрыт</Badge>}
          </>
        }
        onClose={onClose}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Обзор" },
          { value: "charts", label: "Графики" },
          { value: "errors", label: "Ошибки", count: s.errors1h, tone: "down" },
          { value: "events", label: "События" },
          { value: "settings", label: "Настройки" },
        ]}
      />
      <DrawerBody scrollKey={`${id}:${tab}`}>
        {tab === "overview" && <Overview s={s} />}
        {tab === "charts" && <Charts id={s.id} />}
        {tab === "errors" && <Errors s={s} />}
        {tab === "events" && <EventList filter={{ service: s.id }} compact />}
        {tab === "settings" && <SettingsTab s={s} onClose={onClose} />}
      </DrawerBody>
    </>
  );
}

function Overview({ s }: { s: ServiceDetail }) {
  const now = Date.now();
  const [forget, setForget] = useState(false);
  return (
    <div className="space-y-6">
      {s.missing && (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-line-2 bg-sunken px-4 py-3">
          <TriangleExclamationPoint size={16} className="mt-0.5 shrink-0 text-[var(--warn)]" />
          <div className="flex-1 text-[12.5px] leading-relaxed text-ink-2">
            Агент больше не видит этот сервис — юнит или контейнер удалён. Если так и задумано, его можно забыть.
          </div>
          <Button size="sm" variant="secondary" icon={<Eraser size={13} />} onClick={() => setForget(true)}>
            Забыть
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat
          label={s.role === "job" ? "Посл. запуск" : "Аптайм"}
          icon={<Clock3 size={12} />}
          value={s.role === "job" ? (s.lastRun ? ago(s.lastRun, now) : "—") : s.since && s.state === "running" ? dur(now - s.since) : "—"}
          sub={s.role !== "job" && s.state === "running" && s.since ? `с ${dateTime(s.since)}` : serviceSubline(s, now)}
        />
        <Stat label="CPU" icon={<Cpu size={12} />} value={pct(s.cpu)} sub="одного ядра" />
        <Stat label="Память" icon={<MemoryStick size={12} />} value={bytes(s.mem)} sub={s.tasks != null ? `${s.tasks} потоков` : undefined} />
        <Stat
          label="Ошибки / ч"
          icon={<ScrollText size={12} />}
          value={<span style={{ color: s.errors1h ? "var(--down)" : undefined }}>{s.errors1h}</span>}
          sub={s.logRate != null ? `${num(s.logRate)} строк/мин` : undefined}
        />
      </div>

      {s.checkList.length > 0 && (
        <Section title="Проверки">
          <div className="space-y-2">
            {s.checkList.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Детали">
        <KV
          rows={[
            ["Состояние", s.raw, { mono: true }],
            ["Источник", `${KIND_LABEL[s.kind]}${s.vendor ? " · пакетный юнит" : ""}`],
            s.role === "job"
              ? ["Последний запуск", s.lastRun ? `${dateTime(s.lastRun)} · ${s.result ?? "—"}${s.exitCode != null ? ` (код ${s.exitCode})` : ""}` : null]
              : ["Запущен", s.since ? <span title={dateFull(s.since)}>{dateTime(s.since)}</span> : null],
            ["PID", s.pid, { mono: true }],
            ["Порты", s.ports.length ? s.ports.map((p) => `:${p}`).join("  ") : null, { mono: true }],
            ["Перезапуски", s.restarts, { mono: true }],
            ["Версия", s.version, { mono: true }],
            [
              "Коммит",
              s.commit ? (
                <span className="num">
                  {s.commit}
                  {s.commitAt && <span className="text-mute"> · {dateTime(s.commitAt)}</span>}
                </span>
              ) : null,
            ],
            ["Рантайм", s.runtime, { mono: true }],
            ["Образ", s.image, { mono: true }],
            ["Health", s.health],
            ["Автозапуск", s.enabled, { mono: true }],
            ["Рабочая папка", s.cwd, { mono: true }],
            ["Команда", s.exec, { mono: true }],
            ["Описание", s.description],
            ["Впервые замечен", <span title={dateFull(s.firstSeen)}>{ago(s.firstSeen)}</span>],
          ].filter((r) => r[1] != null && r[1] !== "") as Parameters<typeof KV>[0]["rows"]}
        />
      </Section>

      {s.notes && (
        <Section title="Заметки">
          <div className="rounded-xl border border-line bg-card px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">{s.notes}</div>
        </Section>
      )}
      <ForgetConfirm s={s} open={forget} setOpen={setForget} />
    </div>
  );
}

export function CheckRow({ c }: { c: CheckSummary }) {
  return (
    <Link
      href={`/chk/${c.id}`}
      className="block rounded-xl border border-line bg-card px-3.5 py-3 transition-colors hover:border-line-2 hover:bg-card-hi"
    >
      <div className="mb-2 flex items-center gap-2">
        <StatusIcon status={c.status} size={15} />
        <span className="truncate text-[13px] font-medium">{c.name}</span>
        <span className="num ml-auto truncate text-[11px] text-mute">{c.target}</span>
        <ChevronRight size={14} className="shrink-0 text-mute" />
      </div>
      <Heartbeat beats={c.beats} slots={60} height={18} />
      <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-mute">
        <span>
          24ч <b className="font-medium text-ink">{c.uptime24h != null ? pct(c.uptime24h) : "—"}</b>
        </span>
        <span>
          30д <b className="font-medium text-ink">{c.uptime30d != null ? pct(c.uptime30d) : "—"}</b>
        </span>
        <span>
          среднее <b className="font-medium text-ink">{ms(c.avgMs24h)}</b>
        </span>
        {c.last && !c.last.ok && <span className="text-[var(--down)]">{c.last.err ?? `HTTP ${c.last.code}`}</span>}
      </div>
    </Link>
  );
}

function Charts({ id }: { id: number }) {
  const [range, setRange] = useState<MetricsRange>("6h");
  const { data: m, isFetching, isLoading } = useServiceMetrics(id, range);
  return (
    <div className="space-y-3">
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 flex items-center justify-between border-b border-line bg-panel/95 px-5 py-2.5 backdrop-blur">
        <RangePicker value={range} onChange={setRange} ranges={["1h", "6h", "24h", "7d", "30d"]} />
        <span className="text-[11.5px] text-mute">{m ? `шаг ${dur(m.step * 1000)}` : ""}</span>
      </div>
      {isLoading || !m ? (
        <>
          <div className="skeleton h-[200px]" />
          <div className="skeleton h-[200px]" />
        </>
      ) : (
        <>
          <ChartCard
            title="CPU"
            legend={[
              { label: "среднее", color: "--s1" },
              { label: "максимум", color: "--s1", faint: true },
            ]}
          >
            <TimeChart
              t={m.t}
              syncKey={`svc-${id}`}
              loading={isFetching}
              fmt={(v) => `${num(v)}%`}
              series={[
                { label: "среднее", values: m.cpu, color: "--s1", area: true },
                { label: "максимум", values: m.cpuMax, color: "--s1", faint: true },
              ]}
            />
          </ChartCard>
          <ChartCard
            title="Память"
            legend={[
              { label: "среднее", color: "--s1" },
              { label: "максимум", color: "--s1", faint: true },
            ]}
          >
            <TimeChart
              t={m.t}
              syncKey={`svc-${id}`}
              loading={isFetching}
              binary
              fmt={(v) => bytes(v)}
              series={[
                { label: "среднее", values: m.mem, color: "--s1", area: true },
                { label: "максимум", values: m.memMax, color: "--s1", faint: true },
              ]}
            />
          </ChartCard>
        </>
      )}
    </div>
  );
}

const PRIO = ["emerg", "alert", "crit", "err", "warn", "notice", "info", "debug"];

function Errors({ s }: { s: ServiceDetail }) {
  const logs = useServiceLogs(s.id);
  const items = logs.data?.pages.flat() ?? [];
  const max = Math.max(1, ...s.errorsHourly);
  const total = s.errorsHourly.reduce((a, b) => a + b, 0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-card px-3.5 pt-3 pb-2.5">
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-[13px] font-medium">Ошибки за 24 часа</h4>
          <span className="num text-[12px] text-mute">
            всего <b className="font-medium text-ink">{total}</b>
          </span>
        </div>
        <div className="flex h-16 items-end gap-[3px]">
          {s.errorsHourly.map((v, i) => {
            const h = new Date(Date.now() - (23 - i) * 3_600_000);
            return (
              <div key={i} className="group relative flex h-full flex-1 items-end" title={`${h.getHours()}:00 — ${v}`}>
                <div
                  className="w-full rounded-t-[3px] transition-opacity group-hover:opacity-80"
                  style={{ height: v ? `${Math.max(6, (v / max) * 100)}%` : "2px", background: v ? "var(--down)" : "var(--line-2)" }}
                />
              </div>
            );
          })}
        </div>
        <div className="num mt-1.5 flex justify-between text-[10px] text-mute">
          <span>−24ч</span>
          <span>−12ч</span>
          <span>сейчас</span>
        </div>
      </div>

      {logs.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty icon={<ScrollText size={26} />} title="Ошибок нет">
          Агент ищет в журнале строки с приоритетом err и выше или подходящие под шаблон ошибок (Настройки → Общие).
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-sunken">
          {items.map((l) => {
            const isOpen = open.has(l.id);
            return (
              <button
                key={l.id}
                onClick={() =>
                  setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(l.id)) n.delete(l.id);
                    else n.add(l.id);
                    return n;
                  })
                }
                className="block w-full border-b border-line px-3.5 py-2 text-left last:border-b-0 hover:bg-card"
              >
                <div className="num mb-0.5 flex items-center gap-2 text-[10.5px] text-mute">
                  <span title={dateFull(l.ts)}>
                    {dateTime(l.ts).split(",")[0]} {timeOnly(l.ts)}
                  </span>
                  <span
                    className="rounded px-1 uppercase"
                    style={{ background: l.prio <= 3 ? "var(--down-soft)" : "var(--warn-soft)", color: "var(--ink)" }}
                  >
                    {PRIO[l.prio] ?? l.prio}
                  </span>
                </div>
                <div className={`num text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink ${isOpen ? "" : "line-clamp-3"}`}>{l.msg}</div>
              </button>
            );
          })}
        </div>
      )}
      {logs.hasNextPage && (
        <Button variant="subtle" className="w-full justify-center" loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
          Показать ещё
        </Button>
      )}
    </div>
  );
}

type GroupMode = "auto" | "none" | "custom";

function SettingsTab({ s, onClose }: { s: ServiceDetail; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(s.displayName ?? "");
  const [mode, setMode] = useState<GroupMode>(s.group ? "custom" : "none");
  const [group, setGroup] = useState(s.group ?? "");
  const [tracked, setTracked] = useState(s.tracked);
  const [muted, setMuted] = useState(s.muted);
  const [sort, setSort] = useState(String(s.sort));
  const [notes, setNotes] = useState(s.notes ?? "");
  const [forget, setForget] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      patch(`/api/v1/services/${s.id}`, {
        displayName: displayName.trim() || null,
        group: mode === "auto" ? null : mode === "none" ? "" : group.trim(),
        tracked,
        muted,
        sort: Number(sort) || 0,
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast("Сохранено");
      invalidateLive();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-6">
      <div className="space-y-3.5">
        <Field label="Отображаемое имя" hint={`по умолчанию: ${s.name}`}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={s.name} maxLength={64} />
        </Field>
        <Field label="Группа в дереве" help="Авто — по префиксу имени (shop-api → shop), если таких сервисов на сервере хотя бы два.">
          <div className="flex gap-2">
            <Select value={mode} onChange={(e) => setMode(e.target.value as GroupMode)} className="!w-[170px] shrink-0">
              <option value="auto">Авто</option>
              <option value="none">Без группы</option>
              <option value="custom">Своя…</option>
            </Select>
            {mode === "custom" && <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="имя группы" maxLength={40} />}
          </div>
        </Field>
        <Field label="Порядок" help="Меньше — выше">
          <Input value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ""))} className="num !w-[120px]" inputMode="numeric" />
        </Field>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-card px-3.5 py-1">
        <div className="py-2">
          <Switch checked={tracked} onChange={setTracked} label="Отслеживать" desc="Показывать в дереве и учитывать в статусе сервера." />
        </div>
        <div className="py-2">
          <Switch checked={muted} onChange={setMuted} label="Без уведомлений" desc="Статус продолжает обновляться, но в Telegram ничего не уходит." />
        </div>
      </div>
      <Field label="Заметки" hint="видны вам и ИИ-агенту">
        <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder="Например: падает при обновлении каталога, рестарт безопасен" />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" icon={<Eraser size={14} />} onClick={() => setForget(true)}>
          Забыть сервис
        </Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={mode === "custom" && !group.trim()}>
          Сохранить
        </Button>
      </div>
      <ForgetConfirm s={s} open={forget} setOpen={setForget} onDone={onClose} />
    </div>
  );
}

function ForgetConfirm({ s, open, setOpen, onDone }: { s: ServiceDetail; open: boolean; setOpen: (v: boolean) => void; onDone?: () => void }) {
  return (
    <Confirm
      open={open}
      onClose={() => setOpen(false)}
      title={`Забыть «${s.displayName ?? s.name}»?`}
      confirmLabel="Забыть"
      body={
        <p>
          История метрик и ошибок сервиса будет удалена. {s.missing ? "" : "Если агент снова увидит сервис, он появится заново как новый."}
        </p>
      }
      onConfirm={async () => {
        try {
          await del(`/api/v1/services/${s.id}`);
          toast("Сервис забыт");
          await invalidateLive();
          onDone?.();
        } catch (e) {
          toast.error(errMsg(e));
        }
      }}
    />
  );
}

