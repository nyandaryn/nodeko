import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon" | "icon-sm";

const V: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-2 border border-transparent shadow-[0_1px_0_rgba(255,255,255,0.15)_inset]",
  secondary: "bg-card-hi text-ink border border-line-2 hover:border-[color-mix(in_oklab,var(--line-2),var(--ink)_18%)]",
  ghost: "bg-transparent text-ink-2 hover:text-ink hover:bg-card-hi border border-transparent",
  subtle: "bg-sunken text-ink-2 hover:text-ink border border-line",
  danger: "bg-down text-white hover:brightness-110 border border-transparent",
};
const S: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-[13.5px] gap-2 rounded-lg",
  icon: "h-9 w-9 justify-center rounded-lg",
  "icon-sm": "h-7 w-7 justify-center rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading, icon, children, className = "", disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-[background,border-color,color,filter] duration-100 select-none disabled:opacity-50 ${V[variant]} ${S[size]} ${className}`}
    >
      {loading ? <LoaderCircle size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
