import type { NotifyEvents, Settings, SettingsPatch } from "@shared/api.ts";
import { DEFAULT_LOG_PATTERN } from "@shared/protocol.ts";
import { Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ThresholdsForm, draftFrom, draftToFull, type ThresholdDraft } from "../../components/Enrollment.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Input, Switch, Textarea } from "../../components/ui/Field.tsx";
import { Badge, Card, Section, Skeleton } from "../../components/ui/misc.tsx";
import { errMsg, patch, post } from "../../lib/api.ts";
import { qk, queryClient, useSettings } from "../../lib/queries.ts";
import { toast } from "../../lib/toast.tsx";
import { SaveBar, SettingsHeader } from "../SettingsPage.tsx";

async function saveSettings(p: SettingsPatch) {
  const s = await patch<Settings>("/api/v1/settings", p);
  queryClient.setQueryData(qk.settings, s);
  toast("Настройки сохранены");
  return s;
}

function useDraft<T>(source: T | undefined, map: (s: T) => Record<string, unknown>) {
  const initial = useMemo(() => (source ? map(source) : null), [source]); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<Record<string, unknown> | null>(initial);
  useEffect(() => setD(initial), [initial]);
  const dirty = !!d && !!initial && JSON.stringify(d) !== JSON.stringify(initial);
  return { d, setD, dirty, reset: () => setD(initial) };
}

