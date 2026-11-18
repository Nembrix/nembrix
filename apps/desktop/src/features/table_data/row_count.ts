/**
 * Two-phase row counting for table-data tabs.
 *
 * `rows.length` only reflects what's been pulled into the grid (capped
 * at the tab's LIMIT). The user wants to see the TABLE's total — but a
 * naive COUNT(*) does a seq scan and can lock the UI on large tables.
 *
 * So we run two queries:
 *
 *   1. **Estimate** — pg_class.reltuples. Constant-time, accurate
 *      enough for "1.2M rows" to be meaningful. Returned immediately.
 *
 *   2. **Exact** — COUNT(*) with a short statement_timeout so it bails
 *      on giant tables. When it succeeds we replace the estimate.
 *
 * If the estimate query itself fails (permissions, non-pg backend) the
 * caller just shows the loaded-rows fallback. Callers must pass the
 * EXACT filter clause they used so the exact-count matches the visible
 * rows — for the estimate we always use the unfiltered reltuples, since
 * pg_class has no notion of WHERE.
 */

import * as api from "@/ipc/commands";
import type { CellValue } from "@/ipc/types";
import type { FilterChip } from "@/store";
import { buildMongoCount, buildRedisCount } from "./buildTableQuery";
import { qualify, stringLiteral, type SqlDialect } from "@/lib/sql-dialect";

/** Result of a single phase. `value` is null when the phase failed. */
export interface CountPhase {
  value: number | null;
  /** When true, the value is a planner estimate from pg_class, not exact. */
  estimate: boolean;
}

const EXACT_TIMEOUT_MS = 2500;

function asNumber(c: CellValue | undefined): number | null {
  if (!c) return null;
  if (c.kind === "int" || c.kind === "float") return c.value;
  if (c.kind === "text" || c.kind === "raw") {
    const n = parseFloat(c.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Mongo exact count via `db.<coll>.countDocuments(<filterDoc>)`. There's no
 * cheap planner estimate for Mongo (countDocuments already scans an index or
 * the collection), so the table-data caller uses this single-phase count
 * instead of the pg_class estimate + COUNT(*) pair. Returns null on error.
 */
export async function fetchMongoCount(
  connId: string,
  rel: { schema: string; table: string },
  filters: FilterChip[],
): Promise<number | null> {
  const cmd = buildMongoCount(rel, filters);
  return new Promise((resolve) => {
    let val: number | null = null;
    api.stream(connId, cmd, (b) => {
      if (b.rows.length > 0) val = asNumber(b.rows[0][0]);
      if (b.done) resolve(val);
    }).catch(() => resolve(null));
  });
}

/**
 * Redis key size via the type's cardinality command (`HLEN`, `LLEN`, `SCARD`,
 * `ZCARD`, `XLEN`). A string — or a module type with no such command — counts
 * as the single value the grid shows. Returns null on error.
 */
export async function fetchRedisCount(
  connId: string,
  key: string,
  type: string | undefined,
): Promise<number | null> {
  const cmd = buildRedisCount(key, type);
  if (!cmd) return 1;
  return new Promise((resolve) => {
    let val: number | null = null;
    api.stream(connId, cmd, (b) => {
      if (b.rows.length > 0) val = asNumber(b.rows[0][0]);
      if (b.done) resolve(val);
    }).catch(() => resolve(null));
  });
}

/** First phase: instant estimate from pg_class.reltuples. */
export async function fetchEstimate(
  connId: string,
  schema: string,
  table: string,
  d: SqlDialect = "postgres",
): Promise<number | null> {
  // SQLite keeps no row-count statistics; the exact count is all there is.
  if (d === "sqlite") return null;
  // SQL Server: the row counts kept per partition of the heap / clustered
  // index — what SSMS shows, maintained without a scan.
  if (d === "mssql") {
    return streamCount(
      connId,
      `SELECT SUM(p.rows) FROM sys.partitions p ` +
        `WHERE p.object_id = OBJECT_ID(${stringLiteral(d, qualify(d, schema, table))}) ` +
        `AND p.index_id IN (0, 1);`,
    );
  }
  // MySQL / MariaDB: InnoDB's statistics estimate, the same order of
  // accuracy as reltuples.
  const sql = d === "mysql" ? `
    SELECT TABLE_ROWS AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ${stringLiteral(d, schema)}
       AND TABLE_NAME = ${stringLiteral(d, table)};
  ` : `
    SELECT reltuples::bigint AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = '${schema.replace(/'/g, "''")}'
       AND c.relname = '${table.replace(/'/g, "''")}'
       AND c.relkind IN ('r', 'p', 'm');
  `;
  return new Promise((resolve) => {
    let val: number | null = null;
    api.stream(connId, sql, (b) => {
      if (b.rows.length > 0) val = asNumber(b.rows[0][0]);
      if (b.done) resolve(val);
    }).catch(() => resolve(null));
  });
}

/**
 * Second phase: exact count, bounded by a short statement_timeout. Filter
 * clause is optional — when given, it must already be a valid WHERE body
 * (including the leading `WHERE`). Caller is responsible for quoting.
 *
 * The timeout and the count travel as ONE multi-statement string: Postgres
 * runs it as a single implicit transaction, so `SET LOCAL` covers exactly
 * this count and ends with it — on the same connection, with nothing left
 * open. (Separate BEGIN / SET LOCAL / SELECT calls can each land on a
 * different pooled connection.) Returns null on timeout or error.
 */
export async function fetchExact(
  connId: string,
  schema: string,
  table: string,
  whereClause?: string,
  d: SqlDialect = "postgres",
): Promise<number | null> {
  const where = whereClause ? ` ${whereClause}` : "";
  if (d === "mysql") {
    // MySQL bounds the count with an optimizer hint on the statement itself —
    // no transaction or session state needed. MariaDB doesn't know the hint
    // and reads it as a comment, so there the count simply runs to completion.
    return streamCount(
      connId,
      `SELECT /*+ MAX_EXECUTION_TIME(${EXACT_TIMEOUT_MS}) */ COUNT(*) FROM ${qualify(d, schema, table)}${where};`,
    );
  }
  // SQL Server has no per-statement time limit; COUNT_BIG because COUNT is
  // an int and overflows past 2^31 rows.
  if (d === "mssql") return streamCount(connId, `SELECT COUNT_BIG(*) FROM ${qualify(d, schema, table)}${where};`);
  // SQLite has no statement timeout; a local file counts quickly enough.
  if (d === "sqlite") return streamCount(connId, `SELECT COUNT(*) FROM ${qualify(d, schema, table)}${where};`);
  return streamCount(
    connId,
    `SET LOCAL statement_timeout = ${EXACT_TIMEOUT_MS}; ` +
      `SELECT COUNT(*) FROM ${qualify(d, schema, table)}${where};`,
  );
}

/** Run a single-value count; null on an error or time limit. */
function streamCount(connId: string, sql: string): Promise<number | null> {
  return new Promise((resolve) => {
    let val: number | null = null;
    let sawColumns = false;
    api.stream(connId, sql, (b) => {
      if (b.columns) sawColumns = true;
      // An in-band error (e.g. the time limit) arrives as a column-less row.
      if (sawColumns && b.rows.length > 0) val = asNumber(b.rows[0][0]);
      if (b.done) resolve(val);
    }).catch(() => resolve(null));
  });
}
