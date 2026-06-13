/**
 * Compose INSERT statements from parsed rows + a column mapping.
 *
 * Conflict resolution:
 *   - "stop":   no ON CONFLICT clause; first PK violation raises.
 *   - "skip":   ON CONFLICT DO NOTHING — duplicate rows quietly ignored.
 *   - "update": ON CONFLICT (key) DO UPDATE SET col = EXCLUDED.col, ...
 *               Updates every non-key column on conflict.
 *
 * The composer is pure; the dialog runs the resulting statements through
 * `api.execute` inside a single transaction so a mid-import failure rolls
 * the whole thing back.
 */

export type ConflictMode = "stop" | "skip" | "update";

export interface InsertOptions {
  qualifiedTarget: string;      // "schema"."table"
  columns: string[];            // ordered target column names
  /** Quoted column names for the conflict key (must be unique-constrained
   *  for ON CONFLICT to work). PK is the typical default. */
  conflictKey: string[];
  mode: ConflictMode;
}

/* Helpers — kept private so callers can't get them out of sync. */
function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteValue(v: string | null): string {
  if (v === null) return "NULL";
  // Postgres accepts boolean literals as TRUE/FALSE bare; otherwise quote.
  if (v === "true" || v === "false") return v.toUpperCase();
  // Numeric? Pass through unquoted (cheap heuristic, server still type-checks).
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

export function composeInsert(opts: InsertOptions, row: Array<string | null>): string {
  const colList = opts.columns.map(quoteIdent).join(", ");
  const valueList = row.map(quoteValue).join(", ");
  let suffix = "";
  if (opts.mode === "skip") {
    if (opts.conflictKey.length === 0) {
      // Empty key with ON CONFLICT requires DO NOTHING with no target.
      suffix = " ON CONFLICT DO NOTHING";
    } else {
      const keys = opts.conflictKey.map(quoteIdent).join(", ");
      suffix = ` ON CONFLICT (${keys}) DO NOTHING`;
    }
  } else if (opts.mode === "update") {
    if (opts.conflictKey.length === 0) {
      // Can't do UPDATE without a target — fall back to skip.
      suffix = " ON CONFLICT DO NOTHING";
    } else {
      const keys = opts.conflictKey.map(quoteIdent).join(", ");
      const updates = opts.columns
        .filter((c) => !opts.conflictKey.includes(c))
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(", ");
      if (updates) {
        suffix = ` ON CONFLICT (${keys}) DO UPDATE SET ${updates}`;
      } else {
        // Every column is part of the key — there's nothing to update.
        suffix = ` ON CONFLICT (${keys}) DO NOTHING`;
      }
    }
  }
  return `INSERT INTO ${opts.qualifiedTarget} (${colList}) VALUES (${valueList})${suffix};`;
}

/** Convenience: batched INSERT for many rows in one statement. */
export function composeInsertBatch(
  opts: InsertOptions,
  rows: Array<Array<string | null>>,
): string {
  if (rows.length === 0) return "";
  if (rows.length === 1) return composeInsert(opts, rows[0]);
  const colList = opts.columns.map(quoteIdent).join(", ");
  const valuesList = rows
    .map((r) => "(" + r.map(quoteValue).join(", ") + ")")
    .join(",\n  ");
  let suffix = "";
  // Same conflict suffix as composeInsert.
  if (opts.mode === "skip") {
    suffix = opts.conflictKey.length
      ? ` ON CONFLICT (${opts.conflictKey.map(quoteIdent).join(", ")}) DO NOTHING`
      : " ON CONFLICT DO NOTHING";
  } else if (opts.mode === "update" && opts.conflictKey.length) {
    const keys = opts.conflictKey.map(quoteIdent).join(", ");
    const updates = opts.columns
      .filter((c) => !opts.conflictKey.includes(c))
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(", ");
    suffix = updates
      ? ` ON CONFLICT (${keys}) DO UPDATE SET ${updates}`
      : ` ON CONFLICT (${keys}) DO NOTHING`;
  }
  return `INSERT INTO ${opts.qualifiedTarget} (${colList}) VALUES\n  ${valuesList}${suffix};`;
}