function Loading() {
  return (
    <div className="space-y-4 md:pt-[46px]">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}

const numOnly = (v: string) => v.replace(/[^\d]/g, "");

// ---------- Общие ----------

export function GeneralSettings() {
  const { data: s } = useSettings();
  const { d, setD, dirty, reset } = useDraft(s, (s) => ({
    publicUrl: s.publicUrl,
    agentInterval: String(s.agentInterval),
    pingTarget: s.pingTarget,
    logPattern: s.logPattern,
    serviceDownDelay: String(s.serviceDownDelay),
    certWarnDays: String(s.certWarnDays),
    rawHours: String(s.retention.rawHours),
    minuteDays: String(s.retention.minuteDays),
    quarterDays: String(s.retention.quarterDays),
    eventsDays: String(s.retention.eventsDays),
    logsDays: String(s.retention.logsDays),
  }));
  const [busy, setBusy] = useState(false);
  if (!s || !d) return <Loading />;
  const v = (k: string) => String(d[k] ?? "");
  const set = (k: string, val: string) => setD({ ...d, [k]: val });
  const save = async () => {
    setBusy(true);
    try {
      await saveSettings({
        publicUrl: v("publicUrl").trim(),
        agentInterval: Number(v("agentInterval")),
        pingTarget: v("pingTarget").trim(),
        logPattern: v("logPattern"),
        serviceDownDelay: Number(v("serviceDownDelay")),
        certWarnDays: Number(v("certWarnDays")),
        retention: {
          rawHours: Number(v("rawHours")),
          minuteDays: Number(v("minuteDays")),
          quarterDays: Number(v("quarterDays")),
          eventsDays: Number(v("eventsDays")),
          logsDays: Number(v("logsDays")),
        },
      });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsHeader title="Общие" desc="Адрес хаба, частота сбора и хранение истории." />
      <div className="space-y-7">
        <Card>
          <div className="space-y-4">
            <Field label="Публичный адрес хаба" help="Используется в командах установки агентов, ссылках уведомлений и для passkeys.">
              <Input value={v("publicUrl")} onChange={(e) => set("publicUrl", e.target.value)} className="num" placeholder="https://nodeko.example.com" />
            </Field>
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <Field label="Интервал снимков агента" hint="секунды" help="Чаще — подробнее графики и быстрее реакция.">
                <Input value={v("agentInterval")} onChange={(e) => set("agentInterval", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="Задержка уведомления о падении" hint="секунды" help="Антидребезг: рестарт за это время не будит.">
                <Input value={v("serviceDownDelay")} onChange={(e) => set("serviceDownDelay", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="Цель пинга «интернета»" hint="host:port" help="TCP-соединение от каждого агента.">
                <Input value={v("pingTarget")} onChange={(e) => set("pingTarget", e.target.value)} className="num" placeholder="1.1.1.1:443" />
              </Field>
              <Field label="Предупреждать о сертификате за" hint="дней">
                <Input value={v("certWarnDays")} onChange={(e) => set("certWarnDays", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
            </div>
          </div>
        </Card>

        <Section title="Поиск ошибок в логах" desc="Регулярное выражение (без учёта регистра). Строки journal, подходящие под него или с приоритетом err и выше, считаются ошибками.">
          <Textarea
            rows={4}
            value={v("logPattern")}
            onChange={(e) => set("logPattern", e.target.value)}
            placeholder={DEFAULT_LOG_PATTERN}
            className="num text-[12px]"
            spellCheck={false}
          />
          <div className="mt-1.5 flex items-center gap-3 text-[12px] text-mute">
            <span>{v("logPattern") ? "Свой шаблон." : "Пусто — действует встроенный шаблон (показан серым)."}</span>
            {!v("logPattern") && (
              <button type="button" className="text-accent hover:underline" onClick={() => set("logPattern", DEFAULT_LOG_PATTERN)}>
                Взять за основу
              </button>
            )}
          </div>
        </Section>

        <Section title="Хранение данных" desc="Старые точки автоматически сворачиваются в более грубые: сырые → поминутные → 15-минутные.">
          <Card>
            <div className="grid grid-cols-3 gap-4 max-sm:grid-cols-2">
              <Field label="Сырые точки" hint="часов">
                <Input value={v("rawHours")} onChange={(e) => set("rawHours", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="Поминутные" hint="дней">
                <Input value={v("minuteDays")} onChange={(e) => set("minuteDays", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="15-минутные" hint="дней">
                <Input value={v("quarterDays")} onChange={(e) => set("quarterDays", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="События" hint="дней">
                <Input value={v("eventsDays")} onChange={(e) => set("eventsDays", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
              <Field label="Строки ошибок" hint="дней">
                <Input value={v("logsDays")} onChange={(e) => set("logsDays", numOnly(e.target.value))} className="num" inputMode="numeric" />
              </Field>
            </div>
          </Card>
        </Section>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset} />
    </>
  );
}

// ---------- Уведомления ----------

const EVENTS: { key: keyof NotifyEvents; label: string; desc: string }[] = [
  { key: "serverOffline", label: "Сервер недоступен", desc: "Агент перестал присылать данные." },
  { key: "serviceDown", label: "Сервис упал", desc: "failed, не запущен при включённом автозапуске, контейнер остановлен." },
  { key: "serviceRestart", label: "Перезапуск сервиса", desc: "systemd/docker/pm2 перезапустил процесс." },
  { key: "checkDown", label: "Проверка не прошла", desc: "После заданного числа повторов." },
  { key: "thresholds", label: "Превышение порогов", desc: "CPU, память, диск." },
  { key: "recovery", label: "Восстановление", desc: "Сообщать, когда проблема ушла." },
  { key: "certExpiry", label: "Истекает сертификат", desc: "Раз в сутки, пока не продлят." },
  { key: "newService", label: "Новый сервис", desc: "Агент обнаружил сервис, которого раньше не было." },
];

export function NotifySettings() {
  const { data: s } = useSettings();
  const { d, setD, dirty, reset } = useDraft(s, (s) => ({
    enabled: s.notify.telegram.enabled,
    chatId: s.notify.telegram.chatId,
    threadId: s.notify.telegram.threadId ?? "",
    botToken: "",
    clearToken: false,
    events: { ...s.notify.events },
  }));
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  if (!s || !d) return <Loading />;
  const ev = d.events as NotifyEvents;
  const save = async () => {
    setBusy(true);
    try {
      const token = String(d.botToken ?? "").trim();
      await saveSettings({
        notify: {
          telegram: {
            enabled: !!d.enabled,
            chatId: String(d.chatId).trim(),
            threadId: String(d.threadId).trim() || null,
            ...(d.clearToken ? { botToken: null } : token ? { botToken: token } : {}),
          },
          events: ev,
        },
      });
      setReplace(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const tokenSet = s.notify.telegram.botTokenSet && !d.clearToken;
  return (
    <>
      <SettingsHeader
        title="Уведомления"
        desc="Telegram-бот присылает падения и восстановления. Токен бота хранится только на хабе и никогда не отдаётся через API."
        actions={
          <Button
            icon={<Send size={14} />}
            loading={testing}
            disabled={dirty || !s.notify.telegram.botTokenSet}
            title={dirty ? "Сначала сохраните изменения" : undefined}
            onClick={async () => {
              setTesting(true);
              try {
                const r = await post<{ ok: boolean; error?: string }>("/api/v1/settings/notify/test");
                if (r.ok) toast("Тестовое сообщение отправлено");
                else toast.error(r.error ?? "Не удалось отправить");
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setTesting(false);
              }
            }}
          >
            Отправить тест
          </Button>
        }
      />
      <div className="space-y-7">
        <Card>
          <div className="space-y-4">
            <Switch checked={!!d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Отправлять в Telegram" />
            <Field label="Токен бота">
              {tokenSet && !replace ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="num flex h-9 min-w-[180px] flex-1 items-center gap-2 overflow-hidden rounded-lg border border-line bg-sunken px-3 text-[12.5px] whitespace-nowrap text-ink-2">
                    <Badge tone="ok">задан</Badge> ••••••••••••••••
                  </div>
                  <Button variant="secondary" onClick={() => setReplace(true)}>
                    Заменить
                  </Button>
                  <Button variant="ghost" onClick={() => setD({ ...d, clearToken: true })}>
                    Удалить
                  </Button>
                </div>
              ) : (
                <Input
                  type="password"
                  autoComplete="off"
                  value={String(d.botToken)}
                  onChange={(e) => setD({ ...d, botToken: e.target.value, clearToken: false })}
                  placeholder={d.clearToken ? "будет удалён при сохранении" : "123456:ABC-DEF…"}
                  className="num"
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <Field label="Chat ID" help="Личка, группа (−100…) или канал.">
                <Input value={String(d.chatId)} onChange={(e) => setD({ ...d, chatId: e.target.value })} className="num" placeholder="-1001234567890" />
              </Field>
              <Field label="Тема (thread id)" hint="необязательно">
                <Input value={String(d.threadId)} onChange={(e) => setD({ ...d, threadId: e.target.value })} className="num" />
              </Field>
            </div>
          </div>
        </Card>
        <Section title="О чём сообщать">
          <Card pad={false}>
            <div className="divide-y divide-line px-4">
              {EVENTS.map((e) => (
                <div key={e.key} className="py-2.5">
                  <Switch checked={ev[e.key]} onChange={(v) => setD({ ...d, events: { ...ev, [e.key]: v } })} label={e.label} desc={e.desc} />
                </div>
              ))}
            </div>
          </Card>
        </Section>
      </div>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onSave={save}
        onReset={() => {
          reset();
          setReplace(false);
        }}
      />
    </>
  );
}

// ---------- Пороги ----------

export function ThresholdSettings() {
  const { data: s } = useSettings();
  const initial = useMemo(() => (s ? draftFrom(s.thresholds) : null), [s]);
  const [d, setD] = useState<ThresholdDraft | null>(initial);
  useEffect(() => setD(initial), [initial]);
  const [busy, setBusy] = useState(false);
  if (!s || !d) return <Loading />;
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  return (
    <>
      <SettingsHeader title="Пороги по умолчанию" desc="Применяются ко всем серверам. Для отдельного сервера их можно переопределить в его панели → Настройки." />
      <Card pad={false}>
        <div className="px-4">
          <ThresholdsForm d={d} set={setD} />
        </div>
      </Card>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onReset={() => setD(initial)}
        onSave={async () => {
          setBusy(true);
          try {
            await saveSettings({ thresholds: draftToFull(d, s.thresholds) });
          } catch (e) {
            toast.error(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
