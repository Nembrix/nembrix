/**
 * Helpers for inline grid cell editing.
 *
 * Edits are committed via a one-row UPDATE keyed by the table's primary
 * key. We keep these as plain functions so they can be unit-tested without
 * pulling in React / store dependencies.
 */

import type { CellValue, ColMeta } from "@/ipc/types";
import { qualify, quoteIdent, stringLiteral, type SqlDialect } from "@/lib/sql-dialect";

/** Render a CellValue as a SQL literal suitable for a WHERE clause. */
export function pkLiteral(v: CellValue, d: SqlDialect = "postgres"): string {
  switch (v.kind) {
    case "null":  return "NULL"; // not valid in equality; caller checks
    case "bool":  return v.value ? "TRUE" : "FALSE";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw":   return stringLiteral(d, v.value);
    case "document": {
      const lit = stringLiteral(d, JSON.stringify(v.value));
      // MySQL compares a JSON column with CAST(… AS JSON); Postgres casts;
      // SQLite stores JSON as text.
      if (d === "mysql") return `CAST(${lit} AS JSON)`;
      return d === "sqlite" ? lit : `${lit}::jsonb`;
    }
    case "bytes": {
      const hex = v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
      return d === "postgres" ? `'\\x${hex}'::bytea` : `X'${hex}'`;
    }
  }
}

/**
 * Render a user-entered string as a SQL literal for the SET clause.
 * Empty string → empty string literal '' (not NULL — call setNullSql for that).
 * Numeric-typed columns accept bare numeric literals (no quotes); booleans
 * use TRUE/FALSE; jsonb gets ::jsonb cast; everything else quotes.
 */
export function valueLiteral(input: string, typeName: string, d: SqlDialect = "postgres"): string {
  const t = typeName.toLowerCase().replace(/\(.+\)$/, "").replace(/ unsigned$/, "").trim();
  if (input === "") return "''";
  const numeric = [
    "int2", "int4", "int8", "smallint", "integer", "bigint",
    "float4", "float8", "real", "double precision", "numeric", "decimal", "money",
    // MySQL / MariaDB names
    "tinyint", "mediumint", "int", "double", "float",
  ];
  // Bare only when it really is a number — anything else is quoted, so the
  // input can never end up as SQL syntax.
  if (numeric.includes(t) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(input.trim())) {
    return input.trim();
  }
  if (["bool", "boolean"].includes(t)) {
    return /^(t|true|1|y|yes)$/i.test(input.trim()) ? "TRUE" : "FALSE";
  }
  if (["json", "jsonb"].includes(t)) {
    return d === "postgres" ? `${stringLiteral(d, input)}::${t}` : stringLiteral(d, input);
  }
  return stringLiteral(d, input);
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
  dialect?: SqlDialect;
}): string {
  const d = opts.dialect ?? "postgres";
  if (opts.pkColumns.length === 0) {
    throw new Error("Cannot edit cells in a table without a primary key.");
  }
  const where = opts.pkColumns.map((col) => {
    const v = opts.pkValues[col];
    if (!v || v.kind === "null") {
      throw new Error(`Primary key column "${col}" is null — refusing to UPDATE.`);
    }
    return `${quoteIdent(d, col)} = ${pkLiteral(v, d)}`;
  }).join(" AND ");
  const qt = qualify(d, opts.schema, opts.table);
  return `UPDATE ${qt} SET ${quoteIdent(d, opts.column)} = ${opts.newLiteral} WHERE ${where};`;
}

/**
 * Build a single-row DELETE keyed by the table's primary key. Mirrors
 * buildUpdate's WHERE construction: throws if the table has no PK or any PK
 * component is NULL (a NULL WHERE couldn't safely target one row).
 */
export function buildDelete(opts: {
  schema: string;
  table: string;
  pkColumns: string[];
  pkValues: Record<string, CellValue>;
  dialect?: SqlDialect;
}): string {
  const d = opts.dialect ?? "postgres";
  if (opts.pkColumns.length === 0) {
    throw new Error("Cannot delete rows in a table without a primary key.");
  }
  const where = opts.pkColumns.map((col) => {
    const v = opts.pkValues[col];
    if (!v || v.kind === "null") {
      throw new Error(`Primary key column "${col}" is null — refusing to DELETE.`);
    }
    return `${quoteIdent(d, col)} = ${pkLiteral(v, d)}`;
  }).join(" AND ");
  const qt = qualify(d, opts.schema, opts.table);
  return `DELETE FROM ${qt} WHERE ${where};`;
}

/**
 * Build an INSERT for a draft row. `values` maps column name → the
 * already-rendered SQL literal; columns left out get their DB default. An
 * empty map inserts a row of defaults — `DEFAULT VALUES` in Postgres,
 * `() VALUES ()` in MySQL (which has no DEFAULT VALUES).
 */
export function buildInsert(opts: {
  schema: string;
  table: string;
  values: [column: string, literal: string][];
  dialect?: SqlDialect;
}): string {
  const d = opts.dialect ?? "postgres";
  const qt = qualify(d, opts.schema, opts.table);
  if (opts.values.length === 0) {
    return d === "mysql" ? `INSERT INTO ${qt} () VALUES ();` : `INSERT INTO ${qt} DEFAULT VALUES;`;
  }
  const cols = opts.values.map(([c]) => quoteIdent(d, c)).join(", ");
  const vals = opts.values.map(([, v]) => v).join(", ");
  return `INSERT INTO ${qt} (${cols}) VALUES (${vals});`;
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
