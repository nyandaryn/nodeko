import type { MetricsRange, ServerDetail, ServerEnrollment } from "@shared/api.ts";
import { useMutation } from "@tanstack/react-query";
import { Activity, ArrowDownUp, Clock3, Cpu, Eye, Gauge, HardDrive, KeyRound, MemoryStick, Radio, Server, Trash, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { LinkedNotes } from "../components/LinkedNotes.tsx";
import { EnrollmentView, ThresholdsForm, draftFrom, draftToOverrides, type ThresholdDraft } from "../components/Enrollment.tsx";
import { RangePicker } from "../components/RangePicker.tsx";
import { ChartCard, TimeChart } from "../components/TimeChart.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Field, Input, Textarea } from "../components/ui/Field.tsx";
import { Confirm, Modal } from "../components/ui/Modal.tsx";
import { Badge, Empty, KV, Meter, Section, Stat, Tabs } from "../components/ui/misc.tsx";
import { del, errMsg, patch, post } from "../lib/api.ts";
import { ago, bytes, dateFull, dateTime, dur, ms, num, pct, rate } from "../lib/format.ts";
import { invalidateLive, queryClient, useOverview, useServer, useServerMetrics } from "../lib/queries.ts";
import { STATUS, StatusIcon, StatusPill, usageColor } from "../lib/status.tsx";
import { toast } from "../lib/toast.tsx";
import { serviceIcon } from "../tree/nodes.tsx";
import { DrawerBody, DrawerHeader, PanelSkeleton } from "./Drawer.tsx";

type Tab = "overview" | "charts" | "settings";

export function ServerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: s, error, isLoading } = useServer(id);
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => setTab("overview"), [id]);
  if (isLoading) return <PanelSkeleton />;
  if (error || !s)
    return (
      <>
        <DrawerHeader icon={<Server size={22} className="text-mute" />} title={id} onClose={onClose} />
        <DrawerBody>
          <Empty title="Сервер не найден">{errMsg(error)}</Empty>
        </DrawerBody>
      </>
    );
  const offline = !s.connected && s.enrolled;
  return (
    <>
      <DrawerHeader
        icon={
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line" style={{ background: STATUS[s.status].soft }}>
            {offline ? <WifiOff size={19} style={{ color: "var(--down)" }} /> : <Server size={19} style={{ color: STATUS[s.status].color }} />}
          </span>
        }
        title={s.name}
        subtitle={[...new Set([s.id, s.host?.hostname, s.host?.os].filter(Boolean))].join(" · ")}
        status={
          <>
            <StatusPill status={s.status} />
            {s.statusReason && <span className="text-[12.5px] text-ink-2">{s.statusReason}</span>}
            <span className="text-[12px] text-mute">· {ago(s.statusSince)}</span>
            {s.agentOutdated && <Badge tone="warn">агент устарел</Badge>}
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
          { value: "settings", label: "Настройки" },
        ]}
      />
      <DrawerBody scrollKey={`${id}:${tab}`}>
        {tab === "overview" && <Overview s={s} />}
        {tab === "charts" && <Charts id={s.id} />}
        {tab === "settings" && <SettingsTab s={s} onDeleted={onClose} />}
      </DrawerBody>
    </>
  );
}

