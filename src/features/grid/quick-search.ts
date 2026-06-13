/**
 * Client-side row filtering for the grid quick-search.
 *
 * Decoupled from React so it's easy to unit-test. The matcher takes a
 * substring and walks each row's cells producing a stringified
 * representation — that way the same logic works for nulls, ints, docs
 * (JSON), bytes (hex), etc.
 *
 * Performance: a single `String.includes` per row keeps the function
 * O(rows × cellLen) which is fine up to several thousand rows. For larger
 * result sets we'd want to virtualize the search itself, but that's
 * premature for now.
 */

import type { CellValue } from "@/ipc/types";

export interface MatchedRow {
  /** Index back into the original rows array. */
  index: number;
  /** Positions of the substring in the haystack — handy if we later want
   *  to highlight cell text inline. */
  positions: number[];
}

/** Unit-separator character (Unicode U+001F). Inserted between cells so a
 *  substring search can't accidentally bridge two adjacent cells (e.g.
 *  the search "bobidle" spanning a "Bob" and "idle" pair). */
export const CELL_SEP = "";

export function stringifyCell(v: CellValue): string {
  switch (v.kind) {
    case "null":     return "";
    case "bool":     return v.value ? "true" : "false";
    case "int":
    case "float":    return String(v.value);
    case "text":
    case "raw":      return v.value;
    case "document": return JSON.stringify(v.value);
    case "bytes":    return v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

export function stringifyRow(row: CellValue[]): string {
  let out = "";
  for (const v of row) {
    if (out.length) out += CELL_SEP;
    out += stringifyCell(v);
  }
  return out;
}

export function matches(needle: string, rows: CellValue[][]): MatchedRow[] {
  if (!needle) return rows.map((_, index) => ({ index, positions: [] }));
  const n = needle.toLowerCase();
  const out: MatchedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const hay = stringifyRow(rows[i]).toLowerCase();
    const pos = hay.indexOf(n);
    if (pos >= 0) {
      const positions: number[] = [];
      let p = pos;
      while (p >= 0) {
        positions.push(p);
        p = hay.indexOf(n, p + n.length);
      }
      out.push({ index: i, positions });
    }
  }
  return out;
}
