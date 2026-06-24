import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import type { ColMeta, CellValue } from "@/ipc/types";

interface Props {
  columns: ColMeta[];
  rows: CellValue[][];
}

type Agg = "count" | "sum" | "avg" | "min" | "max";

interface Series {
  /** Column index in `columns`. -1 means "row count" — agg is forced to
   *  count, no underlying column. */
  col: number;
  agg: Agg;
}

const NUMERIC = new Set([
  "INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "NUMERIC", "DECIMAL",
  "smallint", "integer", "bigint", "real", "double precision", "numeric", "decimal",
]);

/** Color palette for series — picked for legibility against the app's
 *  bg, distinguishable in greyscale, and accessible-ish. Recycles for
 *  series 9+, which is already past useful comparison anyway. */
const SERIES_COLORS = [
  "var(--accent)", "#e07c3e", "#54a24b", "#b279a2", "#eeca3b",
  "#17becf", "#b08458", "#ff7f0e", "#9467bd",
];

function isNumeric(c: ColMeta): boolean {
  return NUMERIC.has(c.type_name);
}

export default function ChartPane({ columns, rows }: Props) {
  const numericCols = columns.filter(isNumeric);
  const [x, setX] = useState<number>(0);
  // Series default: one "row count" bar if we have nothing numeric;
  // otherwise sum of the first numeric column.
  const [series, setSeries] = useState<Series[]>(() => {
    const firstNum = columns.findIndex(isNumeric);
    return firstNum >= 0 ? [{ col: firstNum, agg: "sum" }] : [{ col: -1, agg: "count" }];
  });

  /** Per-bucket, per-series aggregate, ready for the chart. */
  const data = useMemo(() => {
    if (x < 0 || rows.length === 0) return { buckets: [] as string[], series: [] as number[][] };
    const buckets = new Map<string, { count: number; perSeries: { sum: number; n: number; min: number; max: number }[] }>();
    for (const r of rows) {
      const key = renderForBucket(r[x]);
      let b = buckets.get(key);
      if (!b) {
        b = {
          count: 0,
          perSeries: series.map(() => ({ sum: 0, n: 0, min: Infinity, max: -Infinity })),
        };
        buckets.set(key, b);
      }
      b.count += 1;
      series.forEach((s, si) => {
        if (s.col < 0) return; // count series — handled separately
        const v = r[s.col];
        if (v && (v.kind === "int" || v.kind === "float")) {
          const ps = b!.perSeries[si];
          ps.sum += v.value;
          ps.n += 1;
          if (v.value < ps.min) ps.min = v.value;
          if (v.value > ps.max) ps.max = v.value;
        }
      });
    }
    const keys = [...buckets.keys()];
    const seriesValues = series.map((s, si) =>
      keys.map((k) => {
        const b = buckets.get(k)!;
        if (s.col < 0) return b.count;
        const ps = b.perSeries[si];
        switch (s.agg) {
          case "count": return ps.n;
          case "sum":   return ps.sum;
          case "avg":   return ps.n === 0 ? 0 : ps.sum / ps.n;
          case "min":   return ps.n === 0 ? 0 : ps.min;
          case "max":   return ps.n === 0 ? 0 : ps.max;
        }
      }),
    );
    return { buckets: keys, series: seriesValues };
  }, [rows, x, series]);

  if (!rows.length) {
    return <div className="placeholder"><span className="muted">Run a query first.</span></div>;
  }

  const addSeries = () => {
    const firstNum = columns.findIndex(isNumeric);
    setSeries((cur) => [...cur, firstNum >= 0 ? { col: firstNum, agg: "sum" } : { col: -1, agg: "count" }]);
  };
  const removeSeries = (i: number) => {
    setSeries((cur) => cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i));
  };
  const updateSeries = (i: number, patch: Partial<Series>) => {
    setSeries((cur) => cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  return (
    <div className="chart-pane">
      <div className="chart-controls">
        <label>X</label>
        <select value={x} onChange={(e) => setX(parseInt(e.target.value))}>
          {columns.map((c, i) => (<option key={c.name} value={i}>{c.name}</option>))}
        </select>
      </div>

      <div className="chart-series-list">
        {series.map((s, i) => (
          <div key={i} className="chart-series-row">
            <span className="chart-series-swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <label>Y</label>
            <select
              value={s.col}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                updateSeries(i, { col: v, agg: v < 0 ? "count" : s.agg === "count" ? "sum" : s.agg });
              }}
            >
              <option value={-1}>row count</option>
              {numericCols.map((c) => {
                const ci = columns.indexOf(c);
                return (<option key={c.name} value={ci}>{c.name}</option>);
              })}
            </select>
            <label>Agg</label>
            <select
              value={s.agg}
              disabled={s.col < 0}
              onChange={(e) => updateSeries(i, { agg: e.target.value as Agg })}
            >
              <option value="count">count</option>
              <option value="sum">sum</option>
              <option value="avg">avg</option>
              <option value="min">min</option>
              <option value="max">max</option>
            </select>
            <button
              className="icon-btn"
              onClick={() => removeSeries(i)}
              disabled={series.length === 1}
              aria-label="Remove series"
              title="Remove series"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="btn-pill" onClick={addSeries}>
          <Plus size={11} /> Add series
        </button>
      </div>

      <Legend series={series} columns={columns} colors={SERIES_COLORS} />
      <BarChart buckets={data.buckets} seriesValues={data.series} colors={SERIES_COLORS} />
    </div>
  );
}

function Legend({
  series, columns, colors,
}: {
  series: Series[];
  columns: ColMeta[];
  colors: string[];
}) {
  return (
    <div className="chart-legend">
      {series.map((s, i) => {
        const label = s.col < 0 ? "row count" : `${s.agg} of ${columns[s.col]?.name ?? "?"}`;
        return (
          <div key={i} className="chart-legend-item">
            <span className="chart-series-swatch" style={{ background: colors[i % colors.length] }} />
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function BarChart({
  buckets, seriesValues, colors,
}: {
  buckets: string[];
  seriesValues: number[][];
  colors: string[];
}) {
  if (!buckets.length || !seriesValues.length) {
    return <div className="muted" style={{ padding: 12 }}>No data.</div>;
  }
  const W = 720, H = 280, PAD_L = 50, PAD_B = 30, PAD_T = 8, PAD_R = 12;
  const all = seriesValues.flat();
  const max = Math.max(...all, 1);
  const groupW = (W - PAD_L - PAD_R) / buckets.length;
  const barW = Math.max(1, (groupW - 4) / seriesValues.length);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
      {/* y-axis grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = H - PAD_B - (H - PAD_B - PAD_T) * t;
        return (
          <g key={t}>
            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y + 3} fontSize="9" textAnchor="end" fill="var(--fg-3)">
              {fmt(max * t)}
            </text>
          </g>
        );
      })}
      {buckets.map((label, bi) => {
        const groupX = PAD_L + bi * groupW + 2;
        return (
          <g key={bi}>
            {seriesValues.map((vals, si) => {
              const v = vals[bi];
              const h = ((v / max) * (H - PAD_B - PAD_T)) || 0;
              const x = groupX + si * barW;
              const y = H - PAD_B - h;
              return (
                <rect
                  key={si}
                  x={x} y={y} width={barW} height={h}
                  fill={colors[si % colors.length]}
                  rx={1.5}
                >
                  <title>{`${label} · series ${si + 1}: ${fmt(v)}`}</title>
                </rect>
              );
            })}
            {buckets.length <= 30 && (
              <text x={groupX + (groupW - 4) / 2} y={H - PAD_B + 11} fontSize="9"
                textAnchor="middle" fill="var(--fg-3)">
                {truncate(label, 10)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function renderForBucket(c: CellValue): string {
  switch (c.kind) {
    case "null": return "NULL";
    case "bool": return c.value ? "true" : "false";
    case "int": case "float": return String(c.value);
    case "text": case "raw": return c.value;
    case "document": return JSON.stringify(c.value);
    case "bytes": return `<${c.value.length}b>`;
  }
}
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
