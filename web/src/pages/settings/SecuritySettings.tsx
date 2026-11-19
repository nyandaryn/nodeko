import type { PasskeyItem, SessionItem } from "@shared/api.ts";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { Check, FingerprintPattern, Laptop, LogOut, Pencil, Plus, Trash, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Input } from "../../components/ui/Field.tsx";
import { Confirm, Modal } from "../../components/ui/Modal.tsx";
import { Badge, Card, Empty, Section, Skeleton } from "../../components/ui/misc.tsx";
import { ApiErr, del, errMsg, patch, post } from "../../lib/api.ts";
import { ago, dateTime } from "../../lib/format.ts";
import { qk, queryClient, usePasskeys, useSessions } from "../../lib/queries.ts";
import { toast } from "../../lib/toast.tsx";
import { SettingsHeader } from "../SettingsPage.tsx";

export function SecuritySettings() {
  return (
    <>
      <SettingsHeader title="Безопасность" desc="Пароль, passkeys и активные сессии. Вход возможен по паролю или по любому из passkeys." />
      <div className="space-y-8">
        <PasswordForm />
        <Passkeys />
        <Sessions />
      </div>
    </>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = repeat.length > 0 && next !== repeat;
  return (
    <Section title="Пароль">
      <Card>
        <form
          className="grid grid-cols-3 items-start gap-3 max-md:grid-cols-1"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post("/api/v1/account/password", { current, next });
              toast("Пароль изменён. Остальные сессии завершены.");
              setCurrent("");
              setNext("");
              setRepeat("");
              queryClient.invalidateQueries({ queryKey: qk.sessions });
            } catch (err) {
              toast.error(err instanceof ApiErr && err.status === 401 ? "Текущий пароль неверен" : errMsg(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Текущий пароль">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="Новый пароль" help={tooShort ? <span className="text-[var(--down)]">Минимум 12 символов</span> : "Минимум 12 символов."}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <Field label="Повторите" help={mismatch ? <span className="text-[var(--down)]">Пароли не совпадают</span> : undefined}>
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </Field>
          <div className="col-span-full flex justify-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 12 || next !== repeat}>
              Сменить пароль
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}

function defaultPasskeyName() {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "Linux";
  const br = /Firefox/.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "браузер";
  return `${br} · ${os}`;
}

function Passkeys() {
  const { data } = usePasskeys();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(defaultPasskeyName());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [remove, setRemove] = useState<PasskeyItem | null>(null);
  const supported = browserSupportsWebAuthn();

  const register = async () => {
    setBusy(true);
    try {
      const { challengeId, options } = await post<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
        "/api/auth/passkey/register/options",
      );
      const response = await startRegistration({ optionsJSON: options });
      await post("/api/auth/passkey/register/verify", { challengeId, response, name: name.trim() || defaultPasskeyName() });
      toast("Passkey добавлен");
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: qk.passkeys });
      queryClient.invalidateQueries({ queryKey: qk.auth });
    } catch (e) {
      const n = (e as { name?: string })?.name;
      if (n === "NotAllowedError" || n === "AbortError") toast.info("Регистрация отменена");
      else if (n === "InvalidStateError") toast.error("Этот ключ уже зарегистрирован");
      else toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Passkeys"
      actions={
        <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={!supported} onClick={() => setAdding(true)} title={supported ? undefined : "Браузер не поддерживает WebAuthn"}>
          Добавить passkey
        </Button>
      }
    >
      {!data ? (
        <Skeleton className="h-16" />
      ) : data.length === 0 ? (
        <Empty icon={<FingerprintPattern size={26} />} title="Passkeys не добавлены">
          Passkey позволяет входить без пароля — отпечатком, Face ID, Windows Hello или аппаратным ключом.
        </Empty>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {data.map((p) => (
            <div key={p.id} className="flex items-center gap-3.5 px-4 py-3">
              <FingerprintPattern size={17} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                {editing?.id === p.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await patch(`/api/v1/passkeys/${encodeURIComponent(p.id)}`, { name: editing.name.trim() });
                        setEditing(null);
                        queryClient.invalidateQueries({ queryKey: qk.passkeys });
                      } catch (err) {
                        toast.error(errMsg(err));
                      }
                    }}
                  >
                    <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="!h-8" autoFocus maxLength={48} />
                    <Button type="submit" size="icon-sm" variant="ghost" aria-label="Сохранить">
                      <Check size={15} />
                    </Button>
                    <Button type="button" size="icon-sm" variant="ghost" onClick={() => setEditing(null)} aria-label="Отмена">
                      <X size={15} />
                    </Button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{p.name}</span>
                      {p.backedUp && <Badge tone="accent">синхронизируется</Badge>}
                    </div>
                    <div className="num mt-0.5 text-[11.5px] text-mute">
                      добавлен {dateTime(p.createdAt)} · {p.lastUsed ? `вход ${ago(p.lastUsed)}` : "ещё не использовался"}
                    </div>
                  </>
                )}
              </div>
              {editing?.id !== p.id && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing({ id: p.id, name: p.name })} aria-label="Переименовать">
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setRemove(p)} aria-label="Удалить">
                    <Trash size={14} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Новый passkey"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Отмена
            </Button>
            <Button variant="primary" loading={busy} icon={<FingerprintPattern size={15} />} onClick={register}>
              Создать passkey
            </Button>
          </>
        }
      >
        <Field label="Название" help="Браузер попросит подтвердить личность — отпечатком, PIN или ключом.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
        </Field>
      </Modal>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title={`Удалить passkey «${remove?.name}»?`}
        body={<p>Войти этим ключом больше не получится. Сам ключ останется в менеджере паролей — удалите его там вручную.</p>}
        onConfirm={async () => {
          if (!remove) return;
          try {
            await del(`/api/v1/passkeys/${encodeURIComponent(remove.id)}`);
            toast("Passkey удалён");
            queryClient.invalidateQueries({ queryKey: qk.passkeys });
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
      />
    </Section>
  );
}

function describeUa(ua: string | null): string {
  if (!ua) return "неизвестное устройство";
  const br = /Firefox\/(\d+)/.exec(ua)?.[0]?.replace("/", " ") ?? /Edg\/(\d+)/.exec(ua)?.[0]?.replace("Edg/", "Edge ") ?? /Chrome\/(\d+)/.exec(ua)?.[0]?.replace("/", " ") ?? (/Safari/.test(ua) ? "Safari" : ua.slice(0, 40));
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return [br, os].filter(Boolean).join(" · ");
}

function Sessions() {
  const { data } = useSessions();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Section title="Активные сессии">
      {!data ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {data.map((s: SessionItem) => (
            <div key={s.id} className="flex items-center gap-3.5 px-4 py-3">
              <Laptop size={17} className="shrink-0 text-mute" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px]">{describeUa(s.userAgent)}</span>
                  {s.current && <Badge tone="ok">эта сессия</Badge>}
                  <Badge>{s.method === "passkey" ? "passkey" : "пароль"}</Badge>
                </div>
                <div className="num mt-0.5 truncate text-[11.5px] text-mute">
                  {s.ip ?? "—"} · вход {dateTime(s.createdAt)} · активность {ago(s.lastSeen)}
                </div>
              </div>
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<LogOut size={13} />}
                  loading={busy === s.id}
                  onClick={async () => {
                    setBusy(s.id);
                    try {
                      await del(`/api/v1/sessions/${encodeURIComponent(s.id)}`);
                      toast("Сессия завершена");
                      queryClient.invalidateQueries({ queryKey: qk.sessions });
                    } catch (e) {
                      toast.error(errMsg(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Завершить
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
