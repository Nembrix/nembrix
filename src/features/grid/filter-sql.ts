/**
 * Compile filter chips into a SQL fragment, and rewrite a query so its
 * WHERE clause matches the active chip list.
 *
 * Rules:
 *  - We only touch queries that match `SELECT … FROM <relation> [LIMIT …] [;]`
 *    Anything more complex (JOINs, CTEs, subqueries) is left alone — the
 *    user manages those by hand.
 *  - The rewrite is idempotent: stripping the previously-injected WHERE
 *    block, then injecting a fresh one based on the current chips.
 */

import type { FilterChip } from "@/store";

const MARKER_START = "/*__dbclient_filters__*/";
const MARKER_END = "/*__/dbclient_filters__*/";

export function clauseFor(chip: FilterChip): string {
  const col = `"${chip.column.replace(/"/g, '""')}"`;
  switch (chip.op) {
    case "IS NULL":     return `${col} IS NULL`;
    case "IS NOT NULL": return `${col} IS NOT NULL`;
    case "LIKE":
    case "ILIKE": {
      const v = (chip.value ?? "").replace(/'/g, "''");
      return `${col} ${chip.op} '${v}'`;
    }
    case "CONTAINS":
    case "NOT CONTAINS":
    case "ICONTAINS":
    case "NOT ICONTAINS": {
      // Substring search — escape user input so a literal % / _ doesn't
      // sneak in as a wildcard.
      const v = (chip.value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")
        .replace(/'/g, "''");
      const verb =
        chip.op === "CONTAINS"      ? "LIKE" :
        chip.op === "NOT CONTAINS"  ? "NOT LIKE" :
        chip.op === "ICONTAINS"     ? "ILIKE" :
                                      "NOT ILIKE";
      return `${col} ${verb} '%${v}%'`;
    }
    default: {
      const v = chip.value ?? "";
      // Numeric literals pass through; other values get quoted.
      const lit = /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
      return `${col} ${chip.op} ${lit}`;
    }
  }
}

export function buildWhereFragment(chips: FilterChip[]): string {
  // Honor the enabled flag so the user can stage chips in the builder
  // without committing them — disabled chips don't appear in SQL.
  const active = chips.filter((c) => c.enabled !== false);
  if (!active.length) return "";
  const parts = active.map(clauseFor).join(" AND ");
  return ` ${MARKER_START} WHERE ${parts} ${MARKER_END}`;
}

/**
 * Replace any previously-injected filter block with the new one. The marker
 * comments make the rewrite reliable even if the user has typed around them.
 */
export function rewriteSqlWithFilters(sql: string, chips: FilterChip[]): string {
  const stripped = stripFilters(sql);
  if (!chips.length) return stripped;
  const fragment = buildWhereFragment(chips).trimStart();

  // Inject before the first LIMIT/ORDER BY/; we encounter, else at the end.
  const match = stripped.match(/\b(LIMIT|ORDER\s+BY|GROUP\s+BY|OFFSET)\b/i);
  if (match && match.index != null) {
    const head = stripped.slice(0, match.index).replace(/\s+$/, "");
    const tail = stripped.slice(match.index);
    return `${head} ${fragment} ${tail}`;
  }
  return stripped.replace(/;?\s*$/, "") + ` ${fragment};`;
}

export function stripFilters(sql: string): string {
  // Remove any previous marker block, including a leading WHERE we owned.
  const re = new RegExp(
    `\\s*${escape(MARKER_START)}[\\s\\S]*?${escape(MARKER_END)}`,
    "g",
  );
  return sql.replace(re, "");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