function Overview({ s }: { s: ServerDetail }) {
  const n = s.now;
  const [enroll, setEnroll] = useState<ServerEnrollment | null>(null);
  const [confirmRekey, setConfirmRekey] = useState(false);
  if (s.status === "pending" && !n)
    return (
      <div className="space-y-5">
        <Empty icon={<Clock3 size={28} />} title="Агент ещё не подключался">
          Выпустите токен и выполните команду установки на сервере. Как только агент подключится, здесь появятся метрики и сервисы.
        </Empty>
        <Button variant="primary" icon={<KeyRound size={15} />} onClick={() => setConfirmRekey(true)} className="w-full justify-center">
          Выпустить токен регистрации
        </Button>
        <RekeyFlow id={s.id} confirm={confirmRekey} setConfirm={setConfirmRekey} enroll={enroll} setEnroll={setEnroll} pending />
      </div>
    );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="CPU" icon={<Cpu size={12} />} value={pct(n?.cpu)} sub={n ? `${s.host?.cores ?? "?"} ядер` : undefined} meter={{ value: n?.cpu, color: usageColor(n?.cpu, s.thresholds.cpu.pct) }} />
        <Stat
          label="RAM"
          icon={<MemoryStick size={12} />}
          value={pct(n?.mem)}
          sub={n ? `${bytes(n.memUsed)} / ${bytes(n.memTotal)}` : undefined}
          meter={{ value: n?.mem, color: usageColor(n?.mem, s.thresholds.mem.pct) }}
        />
        <Stat
          label="Swap"
          icon={<ArrowDownUp size={12} />}
          value={n && n.swapTotal > 0 ? pct((n.swapUsed / n.swapTotal) * 100) : "—"}
          sub={n ? (n.swapTotal > 0 ? `${bytes(n.swapUsed)} / ${bytes(n.swapTotal)}` : "нет swap") : undefined}
          meter={n && n.swapTotal > 0 ? { value: (n.swapUsed / n.swapTotal) * 100, color: "var(--accent)" } : undefined}
        />
        <Stat
          label="Диск /"
          icon={<HardDrive size={12} />}
          value={pct(n?.disk)}
          sub={n ? `${bytes(n.diskUsed)} / ${bytes(n.diskTotal)}` : undefined}
          meter={{ value: n?.disk, color: usageColor(n?.disk, s.thresholds.disk.pct) }}
        />
        <Stat label="Load" icon={<Gauge size={12} />} value={n ? num(n.load[0], 2) : "—"} sub={n ? `${num(n.load[1], 2)} · ${num(n.load[2], 2)}` : undefined} />
        <Stat label="Сеть" icon={<Activity size={12} />} value={n ? `↓ ${rate(n.netRx)}` : "—"} sub={n ? `↑ ${rate(n.netTx)}` : undefined} />
        <Stat label="Пинг" icon={<Radio size={12} />} value={n?.ping != null ? ms(n.ping) : "—"} sub="до интернета" />
        <Stat label="Аптайм" icon={<Clock3 size={12} />} value={n ? dur(n.uptime * 1000) : "—"} sub={n ? `${n.procs} процессов` : undefined} />
      </div>

      <LinkedNotes notes={s.linkedNotes} />

      {s.filesystems.length > 0 && (
        <Section title="Файловые системы">
          <div className="divide-y divide-line rounded-xl border border-line bg-card">
            {s.filesystems.map((f) => {
              const p = f.total ? (f.used / f.total) * 100 : 0;
              return (
                <div key={f.mount} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 px-3.5 py-2.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="num truncate text-[13px] text-ink">{f.mount}</span>
                    <span className="num truncate text-[11px] text-mute">
                      {f.dev} · {f.fstype}
                    </span>
                  </div>
                  <span className="num text-[12px] text-ink-2">
                    {bytes(f.used)} / {bytes(f.total)} · <b className="font-medium text-ink">{pct(p)}</b>
                  </span>
                  <Meter value={p} color={usageColor(p, s.thresholds.disk.pct)} className="col-span-2" />
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Трафик">
        <div className="grid grid-cols-2 gap-2.5">
          <Stat label="24 часа" value={`↓ ${bytes(s.traffic.rx24h)}`} sub={`↑ ${bytes(s.traffic.tx24h)}`} />
          <Stat label="30 дней" value={`↓ ${bytes(s.traffic.rx30d)}`} sub={`↑ ${bytes(s.traffic.tx30d)}`} />
        </div>
      </Section>

      {s.host && (
        <Section title="Хост">
          <KV
            rows={[
              ["Hostname", s.host.hostname, { mono: true }],
              ["ОС", s.host.os],
              ["Ядро", s.host.kernel, { mono: true }],
              ["Процессор", `${s.host.cpuModel} · ${s.host.cores} ядер · ${s.host.arch}`],
              ["Память", bytes(s.host.memTotal)],
              ["Загрузка", `${dateTime(s.host.bootTime)} (${ago(s.host.bootTime)})`],
              ["Пользователь", s.host.user, { mono: true }],
              [
                "Доступно агенту",
                <span className="flex flex-wrap gap-1">
                  {Object.entries(s.host.caps).map(([k, v]) => (
                    <Badge key={k} tone={v ? "ok" : "idle"} title={v ? "доступно" : "нет доступа"}>
                      {v ? "✓" : "✗"} {k}
                    </Badge>
                  ))}
                </span>,
              ],
            ]}
          />
        </Section>
      )}

      <Section
        title="Агент"
        actions={
          <Button size="sm" variant="secondary" icon={<KeyRound size={13} />} onClick={() => setConfirmRekey(true)}>
            Перевыпустить токен
          </Button>
        }
      >
        <KV
          rows={[
            ["Версия", s.host ? <span className="num">{s.host.agentVersion}{s.agentOutdated && <Badge tone="warn" className="ml-2">устарел</Badge>}</span> : null],
            ["Соединение", s.connected ? `подключён ${s.connectedAt ? ago(s.connectedAt) : ""}` : `нет связи, последний раз ${ago(s.lastSeen)}`],
            ["Адрес", s.remoteAddr, { mono: true }],
            ["RTT хаб ↔ агент", s.rtt != null ? ms(s.rtt) : null, { mono: true }],
            ["Ключ агента", s.agentKeyFingerprint, { mono: true }],
            ["Последние данные", s.lastSeen ? <span title={dateFull(s.lastSeen)}>{ago(s.lastSeen)}</span> : null],
          ]}
        />
      </Section>
      <RekeyFlow id={s.id} confirm={confirmRekey} setConfirm={setConfirmRekey} enroll={enroll} setEnroll={setEnroll} />
    </div>
  );
}

function RekeyFlow({
  id,
  confirm,
  setConfirm,
  enroll,
  setEnroll,
  pending,
}: {
  id: string;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  enroll: ServerEnrollment | null;
  setEnroll: (e: ServerEnrollment | null) => void;
  pending?: boolean;
}) {
  return (
    <>
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        danger={!pending}
        confirmLabel="Выпустить токен"
        title={pending ? "Токен регистрации" : "Перевыпустить токен агента?"}
        body={
          pending ? (
            <p>Будет создан одноразовый токен для регистрации агента. Предыдущий неиспользованный токен перестанет действовать.</p>
          ) : (
            <p>
              Текущий ключ агента будет <b className="text-ink">отозван</b> — агент отключится, пока его не переустановят с новым токеном.
            </p>
          )
        }
        onConfirm={async () => {
          try {
            const e = await post<ServerEnrollment>(`/api/v1/servers/${encodeURIComponent(id)}/enroll`);
            setEnroll(e);
            invalidateLive();
          } catch (err) {
            toast.error(errMsg(err));
          }
        }}
      />
      <Modal open={!!enroll} onClose={() => setEnroll(null)} title="Установка агента" width={620} footer={<Button onClick={() => setEnroll(null)}>Готово</Button>}>
        {enroll && <EnrollmentView e={enroll} />}
      </Modal>
    </>
  );
}

function Charts({ id }: { id: string }) {
  const [range, setRange] = useState<MetricsRange>("6h");
  const { data: m, isFetching, isLoading } = useServerMetrics(id, range);
  const sync = `srv-${id}`;
  const last = (a?: (number | null)[]) => {
    if (!a) return null;
    for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]!;
    return null;
  };
  return (
    <div className="space-y-3">
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 flex items-center justify-between border-b border-line bg-panel/95 px-5 py-2.5 backdrop-blur">
        <RangePicker value={range} onChange={setRange} />
        <span className="text-[11.5px] text-mute">{m ? `шаг ${dur(m.step * 1000)}` : ""}</span>
      </div>
      {isLoading || !m ? (
        Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-[200px]" />)
      ) : (
        <>
          <ChartCard
            title="CPU"
            value={pct(last(m.cpu))}
            legend={[
              { label: "среднее", color: "--s1" },
              { label: "максимум", color: "--s1", faint: true },
            ]}
          >
            <TimeChart
              t={m.t}
              syncKey={sync}
              loading={isFetching}
              yCeil={100}
              fmt={(v) => `${Math.round(v)}%`}
              series={[
                { label: "среднее", values: m.cpu, color: "--s1", area: true },
                { label: "максимум", values: m.cpuMax, color: "--s1", faint: true },
              ]}
            />
          </ChartCard>
          <ChartCard title="Память" value={pct(last(m.mem))}>
            <TimeChart t={m.t} syncKey={sync} loading={isFetching} yMax={100} fmt={(v) => `${Math.round(v)}%`} series={[{ label: "RAM", values: m.mem, color: "--s1", area: true }]} />
          </ChartCard>
          <ChartCard title="Диск /" value={pct(last(m.disk))}>
            <TimeChart t={m.t} syncKey={sync} loading={isFetching} yMax={100} fmt={(v) => `${Math.round(v)}%`} series={[{ label: "заполнение", values: m.disk, color: "--s1", area: true }]} />
          </ChartCard>
          <ChartCard
            title="Дисковый ввод-вывод"
            legend={[
              { label: "чтение", color: "--s1" },
              { label: "запись", color: "--s2" },
            ]}
          >
            <TimeChart
              t={m.t}
              syncKey={sync}
              loading={isFetching}
              binary
              fmt={(v) => rate(v)}
              series={[
                { label: "чтение", values: m.diskRead, color: "--s1" },
                { label: "запись", values: m.diskWrite, color: "--s2" },
              ]}
            />
          </ChartCard>
          <ChartCard
            title="Сеть"
            legend={[
              { label: "приём", color: "--s1" },
              { label: "отдача", color: "--s2" },
            ]}
          >
            <TimeChart
              t={m.t}
              syncKey={sync}
              loading={isFetching}
              binary
              fmt={(v) => rate(v)}
              series={[
                { label: "приём", values: m.netRx, color: "--s1" },
                { label: "отдача", values: m.netTx, color: "--s2" },
              ]}
            />
          </ChartCard>
          <ChartCard title="Load average (1 мин)" value={num(last(m.load1), 2)}>
            <TimeChart t={m.t} syncKey={sync} loading={isFetching} fmt={(v) => num(v, 2)} series={[{ label: "load1", values: m.load1, color: "--s1", area: true }]} />
          </ChartCard>
          <ChartCard title="Пинг до интернета" value={ms(last(m.ping))}>
            <TimeChart t={m.t} syncKey={sync} loading={isFetching} fmt={(v) => ms(v)} series={[{ label: "задержка", values: m.ping, color: "--s1", area: true }]} />
          </ChartCard>
        </>
      )}
    </div>
  );
}

function SettingsTab({ s, onDeleted }: { s: ServerDetail; onDeleted: () => void }) {
  const [name, setName] = useState(s.name);
  const [desc, setDesc] = useState(s.description ?? "");
  const [sort, setSort] = useState(String(s.sort));
  const [d, setD] = useState<ThresholdDraft>(() => draftFrom(s.overrides));
  const [confirmDel, setConfirmDel] = useState(false);
  const [, nav] = useLocation();
  const all = useOverview(true);
  const hidden = useMemo(() => (all.data?.services ?? []).filter((x) => x.serverId === s.id && !x.tracked), [all.data, s.id]);
  const base = s.thresholds;

  const save = useMutation({
    mutationFn: () =>
      patch(`/api/v1/servers/${encodeURIComponent(s.id)}`, {
        name: name.trim(),
        description: desc.trim() || null,
        sort: Number(sort) || 0,
        overrides: draftToOverrides(d, base),
      }),
    onSuccess: () => {
      toast("Сохранено");
      invalidateLive();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="space-y-7">
      <Section title="Основное">
        <div className="space-y-3.5">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Название">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </Field>
            <Field label="Порядок" help="Меньше — выше">
              <Input value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ""))} inputMode="numeric" className="num" />
            </Field>
          </div>
          <Field label="Описание">
            <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} placeholder="Для чего этот сервер" />
          </Field>
        </div>
      </Section>

      <Section title="Пороги сервера" desc="Пустое поле — значение по умолчанию (показано серым).">
        <div className="rounded-xl border border-line bg-card px-3.5">
          <ThresholdsForm d={d} set={setD} placeholders={base} />
        </div>
      </Section>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setD(draftFrom(null))}>
          Сбросить пороги
        </Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!name.trim()}>
          Сохранить
        </Button>
      </div>

      <Section title={`Скрытые сервисы · ${hidden.length}`} desc="Обнаружены агентом, но не показываются в дереве и не шлют уведомления.">
        {hidden.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-2 px-4 py-5 text-center text-[12.5px] text-mute">Скрытых сервисов нет</div>
        ) : (
          <div className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-xl border border-line bg-card">
            {hidden.map((x) => {
              const Icon = serviceIcon(x);
              return (
                <div key={x.id} className="flex items-center gap-3 px-3.5 py-2">
                  <Icon size={14} className="shrink-0 text-mute" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{x.displayName ?? x.name}</div>
                    <div className="num truncate text-[11px] text-mute">{x.key}</div>
                  </div>
                  <StatusIcon status={x.status} size={14} />
                  <Button
                    size="sm"
                    variant="subtle"
                    icon={<Eye size={13} />}
                    onClick={async () => {
                      try {
                        await patch(`/api/v1/services/${x.id}`, { tracked: true });
                        toast(`«${x.name}» снова отслеживается`);
                        await Promise.all([invalidateLive(), queryClient.invalidateQueries({ queryKey: ["overview", true] })]);
                      } catch (e) {
                        toast.error(errMsg(e));
                      }
                    }}
                  >
                    Отслеживать
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Опасная зона">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[color-mix(in_oklab,var(--down)_35%,transparent)] bg-down-soft px-4 py-3">
          <div>
            <div className="text-[13.5px] font-medium">Удалить сервер</div>
            <div className="text-[12px] text-ink-2">Вся история метрик, сервисы и события сервера будут удалены. Агент будет отключён.</div>
          </div>
          <Button variant="danger" icon={<Trash size={14} />} onClick={() => setConfirmDel(true)}>
            Удалить
          </Button>
        </div>
      </Section>
      <Confirm
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title={`Удалить сервер ${s.name}?`}
        body={<p>Действие необратимо.</p>}
        typeToConfirm={s.id}
        onConfirm={async () => {
          try {
            await del(`/api/v1/servers/${encodeURIComponent(s.id)}`);
            toast("Сервер удалён");
            await invalidateLive();
            onDeleted();
            nav("/");
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
      />
    </div>
  );
}
