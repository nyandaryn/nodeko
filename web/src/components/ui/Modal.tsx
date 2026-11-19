import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.tsx";
import { Input } from "./Field.tsx";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose обычно новая функция на каждый рендер — держим в ref, иначе эффект перезапускается и фокус прыгает
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("input,select,textarea,button[data-autofocus]");
      (el ?? ref.current)?.focus();
    }, 20);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pt-[10vh]" role="dialog" aria-modal="true">
      <div className="fixed inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className="relative w-full animate-pop rounded-2xl border border-line-2 bg-panel shadow-pop outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Удалить",
  danger = true,
  typeToConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<unknown> | void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const blocked = typeToConfirm != null && typed.trim() !== typeToConfirm;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            disabled={blocked}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-2">
        {body}
        {typeToConfirm != null && (
          <div>
            <p className="mb-1.5 text-[12.5px]">
              Введите <span className="num rounded bg-sunken px-1.5 py-0.5 text-ink">{typeToConfirm}</span> для подтверждения
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        )}
      </div>
    </Modal>
  );
}
