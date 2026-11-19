import type { MetricsRange } from "@shared/api.ts";
import { Segmented } from "./ui/Field.tsx";

const LABELS: Record<MetricsRange, string> = { "1h": "1ч", "6h": "6ч", "24h": "24ч", "7d": "7д", "30d": "30д", "1y": "1г" };

export function RangePicker({ value, onChange, ranges }: { value: MetricsRange; onChange: (r: MetricsRange) => void; ranges?: MetricsRange[] }) {
  const list = ranges ?? (Object.keys(LABELS) as MetricsRange[]);
  return <Segmented size="sm" value={value} onChange={onChange} options={list.map((r) => ({ value: r, label: LABELS[r] }))} />;
}
