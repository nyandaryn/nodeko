/** Полоса «пульса» как в Uptime Kuma: последние N результатов, старые слева. */
export function Heartbeat({ beats, slots = 60, height = 22 }: { beats: (0 | 1)[]; slots?: number; height?: number }) {
  const list = beats.slice(-slots);
  const pad = Math.max(0, slots - list.length);
  return (
    <div className="flex items-end gap-[3px]" style={{ height }} role="img" aria-label={`последние ${list.length} проверок, ошибок: ${list.filter((b) => b === 0).length}`}>
      {Array.from({ length: pad }, (_, i) => (
        <span key={`p${i}`} className="h-full flex-1 rounded-[3px] bg-[var(--line)]" />
      ))}
      {list.map((b, i) => (
        <span
          key={i}
          title={b ? "успешно" : "сбой"}
          className="h-full min-w-[3px] flex-1 rounded-[3px] transition-transform hover:scale-y-110"
          style={{ background: b ? "var(--ok)" : "var(--down)", opacity: b ? 0.85 : 1 }}
        />
      ))}
    </div>
  );
}
