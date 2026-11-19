export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="var(--card-hi)" stroke="var(--line-2)" />
      <path d="M16 11v3.5M16 14.5H9.5V19M16 14.5h6.5V19" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="9" r="2.9" fill="var(--accent)" />
      <circle cx="9.5" cy="21.6" r="2.7" fill="var(--ok)" />
      <circle cx="22.5" cy="21.6" r="2.7" fill="var(--warn)" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 select-none">
      <LogoMark />
      <span className={`num text-[15px] font-semibold tracking-[-0.02em] text-ink ${compact ? "max-sm:hidden" : ""}`}>
        node<span className="text-accent">ko</span>
      </span>
    </span>
  );
}
