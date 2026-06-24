/**
 * Pure format engines: (columns, rows, options) -> string.
 *
 * Each engine handles its own escaping. They share the same `CellValue` shape
 * the grid uses so we don't have to invent a parallel intermediate format.
 *
 * Tests live in format.test.ts — exercise NULL handling, quoting, escaping,
 * and the obvious edge cases (embedded newlines, embedded quotes, jsonb).
 */

import type { CellValue, ColMeta } from "@/ipc/types";

export type ExportFormat = "csv" | "json" | "jsonl" | "sql";

export interface CsvOptions {
  delimiter: string;       // typically "," or "\t"
  quote: string;           // typically "\""
  header: boolean;
  /** What to render for NULL — empty string by default, "\\N" for psql COPY. */
  nullToken: string;
  lineEnding: "\n" | "\r\n";
}

export interface JsonOptions {
  /** When true, emit one object per line (NDJSON / JSONL). */
  lines: boolean;
  /** Pretty-print non-lines output. */
  indent: number;
}

export interface SqlOptions {
  /** Fully-qualified target — "schema"."name". Required for valid SQL. */
  qualifiedTarget: string;
  /** Rows per INSERT statement. Larger = faster but harder to read. */
  batchSize: number;
}

export const DEFAULT_CSV: CsvOptions = {
  delimiter: ",",
  quote: '"',
  header: true,
  // NULL → literal "NULL" by default so it round-trips as null when
  // re-imported, instead of colliding with empty strings.
  nullToken: "NULL",
  lineEnding: "\n",
};

export const DEFAULT_JSON: JsonOptions = { lines: false, indent: 2 };

/* ───────────────────────── CSV ───────────────────────── */

export function exportCsv(
  columns: ColMeta[],
  rows: CellValue[][],
  opts: CsvOptions = DEFAULT_CSV,
): string {
  const out: string[] = [];
  if (opts.header) {
    out.push(columns.map((c) => csvEscape(c.name, opts)).join(opts.delimiter));
  }
  for (const row of rows) {
    out.push(row.map((v) => csvEscape(stringifyForCsv(v, opts.nullToken), opts)).join(opts.delimiter));
  }
  return out.join(opts.lineEnding) + opts.lineEnding;
}

function csvEscape(s: string, opts: CsvOptions): string {
  // RFC 4180-ish: quote a field iff it contains the delimiter, quote, CR, or LF.
  const needsQuote = s.includes(opts.delimiter)
    || s.includes(opts.quote)
    || s.includes("\n")
    || s.includes("\r");
  if (!needsQuote) return s;
  // Double up embedded quotes inside the quoted field.
  return opts.quote + s.split(opts.quote).join(opts.quote + opts.quote) + opts.quote;
}

function stringifyForCsv(v: CellValue, nullToken: string): string {
  switch (v.kind) {
    case "null": return nullToken;
    case "bool": return v.value ? "true" : "false";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw": return v.value;
    case "document": return JSON.stringify(v.value);
    case "bytes":
      // Hex with \x prefix matches Postgres' bytea text representation.
      return "\\x" + v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/* ───────────────────────── JSON / JSONL ───────────────────────── */

export function exportJson(
  columns: ColMeta[],
  rows: CellValue[][],
  opts: JsonOptions = DEFAULT_JSON,
): string {
  const objects = rows.map((row) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c.name] = jsonValue(row[i]); });
    return o;
  });
  if (opts.lines) {
    return objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  }
  return JSON.stringify(objects, null, opts.indent);
}

function jsonValue(v: CellValue): unknown {
  switch (v.kind) {
    case "null":     return null;
    case "bool":     return v.value;
    case "int":
    case "float":    return v.value;
    case "text":
    case "raw":      return v.value;
    case "document": return v.value;
    case "bytes":    return v.value; // Number[] — JSON-clean
  }
}

/* ───────────────────────── SQL INSERT ───────────────────────── */

export function exportSqlInsert(
  columns: ColMeta[],
  rows: CellValue[][],
  opts: SqlOptions,
): string {
  if (!opts.qualifiedTarget) throw new Error("qualifiedTarget is required");
  if (rows.length === 0) return `-- no rows\n`;
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");
  const header = `INSERT INTO ${opts.qualifiedTarget} (${colList}) VALUES`;
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += opts.batchSize) {
    const batch = rows.slice(i, i + opts.batchSize);
    const values = batch.map((r) => `  (${r.map(sqlLiteral).join(", ")})`).join(",\n");
    out.push(`${header}\n${values};`);
  }
  return out.join("\n\n") + "\n";
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function sqlLiteral(v: CellValue): string {
  switch (v.kind) {
    case "null": return "NULL";
    case "bool": return v.value ? "TRUE" : "FALSE";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw":  return `'${v.value.replace(/'/g, "''")}'`;
    case "document": return `'${JSON.stringify(v.value).replace(/'/g, "''")}'::jsonb`;
    case "bytes":
      return `decode('${v.value.map((b) => b.toString(16).padStart(2, "0")).join("")}', 'hex')`;
  }
}

/* ───────────────────────── orchestrator ───────────────────────── */

export interface ExportOpts {
  format: ExportFormat;
  columns: ColMeta[];
  rows: CellValue[][];
  /** Only-included column names; pass `null` to include all columns. */
  includeColumns?: string[] | null;
  csv?: Partial<CsvOptions>;
  json?: Partial<JsonOptions>;
  sql?: Partial<SqlOptions> & { qualifiedTarget?: string };
}

export function exportRows(opts: ExportOpts): string {
  const { cols, rows } = filterColumns(opts.columns, opts.rows, opts.includeColumns ?? null);
  switch (opts.format) {
    case "csv":
      return exportCsv(cols, rows, { ...DEFAULT_CSV, ...opts.csv });
    case "json":
      return exportJson(cols, rows, { ...DEFAULT_JSON, ...opts.json, lines: false });
    case "jsonl":
      return exportJson(cols, rows, { ...DEFAULT_JSON, ...opts.json, lines: true });
    case "sql":
      return exportSqlInsert(cols, rows, {
        qualifiedTarget: opts.sql?.qualifiedTarget ?? "",
        batchSize: opts.sql?.batchSize ?? 100,
      });
  }
}

export function filterColumns(
  columns: ColMeta[],
  rows: CellValue[][],
  include: string[] | null,
): { cols: ColMeta[]; rows: CellValue[][] } {
  if (!include) return { cols: columns, rows };
  const keepIdxs: number[] = [];
  columns.forEach((c, i) => { if (include.includes(c.name)) keepIdxs.push(i); });
  return {
    cols: keepIdxs.map((i) => columns[i]),
    rows: rows.map((r) => keepIdxs.map((i) => r[i])),
  };
}

export function suggestExt(format: ExportFormat): string {
  switch (format) {
    case "csv": return "csv";
    case "json": return "json";
    case "jsonl": return "jsonl";
    case "sql": return "sql";
  }
}

export function mimeType(format: ExportFormat): string {
  switch (format) {
    case "csv": return "text/csv;charset=utf-8";
    case "json": return "application/json";
    case "jsonl": return "application/x-ndjson";
    case "sql": return "application/sql";
  }
}
