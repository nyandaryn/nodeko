import type { CheckSummary } from "@shared/api.ts";
import { Globe, Pencil, Plus, Trash } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { CheckFormModal } from "../../components/CheckForm.tsx";
import { Heartbeat } from "../../components/Heartbeat.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Confirm } from "../../components/ui/Modal.tsx";
import { Badge, Empty, Skeleton } from "../../components/ui/misc.tsx";
import { del, errMsg } from "../../lib/api.ts";
import { dur, ms, pct } from "../../lib/format.ts";
import { invalidateLive, useChecks } from "../../lib/queries.ts";
import { StatusIcon } from "../../lib/status.tsx";
import { toast } from "../../lib/toast.tsx";
import { SettingsHeader } from "../SettingsPage.tsx";

export function ChecksSettings() {
  const { data } = useChecks();
  const [edit, setEdit] = useState<CheckSummary | null | "new">(null);
  const [remove, setRemove] = useState<CheckSummary | null>(null);
  const [, nav] = useLocation();
  return (
    <>
      <SettingsHeader
        title="Проверки"
        desc="HTTP и TCP-проверки доступности — замена Uptime Kuma. Хаб проверяет снаружи, агент — изнутри сервера (подходит для 127.0.0.1)."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit("new")}>
            Новая проверка
          </Button>
        }
      />
      {!data ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : data.length === 0 ? (
        <Empty icon={<Globe size={28} />} title="Проверок пока нет">
          Добавьте URL сайта или API — nodeko будет опрашивать его, считать аптайм и присылать уведомления о падениях.
        </Empty>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {data.map((c) => (
            <div key={c.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3.5 gap-y-2 px-4 py-3 hover:bg-card-hi">
              <StatusIcon status={c.status} size={17} />
              <button className="min-w-0 text-left" onClick={() => nav(`/chk/${c.id}`)}>
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium">{c.name}</span>
                  <Badge>{c.type.toUpperCase()}</Badge>
                  {!c.enabled && <Badge tone="idle">выкл</Badge>}
                </div>
                <div className="num mt-0.5 truncate text-[11.5px] text-mute">
                  {c.target} · {c.runner === "hub" ? "хаб" : `агент ${c.runner}`} · каждые {dur(c.interval * 1000)}
                </div>
              </button>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => setEdit(c)} aria-label="Редактировать">
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setRemove(c)} aria-label="Удалить">
                  <Trash size={14} />
                </Button>
              </div>
              <div className="col-span-2 col-start-2 flex items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-1.5">
                <div className="min-w-0 flex-1">
                  <Heartbeat beats={c.beats} slots={40} height={14} />
                </div>
                <div className="num flex shrink-0 gap-3 text-[11.5px] text-mute">
                  <span>
                    24ч <b className="font-medium text-ink">{c.uptime24h != null ? pct(c.uptime24h) : "—"}</b>
                  </span>
                  <span>
                    ⌀ <b className="font-medium text-ink">{ms(c.avgMs24h)}</b>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <CheckFormModal open={edit != null} onClose={() => setEdit(null)} check={edit === "new" ? null : edit} />
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title={`Удалить проверку «${remove?.name}»?`}
        body={<p>История результатов будет удалена.</p>}
        onConfirm={async () => {
          if (!remove) return;
          try {
            await del(`/api/v1/checks/${remove.id}`);
            toast("Проверка удалена");
            invalidateLive();
          } catch (e) {
            toast.error(errMsg(e));
          }
        }}
      />
    </>
  );
}
