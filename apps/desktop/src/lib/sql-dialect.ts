/** SQL dialect helpers: the few places Postgres, MySQL/MariaDB, SQLite and SQL Server differ in
 *  the SQL Nembrix generates (table browsing, filters, row edits, counts,
 *  exports). Postgres-specific tooling (roles, activity, DDL editors) stays
 *  Postgres-only and isn't routed through here. */

export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql";

/** Quote an identifier: `"name"` (Postgres, SQLite), `` `name` `` (MySQL) or
 *  `[name]` (SQL Server), doubling the closing quote character inside. MySQL
 *  reads `"…"` as a string literal by default, and SQL Server only takes
 *  `"…"` under QUOTED_IDENTIFIER, so the styles are not interchangeable. */
export function quoteIdent(d: SqlDialect, name: string): string {
  if (d === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (d === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table`, each part quoted. */
export function qualify(d: SqlDialect, schema: string, table: string): string {
  return `${quoteIdent(d, schema)}.${quoteIdent(d, table)}`;
}

/** A string literal. MySQL also treats `\` as an escape character inside
 *  literals (unless NO_BACKSLASH_ESCAPES is set — doubling stays correct
 *  either way for `'`, and only matters for `\`), so it's doubled there too.
 *  Postgres with standard_conforming_strings (the default since 9.1) takes
 *  backslashes literally. SQL Server needs the `N` prefix for Unicode: a
 *  plain `'…'` goes through the database's code page and loses anything
 *  outside it. */
export function stringLiteral(d: SqlDialect, s: string): string {
  const body = d === "mysql" ? s.replace(/\\/g, "\\\\") : s;
  return `${d === "mssql" ? "N" : ""}'${body.replace(/'/g, "''")}'`;
}

/** A boolean literal. SQL Server has no TRUE/FALSE: `bit` takes 1 / 0. */
export function boolLiteral(d: SqlDialect, b: boolean): string {
  if (d === "mssql") return b ? "1" : "0";
  return b ? "TRUE" : "FALSE";
}

/** `SELECT * FROM <rest>` capped at `n` rows — `rest` is everything after
 *  FROM (relation, WHERE, ORDER BY). SQL Server has no LIMIT: `TOP (n)`. */
export function selectStar(d: SqlDialect, rest: string, n: number): string {
  return d === "mssql" ? `SELECT TOP (${n}) * FROM ${rest}` : `SELECT * FROM ${rest} LIMIT ${n}`;
}

/** Tack a row limit onto an editor query when it looks like a SELECT and the
 *  user didn't already cap it. Parsed very loosely — anything with a SELECT
 *  keyword and no LIMIT qualifies; false positives (e.g. a CTE-wrapped
 *  statement) are fine, the server accepts an outer LIMIT.
 *
 *  SQL Server has no LIMIT, and its `TOP` goes inside the statement, so only
 *  a query that starts with SELECT is capped there; anything else (a CTE, a
 *  DECLARE-led batch) runs as typed. */
export function withRowLimit(d: SqlDialect, raw: string, limit: number): string {
  if (d === "mssql") {
    if (/\bTOP\b|\bFETCH\s+(NEXT|FIRST)\b/i.test(raw)) return raw;
    const head = raw.match(/^\s*SELECT\s+(DISTINCT\s+)?/i)?.[0];
    return head ? `${head}TOP (${limit}) ${raw.slice(head.length)}` : raw;
  }
  const trimmed = raw.trimEnd().replace(/;\s*$/, "");
  const upper = trimmed.toUpperCase();
  if (!upper.includes("SELECT")) return raw;
  if (/\bLIMIT\b\s+\d+/.test(upper)) return raw;
  return `${trimmed}\nLIMIT ${limit};`;
}

/** Case-insensitive `LIKE`: Postgres has ILIKE; MySQL and SQL Server have
 *  none, so compare lower-cased (their `LIKE` already ignores case under the
 *  default `_ci` / `_CI_` collations, but not under binary or case-sensitive
 *  ones). SQLite's `LIKE` ignores case already (ASCII only — and so does its
 *  LOWER()). */
export function ilike(d: SqlDialect, expr: string, pattern: string, negate: boolean): string {
  const verb = negate ? "NOT LIKE" : "LIKE";
  if (d === "postgres") return `${expr} ${negate ? "NOT ILIKE" : "ILIKE"} ${pattern}`;
  if (d === "sqlite") return `${expr} ${verb} ${pattern}`;
  return `LOWER(${expr}) ${verb} LOWER(${pattern})`;
}

/** Escape `%`, `_` and `\` so user input matches literally inside a LIKE
 *  pattern — and `[`, which opens a character class in SQL Server. `\` is the
 *  escape character: the default in Postgres and MySQL, declared with
 *  `ESCAPE` in SQLite and SQL Server (which have no default one). */
function escapeLike(d: SqlDialect, v: string): string {
  const out = v.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return d === "mssql" ? out.replace(/\[/g, "\\[") : out;
}

/** `expr` contains `value` as a substring — the grid's CONTAINS filters.
 *  Case-sensitive: plain `LIKE` in Postgres, `LIKE BINARY` in MySQL (whose
 *  `LIKE` follows the column collation, case-insensitive by default),
 *  `instr()` in SQLite (whose `LIKE` always ignores ASCII case), and a binary
 *  collation in SQL Server (the cast first: COLLATE only applies to text,
 *  and the grid filters any column). */
export function contains(
  d: SqlDialect,
  expr: string,
  value: string,
  opts: { caseInsensitive: boolean; negate: boolean },
): string {
  const { caseInsensitive, negate } = opts;
  if (d === "sqlite") {
    if (!caseInsensitive) return `instr(${expr}, ${stringLiteral(d, value)}) ${negate ? "=" : ">"} 0`;
    const pattern = stringLiteral(d, `%${escapeLike(d, value)}%`);
    return `${expr} ${negate ? "NOT LIKE" : "LIKE"} ${pattern} ESCAPE '\\'`;
  }
  const pattern = stringLiteral(d, `%${escapeLike(d, value)}%`);
  if (d === "mssql") {
    const lhs = caseInsensitive ? `LOWER(${expr})` : `CAST(${expr} AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2`;
    const rhs = caseInsensitive ? `LOWER(${pattern})` : pattern;
    return `${lhs} ${negate ? "NOT LIKE" : "LIKE"} ${rhs} ESCAPE '\\'`;
  }
  if (caseInsensitive) return ilike(d, expr, pattern, negate);
  const verb = negate ? "NOT LIKE" : "LIKE";
  return d === "mysql" ? `${expr} ${verb} BINARY ${pattern}` : `${expr} ${verb} ${pattern}`;
}
