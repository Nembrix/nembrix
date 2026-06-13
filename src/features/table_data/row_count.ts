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

/** First phase: instant estimate from pg_class.reltuples. */
export async function fetchEstimate(
  connId: string,
  schema: string,
  table: string,
): Promise<number | null> {
  const sql = `
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
 * Second phase: exact count with a short statement_timeout. Filter clause
 * is optional — when given, it must already be a valid WHERE body
 * (including the leading `WHERE`). Caller is responsible for quoting.
 *
 * Wraps in BEGIN/SET LOCAL/COMMIT so the timeout applies only to this
 * count, not the connection. Returns null on timeout or error.
 */
export async function fetchExact(
  connId: string,
  schema: string,
  table: string,
  whereClause?: string,
): Promise<number | null> {
  const where = whereClause ? ` ${whereClause}` : "";
  // SET LOCAL only persists for the transaction, so we don't bleed the
  // timeout into subsequent queries on the same pooled connection.
  try {
    await api.execute(connId, "BEGIN;");
    await api.execute(connId, `SET LOCAL statement_timeout = ${EXACT_TIMEOUT_MS};`);
  } catch {
    return null;
  }
  let val: number | null = null;
  try {
    await new Promise<void>((res, rej) => {
      api.stream(
        connId,
        `SELECT COUNT(*) FROM "${schema}"."${table}"${where};`,
        (b) => {
          if (b.rows.length > 0) val = asNumber(b.rows[0][0]);
          if (b.done) res();
        },
      ).catch(rej);
    });
  } catch {
    val = null;
  } finally {
    try { await api.execute(connId, "ROLLBACK;"); } catch { /* ignore */ }
  }
  return val;
}
