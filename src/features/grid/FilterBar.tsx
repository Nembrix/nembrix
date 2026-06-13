import { X, Filter } from "lucide-react";
import type { FilterChip } from "@/store";

interface Props {
  filters: FilterChip[];
  onRemove: (id: string) => void;
  onClear: () => void;
}

export default function FilterBar({ filters, onRemove, onClear }: Props) {
  if (!filters.length) return null;
  return (
    <div className="filter-bar">
      <Filter size={12} className="muted" />
      <div className="chips">
        {filters.map((f) => (
          <div className="chip" key={f.id} title={chipTitle(f)}>
            <span className="col">{f.column}</span>
            <span className="op">{f.op}</span>
            {f.value != null && f.op !== "IS NULL" && f.op !== "IS NOT NULL" && (
              <span className="val">{truncate(f.value, 24)}</span>
            )}
            <button className="chip-x" onClick={() => onRemove(f.id)} aria-label="Remove filter">
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      <button className="btn-pill" onClick={onClear}>Clear all</button>
    </div>
  );
}

function chipTitle(f: FilterChip): string {
  return `${f.column} ${f.op}${f.value != null ? ` ${f.value}` : ""}`;
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
