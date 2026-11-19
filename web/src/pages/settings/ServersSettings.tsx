import type { ServerEnrollment } from "@shared/api.ts";
import { ChevronRight, Plus, Server } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { EnrollmentView } from "../../components/Enrollment.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Input, Textarea } from "../../components/ui/Field.tsx";
import { Modal } from "../../components/ui/Modal.tsx";
import { Badge, Empty, Skeleton } from "../../components/ui/misc.tsx";
import { errMsg, post } from "../../lib/api.ts";
import { ago, plural } from "../../lib/format.ts";
import { invalidateLive, useOverview } from "../../lib/queries.ts";
import { STATUS, StatusIcon } from "../../lib/status.tsx";
import { toast } from "../../lib/toast.tsx";
import { SettingsHeader } from "../SettingsPage.tsx";

export function ServersSettings() {
  const { data } = useOverview(true);
  const [adding, setAdding] = useState(false);
  const servers = data?.servers ?? [];
  return (
    <>
      <SettingsHeader
        title="Серверы"
        desc="Каждый сервер — корень дерева. Агент устанавливается одной командой, работает без root и сам подключается к хабу по зашифрованному каналу."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
            Добавить сервер
          </Button>
        }
      />
      {!data ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : servers.length === 0 ? (
        <Empty icon={<Server size={28} />} title="Серверов пока нет">
          Нажмите «Добавить сервер», чтобы получить команду установки агента.
        </Empty>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {servers.map((s) => {
            const svc = data.services.filter((x) => x.serverId === s.id);
            return (
              <Link key={s.id} href={`/s/${encodeURIComponent(s.id)}`} className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-card-hi">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line" style={{ background: STATUS[s.status].soft }}>
                  <Server size={16} style={{ color: STATUS[s.status].color }} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium">{s.name}</span>
                    {s.id !== s.name && <span className="num text-[11px] text-mute">{s.id}</span>}
                    {s.agentOutdated && <Badge tone="warn">агент устарел</Badge>}
                  </div>
                  <div className="num mt-0.5 truncate text-[11.5px] text-mute">
                    {s.enrolled
                      ? `${s.host?.hostname ?? "—"} · агент ${s.host?.agentVersion ?? "?"} · ${svcCount(svc.filter((x) => x.tracked).length, svc.filter((x) => !x.tracked).length)} · ${s.connected ? "на связи" : `последний раз ${ago(s.lastSeen)}`}`
                      : "агент не зарегистрирован"}
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-[12px] text-ink-2 max-sm:hidden">
                  <StatusIcon status={s.status} size={15} />
                  {STATUS[s.status].label}
                </span>
                <ChevronRight size={16} className="text-mute" />
              </Link>
            );
          })}
        </div>
      )}
      <AddServerModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddServerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<ServerEnrollment | null>(null);
  const valid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
  const close = () => {
    onClose();
    setTimeout(() => {
      setId("");
      setName("");
      setDesc("");
      setEnroll(null);
    }, 200);
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={enroll ? `Установка агента на ${enroll.serverId}` : "Новый сервер"}
      width={enroll ? 640 : 480}
      footer={
        enroll ? (
          <Button onClick={close}>Готово</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!valid || !name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const e = await post<ServerEnrollment>("/api/v1/servers", { id, name: name.trim(), description: desc.trim() || null });
                  setEnroll(e);
                  invalidateLive();
                } catch (err) {
                  toast.error(errMsg(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Создать и получить команду
            </Button>
          </>
        )
      }
    >
      {enroll ? (
        <EnrollmentView e={enroll} />
      ) : (
        <div className="space-y-4">
          <Field label="ID" hint="a-z, 0-9, дефис" help="Короткий постоянный идентификатор, например web-1.">
            <Input
              value={id}
              onChange={(e) => {
                const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                setId(v);
                if (!name || name === id) setName(v);
              }}
              className="num"
              maxLength={32}
              placeholder="web-1"
            />
          </Field>
          <Field label="Название">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="web-1" />
          </Field>
          <Field label="Описание" hint="необязательно">
            <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function svcCount(tracked: number, hidden: number) {
  const base = `${tracked} ${plural(tracked, "сервис", "сервиса", "сервисов")}`;
  return hidden ? `${base} (+${hidden} скрыто)` : base;
}
