import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-2">
        {children}
      </label>
      {hint && <span className="truncate text-[11.5px] whitespace-nowrap text-mute">{hint}</span>}
    </div>
  );
}

export function Field({ label, hint, help, children, htmlFor }: { label: ReactNode; hint?: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <Label hint={hint} htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {help && <p className="mt-1.5 text-[12px] leading-snug text-mute">{help}</p>}
    </div>
  );
}

export const Input = ({ className = "", ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`field ${className}`} />;
export const Textarea = ({ className = "", ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={`field ${className}`} />
);
export const Select = ({ className = "", children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`field ${className}`}>
    {children}
  </select>
);

export function Switch({ checked, onChange, label, desc, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; desc?: ReactNode; disabled?: boolean }) {
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-50 ${
        checked ? "border-transparent bg-accent" : "border-line-2 bg-sunken"
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] h-4 w-4 rounded-full shadow transition-transform duration-150 ${checked ? "translate-x-4 bg-white" : "bg-ink-2"}`}
      />
    </button>
  );
  if (!label) return sw;
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span>
        <span className="block text-[13.5px] text-ink">{label}</span>
        {desc && <span className="mt-0.5 block text-[12px] leading-snug text-mute">{desc}</span>}
      </span>
      {sw}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded-md font-medium transition-colors ${size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]"} ${
            value === o.value ? "bg-card-hi text-ink shadow-[0_0_0_1px_var(--line-2)]" : "text-mute hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
