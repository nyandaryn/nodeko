import type { TokenCreated, TokenItem, TokenScope } from "@shared/api.ts";
import { Bot, KeyRound, Plus, Trash } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button.tsx";
import { Field, Input, Segmented } from "../../components/ui/Field.tsx";
import { Confirm, Modal } from "../../components/ui/Modal.tsx";
import { Badge, Card, CopyField, Empty, Section, Skeleton } from "../../components/ui/misc.tsx";
import { del, errMsg, post } from "../../lib/api.ts";
import { ago, dateTime } from "../../lib/format.ts";
import { qk, queryClient, useSettings, useTokens } from "../../lib/queries.ts";
import { toast } from "../../lib/toast.tsx";
import { SettingsHeader } from "../SettingsPage.tsx";

export function mcpCommand(publicUrl: string, token: string) {
  return `claude mcp add --transport http nodeko ${publicUrl.replace(/\/$/, "")}/mcp --header "Authorization: Bearer ${token}"`;
}

export function TokensSettings() {
  const { data } = useTokens();
  const settings = useSettings();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [remove, setRemove] = useState<TokenItem | null>(null);
  const publicUrl = settings.data?.publicUrl || window.location.origin;
  return (
    <>
      <SettingsHeader
        title="API и ИИ-агент"
        desc="Токены для REST API и MCP. read — только чтение; admin — ещё и настройка nodeko (сервисы, проверки, пороги, уведомления)."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
            Создать токен
          </Button>
        }
      />
      <div className="space-y-7">
        {!data ? (
          <Skeleton className="h-24" />
        ) : data.length === 0 ? (
          <Empty icon={<KeyRound size={26} />} title="Токенов нет">
            Создайте токен, чтобы подключить ИИ-агента или скрипты.
          </Empty>
        ) : (
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {data.map((t) => (
              <div key={t.id} className="flex items-center gap-3.5 px-4 py-3">
                <KeyRound size={16} className="shrink-0 text-mute" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium">{t.name}</span>
                    <Badge tone={t.scope === "admin" ? "warn" : "accent"}>{t.scope}</Badge>
                  </div>
                  <div className="num mt-0.5 truncate text-[11.5px] text-mute">
                    nk_{t.id}_…{t.hint} · создан {dateTime(t.createdAt)} · {t.lastUsed ? `использован ${ago(t.lastUsed)}` : "не использовался"}
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => setRemove(t)} aria-label="Отозвать">
                  <Trash size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Section title="Подключить ИИ-агента">
          <Card>
            <div className="mb-3 flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
                <Bot size={17} className="text-accent" />
              </span>
              <p className="text-[13px] leading-relaxed text-ink-2">
                nodeko отдаёт MCP-сервер (Streamable HTTP) по адресу <span className="num text-ink">{publicUrl.replace(/\/$/, "")}/mcp</span>. Подключение
                к Claude Code — одной командой, подставьте токен:
              </p>
            </div>
            <div className="space-y-3">
              <CopyField value={mcpCommand(publicUrl, created?.token ?? "<TOKEN>")} multiline />
              <CopyField
                label="Или напрямую через REST"
                value={`curl -s -H "Authorization: Bearer ${created?.token ?? "<TOKEN>"}" ${publicUrl.replace(/\/$/, "")}/api/v1/overview`}
                multiline
              />
              <p className="text-[12px] text-mute">
                Описание API для агентов — <span className="num">GET /api/v1/docs</span> (markdown).
              </p>
            </div>
          </Card>
        </Section>
      </div>

      <CreateTokenModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setCreating(false);
          setCreated(t);
        }}
      />
      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title="Токен создан"
        width={620}
        footer={<Button onClick={() => setCreated(null)}>Я сохранил токен</Button>}
      >
        {created && (
          <div className="space-y-4">
            <p className="text-[13px] text-ink-2">
              Скопируйте токен сейчас — <b className="text-ink">больше он показан не будет</b>.
            </p>
            <CopyField label={`${created.name} · ${created.scope}`} value={created.token} secret />
            <CopyField label="Команда для Claude Code" value={mcpCommand(publicUrl, created.token)} multiline />
          </div>
        )}
      </Modal>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title={`Отозвать токен «${remove?.name}»?`}
        confirmLabel="Отозвать"
        body={<p>Все клиенты с этим токеном сразу потеряют доступ.</p>}
        onConfirm={async () => {
          if (!remove) return;
          try {
            await del(`/api/v1/tokens/${remove.id}`);
            toast("Токен отозван");
            queryClient.invalidateQueries({ queryKey: qk.tokens });
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
      />
    </>
  );
}

function CreateTokenModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: TokenCreated) => void }) {
  const [name, setName] = useState("claude-code");
  const [scope, setScope] = useState<TokenScope>("admin");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новый токен"
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const t = await post<TokenCreated>("/api/v1/tokens", { name: name.trim(), scope });
                queryClient.invalidateQueries({ queryKey: qk.tokens });
                onCreated(t);
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Создать
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Название" help="Чтобы понимать, кто пользуется токеном.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
        </Field>
        <Field label="Права">
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: "read", label: "read — только чтение" },
              { value: "admin", label: "admin — чтение и настройка" },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}
