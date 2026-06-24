import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import type { ColMeta, CellValue } from "@/ipc/types";
import { summarizeColumn } from "./column-summary";

interface Props {
  anchor: { x: number; y: number };
  col: ColMeta;
  rows: CellValue[][];
  colIndex: number;
  onClose: () => void;
  /** Optional: add a filter chip for this (col, value) pair. */
  onAddFilter?: (value: string) => void;
}

export default function ColumnSummaryPopover({ anchor, col, rows, colIndex, onClose, onAddFilter }: Props) {
  const summary = useMemo(
    () => summarizeColumn(rows.map((r) => r[colIndex])),
    [rows, colIndex],
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pct = (n: number) => summary.total ? `${((n / summary.total) * 100).toFixed(1)}%` : "—";
  const maxCount = summary.top[0]?.count ?? 0;

  // Position the popover so it stays inside the viewport.
  const W = 280, H = 360;
  const left = Math.min(anchor.x, window.innerWidth - W - 12);
  const top = Math.min(anchor.y, window.innerHeight - H - 12);

  return (
    <div
      ref={ref}
      className="col-summary"
      style={{ left, top, width: W, maxHeight: H }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="col-summary-header">
        <span className="title">{col.name}</span>
        <span className="muted type">{col.type_name}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose}><X size={12} /></button>
      </div>
      <div className="col-summary-body">
        <div className="kv">
          <span>Rows seen</span><span>{summary.total}</span>
          <span>Nulls</span><span>{summary.nulls} <span className="muted">({pct(summary.nulls)})</span></span>
          <span>Distinct</span><span>{summary.distinct}</span>
          {summary.numeric && summary.min != null && (
            <>
              <span>Min</span><span>{fmtN(summary.min)}</span>
              <span>Max</span><span>{fmtN(summary.max!)}</span>
              <span>Sum</span><span>{fmtN(summary.sum!)}</span>
              <span>Avg</span><span>{fmtN(summary.avg!)}</span>
            </>
          )}
        </div>

        {summary.top.length > 0 && (
          <>
            <div className="section-subtitle">Top values</div>
            <div className="top-values">
              {summary.top.map((t) => (
                <div
                  key={t.value}
                  className="top-row"
                  onClick={() => onAddFilter?.(t.value)}
                  title={onAddFilter ? "Click to add filter" : undefined}
                >
                  <div className="bar" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                  <span className="val">{t.value === "__NULL__" ? <em className="muted">NULL</em> : t.value}</span>
                  <span className="cnt">{t.count}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="muted footnote">
          Computed from {summary.total} rows in memory.
        </div>
      </div>
    </div>
  );
}

function fmtN(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
