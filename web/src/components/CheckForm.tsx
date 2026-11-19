import type { CheckBody, CheckSummary } from "@shared/api.ts";
import { useEffect, useMemo, useState } from "react";
import { errMsg, patch, post } from "../lib/api.ts";
import { invalidateLive, useOverview } from "../lib/queries.ts";
import { toast } from "../lib/toast.tsx";
import { Button } from "./ui/Button.tsx";
import { Field, Input, Segmented, Select, Switch } from "./ui/Field.tsx";
import { Modal } from "./ui/Modal.tsx";

interface Draft {
  name: string;
  type: "http" | "tcp";
  target: string;
  runner: string;
  serverId: string;
  serviceId: string;
  interval: string;
  timeout: string;
  expect: string;
  keyword: string;
  method: "GET" | "HEAD";
  insecure: boolean;
  retries: string;
  enabled: boolean;
}

const fromCheck = (c?: CheckSummary | null, preset?: Partial<CheckBody>): Draft => ({
  name: c?.name ?? preset?.name ?? "",
  type: c?.type ?? preset?.type ?? "http",
  target: c?.target ?? preset?.target ?? "",
  runner: c?.runner ?? preset?.runner ?? "hub",
  serverId: c?.serverId ?? preset?.serverId ?? "",
  serviceId: c?.serviceId != null ? String(c.serviceId) : preset?.serviceId != null ? String(preset.serviceId) : "",
  interval: String(c?.interval ?? 60),
  timeout: String(c?.timeout ?? 10000),
  expect: c?.expect ?? "",
  keyword: c?.keyword ?? "",
  method: c?.method ?? "GET",
  insecure: c?.insecure ?? false,
  retries: String(c?.retries ?? 2),
  enabled: c?.enabled ?? true,
});

export function CheckFormModal({
  open,
  onClose,
  check,
  preset,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  check?: CheckSummary | null;
  preset?: Partial<CheckBody>;
  onSaved?: (c: CheckSummary) => void;
}) {
  const [d, setD] = useState<Draft>(() => fromCheck(check, preset));
  const [busy, setBusy] = useState(false);
  const ov = useOverview(true);
  useEffect(() => {
    if (open) setD(fromCheck(check, preset));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, check?.id]);
  const servers = ov.data?.servers ?? [];
  const services = useMemo(
    () => (ov.data?.services ?? []).filter((s) => s.serverId === d.serverId).sort((a, b) => a.name.localeCompare(b.name)),
    [ov.data, d.serverId],
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const targetHint = d.type === "http" ? "https://example.com/health" : "host:port";
  const submit = async () => {
    const body: CheckBody = {
      name: d.name.trim(),
      type: d.type,
      target: d.target.trim(),
      runner: d.runner,
      serverId: d.serverId || null,
      serviceId: d.serviceId ? Number(d.serviceId) : null,
      interval: Number(d.interval) || 60,
      timeout: Number(d.timeout) || 10000,
      expect: d.type === "http" ? d.expect.trim() || null : null,
      keyword: d.type === "http" ? d.keyword.trim() || null : null,
      method: d.method,
      insecure: d.insecure,
      retries: Number(d.retries) || 0,
      enabled: d.enabled,
    };
    setBusy(true);
    try {
      const saved = check ? await patch<CheckSummary>(`/api/v1/checks/${check.id}`, body) : await post<CheckSummary>("/api/v1/checks", body);
      toast(check ? "Проверка сохранена" : "Проверка создана");
      await invalidateLive();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={check ? "Редактировать проверку" : "Новая проверка"}
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!d.name.trim() || !d.target.trim()} onClick={submit}>
            {check ? "Сохранить" : "Создать"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Название">
            <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Shop API" maxLength={64} />
          </Field>
          <Segmented
            value={d.type}
            onChange={(v) => set("type", v)}
            options={[
              { value: "http", label: "HTTP" },
              { value: "tcp", label: "TCP" },
            ]}
          />
        </div>
        <Field label={d.type === "http" ? "URL" : "Адрес"}>
          <Input value={d.target} onChange={(e) => set("target", e.target.value)} placeholder={targetHint} className="num" spellCheck={false} />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
          <Field label="Кто проверяет" help={d.runner === "hub" ? "Хаб — снаружи, как видят пользователи." : "Агент сервера — изнутри, можно 127.0.0.1."}>
            <Select value={d.runner} onChange={(e) => set("runner", e.target.value)}>
              <option value="hub">Хаб (снаружи)</option>
              {servers
                .filter((s) => s.enrolled)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    Агент {s.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Показывать под" help="Пусто — в «Внешних проверках».">
            <Select
              value={d.serverId}
              onChange={(e) => {
                set("serverId", e.target.value);
                set("serviceId", "");
              }}
            >
              <option value="">— внешние —</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {d.serverId && (
          <Field label="Привязать к сервису" help="Сбой проверки отразится на статусе сервиса.">
            <Select value={d.serviceId} onChange={(e) => set("serviceId", e.target.value)}>
              <option value="">— не привязывать —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName ?? s.name} {s.tracked ? "" : "(скрыт)"}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-3 gap-3 max-[520px]:grid-cols-2">
          <Field label="Интервал, с">
            <Input value={d.interval} onChange={(e) => set("interval", e.target.value.replace(/\D/g, ""))} className="num" inputMode="numeric" />
          </Field>
          <Field label="Таймаут, мс">
            <Input value={d.timeout} onChange={(e) => set("timeout", e.target.value.replace(/\D/g, ""))} className="num" inputMode="numeric" />
          </Field>
          <Field label="Повторы до сбоя">
            <Input value={d.retries} onChange={(e) => set("retries", e.target.value.replace(/\D/g, ""))} className="num" inputMode="numeric" />
          </Field>
        </div>
        {d.type === "http" && (
          <>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 max-[520px]:grid-cols-1">
              <Field label="Коды ответа" hint="по умолч. 200-399">
                <Input value={d.expect} onChange={(e) => set("expect", e.target.value)} placeholder="200-399" className="num" />
              </Field>
              <Field label="Ключевое слово" hint="в теле ответа">
                <Input value={d.keyword} onChange={(e) => set("keyword", e.target.value)} placeholder="ok" />
              </Field>
              <Segmented
                value={d.method}
                onChange={(v) => set("method", v)}
                options={[
                  { value: "GET", label: "GET" },
                  { value: "HEAD", label: "HEAD" },
                ]}
              />
            </div>
            <Switch checked={d.insecure} onChange={(v) => set("insecure", v)} label="Не проверять TLS-сертификат" desc="Для самоподписанных сертификатов. Срок сертификата всё равно отслеживается." />
          </>
        )}
        <Switch checked={d.enabled} onChange={(v) => set("enabled", v)} label="Включена" />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
