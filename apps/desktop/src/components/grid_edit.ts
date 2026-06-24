/**
 * Helpers for inline grid cell editing.
 *
 * Edits are committed via a one-row UPDATE keyed by the table's primary
 * key. We keep these as plain functions so they can be unit-tested without
 * pulling in React / store dependencies.
 */

import type { CellValue, ColMeta } from "@/ipc/types";

/** Quote a Postgres identifier (table, column). */
function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Render a CellValue as a SQL literal suitable for a WHERE clause. */
export function pkLiteral(v: CellValue): string {
  switch (v.kind) {
    case "null":  return "NULL"; // not valid in equality; caller checks
    case "bool":  return v.value ? "TRUE" : "FALSE";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw":   return `'${v.value.replace(/'/g, "''")}'`;
    case "document": return `'${JSON.stringify(v.value).replace(/'/g, "''")}'::jsonb`;
    case "bytes": {
      const hex = v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
      return `'\\x${hex}'::bytea`;
    }
  }
}

/**
 * Render a user-entered string as a SQL literal for the SET clause.
 * Empty string → empty string literal '' (not NULL — call setNullSql for that).
 * Numeric-typed columns accept bare numeric literals (no quotes); booleans
 * use TRUE/FALSE; jsonb gets ::jsonb cast; everything else quotes.
 */
export function valueLiteral(input: string, typeName: string): string {
  const t = typeName.toLowerCase().replace(/\(.+\)$/, "").trim();
  if (input === "") return "''";
  if (["int2", "int4", "int8", "smallint", "integer", "bigint"].includes(t)) {
    return input; // user is responsible for digits; pg will reject otherwise
  }
  if (["float4", "float8", "real", "double precision", "numeric", "decimal", "money"].includes(t)) {
    return input;
  }
  if (["bool", "boolean"].includes(t)) {
    return /^(t|true|1|y|yes)$/i.test(input.trim()) ? "TRUE" : "FALSE";
  }
  if (["json", "jsonb"].includes(t)) {
    return `'${input.replace(/'/g, "''")}'::${t}`;
  }
  return `'${input.replace(/'/g, "''")}'`;
}

/**
 * Build the UPDATE statement for a single-cell edit.
 *
 * `pkValues` is an object keyed by PK column name → the row's PK value.
 * Throws if any PK component is NULL — we won't issue an UPDATE that
 * could collide with multiple rows.
 *
 * `newLiteral` is the already-quoted SQL literal for SET. Pass the string
 * "NULL" to clear the cell to null.
 */
export function buildUpdate(opts: {
  schema: string;
  table: string;
  column: string;
  newLiteral: string;
  pkColumns: string[];
  pkValues: Record<string, CellValue>;
}): string {
  if (opts.pkColumns.length === 0) {
    throw new Error("Cannot edit cells in a table without a primary key.");
  }
  const where = opts.pkColumns.map((col) => {
    const v = opts.pkValues[col];
    if (!v || v.kind === "null") {
      throw new Error(`Primary key column "${col}" is null — refusing to UPDATE.`);
    }
    return `${qi(col)} = ${pkLiteral(v)}`;
  }).join(" AND ");
  const qt = `${qi(opts.schema)}.${qi(opts.table)}`;
  return `UPDATE ${qt} SET ${qi(opts.column)} = ${opts.newLiteral} WHERE ${where};`;
}

/** Render a cell as plain text for clipboard / display. */
export function cellToText(c: CellValue): string {
  switch (c.kind) {
    case "null":     return "";
    case "bool":     return c.value ? "true" : "false";
    case "int":
    case "float":    return String(c.value);
    case "text":
    case "raw":      return c.value;
    case "document": return JSON.stringify(c.value);
    case "bytes":    return `\\x${c.value.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
}

/** Index PK column values for the given row. Returns undefined if the
 *  table has no PK or any PK component is missing from the column list. */
export function pkValuesFor(
  cols: ColMeta[],
  row: CellValue[],
  pkColumns: string[],
): Record<string, CellValue> | undefined {
  if (pkColumns.length === 0) return undefined;
  const out: Record<string, CellValue> = {};
  for (const pk of pkColumns) {
    const idx = cols.findIndex((c) => c.name === pk);
    if (idx < 0) return undefined;
    out[pk] = row[idx];
  }
  return out;
}
