import type { MetricsRange } from "@shared/api.ts";
import { Globe, Pencil, ShieldCheck, Timer, Trash, TrendingUp } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { CheckFormModal } from "../components/CheckForm.tsx";
import { Heartbeat } from "../components/Heartbeat.tsx";
import { RangePicker } from "../components/RangePicker.tsx";
import { ChartCard, TimeChart } from "../components/TimeChart.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Confirm } from "../components/ui/Modal.tsx";
import { Badge, Empty, KV, Section, Stat } from "../components/ui/misc.tsx";
import { del, errMsg } from "../lib/api.ts";
import { ago, dayMonth, daysUntil, dur, ms, pct, plural } from "../lib/format.ts";
import { invalidateLive, useCheckResults, useChecks, useOverview, useSettings } from "../lib/queries.ts";
import { STATUS, StatusPill } from "../lib/status.tsx";
import { toast } from "../lib/toast.tsx";
import { EventList } from "../pages/EventsPage.tsx";
import { DrawerBody, DrawerHeader, PanelSkeleton } from "./Drawer.tsx";

export function CheckPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useChecks();
  const ov = useOverview();
  const settings = useSettings();
  const c = data?.find((x) => x.id === id);
  const [range, setRange] = useState<MetricsRange>("24h");
  const res = useCheckResults(id, range);
  const [edit, setEdit] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  if (isLoading) return <PanelSkeleton />;
  if (!c)
    return (
      <>
        <DrawerHeader icon={<Globe size={22} className="text-mute" />} title={`Проверка #${id}`} onClose={onClose} />
        <DrawerBody>
          <Empty title="Проверка не найдена" />
        </DrawerBody>
      </>
    );
  const svc = c.serviceId != null ? ov.data?.services.find((s) => s.id === c.serviceId) : null;
  const days = daysUntil(c.certExpires);
  const warnDays = settings.data?.certWarnDays ?? 14;
  return (
    <>
      <DrawerHeader
        icon={
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line" style={{ background: STATUS[c.status].soft }}>
            <Globe size={19} style={{ color: STATUS[c.status].color }} />
          </span>
        }
        title={c.name}
        subtitle={c.target}
        status={
          <>
            <StatusPill status={c.status} />
            {c.statusReason && <span className="text-[12.5px] text-ink-2">{c.statusReason}</span>}
            <span className="text-[12px] text-mute">· {ago(c.statusSince)}</span>
            {!c.enabled && <Badge tone="idle">выключена</Badge>}
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="icon-sm" onClick={() => setEdit(true)} aria-label="Редактировать" title="Редактировать">
              <Pencil size={15} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDel(true)} aria-label="Удалить" title="Удалить">
              <Trash size={15} />
            </Button>
          </>
        }
        onClose={onClose}
      />
      <div className="border-b border-line" />
      <DrawerBody scrollKey={id}>
        <div className="space-y-6">
          <div className="rounded-xl border border-line bg-card px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="micro">Последние {Math.min(60, c.beats.length)} проверок</span>
              <span className="num text-[11.5px] text-mute">каждые {dur(c.interval * 1000)}</span>
            </div>
            <Heartbeat beats={c.beats} />
            {c.last && (
              <div className="num mt-2.5 text-[12px] text-ink-2">
                {c.last.ok ? (
                  <span>
                    {c.type === "http" ? `HTTP ${c.last.code}` : "TCP соединение"} · {ms(c.last.ms)} · {ago(c.last.t)}
                  </span>
                ) : (
                  <span className="text-[var(--down)]">
                    {c.last.err ?? `HTTP ${c.last.code}`} · {ago(c.last.t)}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Аптайм 24ч" icon={<TrendingUp size={12} />} value={c.uptime24h != null ? pct(c.uptime24h) : "—"} />
            <Stat label="Аптайм 30д" icon={<TrendingUp size={12} />} value={c.uptime30d != null ? pct(c.uptime30d) : "—"} />
            <Stat label="Отклик 24ч" icon={<Timer size={12} />} value={ms(c.avgMs24h)} sub="в среднем" />
            <Stat
              label="Сертификат"
              icon={<ShieldCheck size={12} />}
              value={days != null ? <span style={{ color: days < warnDays ? "var(--warn)" : undefined }}>{days} {plural(days, "день", "дня", "дней")}</span> : "—"}
              sub={c.certExpires ? `до ${dayMonth(c.certExpires)}` : c.type === "http" ? "не https" : "—"}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="micro">Задержка и доступность</h3>
              <RangePicker value={range} onChange={setRange} ranges={["1h", "6h", "24h", "7d", "30d"]} />
            </div>
            {res.data ? (
              <>
                <ChartCard title="Время ответа">
                  <TimeChart t={res.data.t} syncKey={`chk-${id}`} loading={res.isFetching} fmt={(v) => ms(v)} series={[{ label: "задержка", values: res.data.ms, color: "--s1", area: true }]} />
                </ChartCard>
                <ChartCard title="Доступность">
                  <TimeChart
                    t={res.data.t}
                    syncKey={`chk-${id}`}
                    loading={res.isFetching}
                    yMax={100}
                    height={110}
                    fmt={(v) => `${Math.round(v)}%`}
                    series={[{ label: "успешных", values: res.data.up.map((v) => (v == null ? null : v * 100)), color: "--s1", area: true }]}
                  />
                </ChartCard>
              </>
            ) : (
              <div className="skeleton h-[200px]" />
            )}
          </div>

          <Section title="Параметры">
            <KV
              rows={[
                ["Тип", c.type.toUpperCase()],
                ["Цель", c.target, { mono: true }],
                ["Проверяет", c.runner === "hub" ? "хаб (снаружи)" : `агент ${c.runner} (изнутри)`],
                ["Под сервером", c.serverId ? <Link href={`/s/${c.serverId}`} className="text-accent hover:underline">{c.serverId}</Link> : "внешние"],
                ["Сервис", svc ? <Link href={`/svc/${svc.id}`} className="text-accent hover:underline">{svc.displayName ?? svc.name}</Link> : null],
                ["Интервал", dur(c.interval * 1000)],
                ["Таймаут", ms(c.timeout)],
                ["Коды", c.type === "http" ? (c.expect ?? "200-399") : null, { mono: true }],
                ["Ключевое слово", c.keyword, { mono: true }],
                ["Метод", c.type === "http" ? c.method : null],
                ["Повторы до сбоя", c.retries],
                ["TLS", c.insecure ? "не проверяется" : c.type === "http" ? "проверяется" : null],
              ].filter((r) => r[1] != null) as Parameters<typeof KV>[0]["rows"]}
            />
          </Section>

          <Section title="События">
            <EventList filter={{ check: c.id }} compact />
          </Section>
        </div>
      </DrawerBody>
      <CheckFormModal open={edit} onClose={() => setEdit(false)} check={c} />
      <Confirm
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title={`Удалить проверку «${c.name}»?`}
        body={<p>История результатов будет удалена.</p>}
        onConfirm={async () => {
          try {
            await del(`/api/v1/checks/${c.id}`);
            toast("Проверка удалена");
            await invalidateLive();
            onClose();
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
      />
    </>
  );
}
