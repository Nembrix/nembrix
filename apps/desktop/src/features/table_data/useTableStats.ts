/**
 * Postgres-specific table + index size and row-count stats.
 *
 * We query the system catalogs directly rather than relying on `\dt+`
 * or any extension, so this works on stock Postgres without
 * pg_stat_statements or pg_buffercache.
 *
 * The numbers come back as raw bytes; the caller formats them with
 * `formatBytes` for display. Why bytes? Easier to sort, compare, and
 * pull into charts later.
 */

import { useAsyncResource } from "@/lib/useAsyncResource";
import * as api from "@/ipc/commands";

export interface TableStats {
  /** Includes indexes + toast tables. */
  totalBytes: number;
  /** Heap only (the table's main relation). */
  tableBytes: number;
  /** Sum of all secondary indexes for the table. */
  indexBytes: number;
  /** TOAST overhead — large columns moved out-of-band. */
  toastBytes: number;
  /** Estimated live row count from pg_class.reltuples. Negative when
   *  the planner hasn't analyzed yet — surface that to the user. */
  estimatedRows: number;
  /** Number of seq scans the planner recorded. */
  seqScans: number;
  /** Number of index scans the planner recorded. */
  idxScans: number;
  /** Last vacuum / analyze timestamps from pg_stat_user_tables. */
  lastVacuum: string | null;
  lastAnalyze: string | null;
}

export interface IndexStats {
  name: string;
  bytes: number;
  /** Number of times the planner used this index. */
  scans: number;
}

interface Result {
  stats: TableStats | null;
  indexes: IndexStats[];
  err: string | null;
  loading: boolean;
}

const STATS_SQL = `
WITH base AS (
  SELECT
    c.oid,
    pg_total_relation_size(c.oid) AS total_bytes,
    pg_relation_size(c.oid)       AS table_bytes,
    pg_indexes_size(c.oid)        AS index_bytes,
    COALESCE(pg_relation_size(c.reltoastrelid), 0) AS toast_bytes,
    c.reltuples::bigint           AS estimated_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm')
)
SELECT
  b.total_bytes,
  b.table_bytes,
  b.index_bytes,
  b.toast_bytes,
  b.estimated_rows,
  COALESCE(s.seq_scan, 0)::bigint AS seq_scan,
  COALESCE(s.idx_scan, 0)::bigint AS idx_scan,
  s.last_vacuum::text AS last_vacuum,
  s.last_analyze::text AS last_analyze
FROM base b
LEFT JOIN pg_stat_user_tables s ON s.relid = b.oid
LIMIT 1
`;

const INDEX_SQL = `
SELECT
  c.relname AS name,
  pg_relation_size(c.oid) AS bytes,
  COALESCE(s.idx_scan, 0)::bigint AS scans
FROM pg_class c
JOIN pg_index x ON x.indexrelid = c.oid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
WHERE n.nspname = $1 AND t.relname = $2
ORDER BY pg_relation_size(c.oid) DESC
`;

/** Query the catalogs for table + per-index size and scan stats. */
export function useTableStats(connId: string, schema: string, table: string): Result {
  const { data, error: err, loading } = useAsyncResource<{
    stats: TableStats | null;
    indexes: IndexStats[];
  }>(
    async (isCancelled) => {
      // Skip the stats query entirely when we don't have a valid
      // schema+table — the panes pass empty strings before sourceRelation
      // is hydrated, and running a catalog query bound to empty strings
      // either errors on the server or returns nothing useful but still
      // burns a roundtrip.
      if (!schema || !table) return { stats: null, indexes: [] };
      {
        // The streaming API is the only path that handles parameter
        // binding for us; we collect the single row in a buffer.
        const tableRows: unknown[][] = [];
        const indexRows: unknown[][] = [];

        const collect = (target: unknown[][]) => (b: { rows?: unknown[][]; done?: boolean }) => {
          // Defensive: backends may emit empty / shape-shifted batches
          // around the terminal one. Guard each access so a missing
          // field doesn't unwind the whole render tree.
          const rows = Array.isArray(b.rows) ? b.rows : [];
          for (const row of rows) {
            if (!Array.isArray(row)) continue;
            target.push(row.map((c) => {
              if (c && typeof c === "object" && "value" in (c as object)) {
                return (c as { value: unknown }).value;
              }
              return c;
            }));
          }
        };

        await new Promise<void>((res, rej) => {
          const sql = STATS_SQL
            .replace("$1", `'${schema.replace(/'/g, "''")}'`)
            .replace("$2", `'${table.replace(/'/g, "''")}'`);
          api.stream(connId, sql, (b) => {
            collect(tableRows)(b);
            if (b.done) res();
          }).catch(rej);
        });

        await new Promise<void>((res, rej) => {
          const sql = INDEX_SQL
            .replace("$1", `'${schema.replace(/'/g, "''")}'`)
            .replace("$2", `'${table.replace(/'/g, "''")}'`);
          api.stream(connId, sql, (b) => {
            collect(indexRows)(b);
            if (b.done) res();
          }).catch(rej);
        });

        if (isCancelled()) return { stats: null, indexes: [] };
        const r = tableRows[0];
        const stats: TableStats | null = r
          ? {
              totalBytes: Number(r[0] ?? 0),
              tableBytes: Number(r[1] ?? 0),
              indexBytes: Number(r[2] ?? 0),
              toastBytes: Number(r[3] ?? 0),
              estimatedRows: Number(r[4] ?? -1),
              seqScans: Number(r[5] ?? 0),
              idxScans: Number(r[6] ?? 0),
              lastVacuum: (r[7] as string | null) ?? null,
              lastAnalyze: (r[8] as string | null) ?? null,
            }
          : null;
        return {
          stats,
          indexes: indexRows.map((r) => ({
            name: String(r[0] ?? ""),
            bytes: Number(r[1] ?? 0),
            scans: Number(r[2] ?? 0),
          })),
        };
      }
    },
    [connId, schema, table],
  );

  return {
    stats: data?.stats ?? null,
    indexes: data?.indexes ?? [],
    err,
    loading,
  };
}

/** Format a byte count as "12.4 MB" / "256 KB" / "892 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
