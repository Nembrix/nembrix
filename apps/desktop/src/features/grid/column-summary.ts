/**
 * Local column summary — distinct count, null %, min/max, top-N values.
 *
 * Computed from the rows already in memory. No SQL round-trip: even on a
 * paginated result this gives the user something useful immediately. When
 * the active tab is a `SELECT * FROM relation` we could later kick off
 * `SELECT count(distinct …), percentile_cont(…) …` against the server to
 * upgrade to authoritative numbers — flagged in the popover.
 */

import type { CellValue } from "@/ipc/types";

export interface ColumnSummary {
  total: number;
  nulls: number;
  distinct: number;
  /** Numeric values only — undefined when column isn't numeric. */
  min?: number;
  max?: number;
  sum?: number;
  avg?: number;
  top: Array<{ value: string; count: number }>;
  /** True if the underlying type is numeric (int/float). */
  numeric: boolean;
}

const TOP_N = 10;

function asKey(c: CellValue): { key: string; numeric: number | null } {
  switch (c.kind) {
    case "null":   return { key: "__NULL__", numeric: null };
    case "bool":   return { key: c.value ? "true" : "false", numeric: null };
    case "int":    return { key: String(c.value), numeric: c.value };
    case "float":  return { key: String(c.value), numeric: c.value };
    case "text":
    case "raw":    return { key: c.value, numeric: null };
    case "document": return { key: JSON.stringify(c.value), numeric: null };
    case "bytes":  return { key: `<${c.value.length} bytes>`, numeric: null };
  }
}

export function summarizeColumn(values: CellValue[]): ColumnSummary {
  const total = values.length;
  let nulls = 0;
  const numericValues: number[] = [];
  const counts = new Map<string, number>();

  for (const v of values) {
    if (v.kind === "null") { nulls += 1; continue; }
    const { key, numeric } = asKey(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (numeric != null && Number.isFinite(numeric)) numericValues.push(numeric);
  }

  const numeric = numericValues.length > 0 && numericValues.length === (total - nulls);
  let min: number | undefined, max: number | undefined, sum: number | undefined, avg: number | undefined;
  if (numeric) {
    min = numericValues[0]; max = numericValues[0]; sum = 0;
    for (const n of numericValues) {
      if (n < min!) min = n;
      if (n > max!) max = n;
      sum += n;
    }
    avg = sum / numericValues.length;
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([value, count]) => ({ value, count }));

  return { total, nulls, distinct: counts.size, min, max, sum, avg, top, numeric };
}
