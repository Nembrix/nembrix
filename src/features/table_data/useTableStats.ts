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

import { useEffect, useState } from "react";
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
  const [stats, setStats] = useState<TableStats | null>(null);
  const [indexes, setIndexes] = useState<IndexStats[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);

    const run = async () => {
      try {
        // The streaming API is the only path that handles parameter
        // binding for us; we collect the single row in a buffer.
        const tableRows: unknown[][] = [];
        const indexRows: unknown[][] = [];

        await new Promise<void>((res, rej) => {
          // Inline params via interpolation — params over JSON RPC are
          // a bigger lift than this catalog query justifies, and these
          // values are sourced from the schema cache (not user input).
          const sql = STATS_SQL
            .replace("$1", `'${schema.replace(/'/g, "''")}'`)
            .replace("$2", `'${table.replace(/'/g, "''")}'`);
          api.stream(connId, sql, (b) => {
            for (const row of b.rows) tableRows.push(row.map((c) => (c as { value: unknown }).value));
            if (b.done) res();
          }).catch(rej);
        });

        await new Promise<void>((res, rej) => {
          const sql = INDEX_SQL
            .replace("$1", `'${schema.replace(/'/g, "''")}'`)
            .replace("$2", `'${table.replace(/'/g, "''")}'`);
          api.stream(connId, sql, (b) => {
            for (const row of b.rows) indexRows.push(row.map((c) => (c as { value: unknown }).value));
            if (b.done) res();
          }).catch(rej);
        });

        if (cancelled) return;
        const r = tableRows[0];
        if (r) {
          setStats({
            totalBytes: Number(r[0] ?? 0),
            tableBytes: Number(r[1] ?? 0),
            indexBytes: Number(r[2] ?? 0),
            toastBytes: Number(r[3] ?? 0),
            estimatedRows: Number(r[4] ?? -1),
            seqScans: Number(r[5] ?? 0),
            idxScans: Number(r[6] ?? 0),
            lastVacuum: (r[7] as string | null) ?? null,
            lastAnalyze: (r[8] as string | null) ?? null,
          });
        }
        setIndexes(indexRows.map((r) => ({
          name: String(r[0] ?? ""),
          bytes: Number(r[1] ?? 0),
          scans: Number(r[2] ?? 0),
        })));
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [connId, schema, table]);

  return { stats, indexes, err, loading };
}

/** Format a byte count as "12.4 MB" / "256 KB" / "892 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
