/** SQL dialect helpers: the few places Postgres, MySQL/MariaDB and SQLite differ in
 *  the SQL Nembrix generates (table browsing, filters, row edits, counts,
 *  exports). Postgres-specific tooling (roles, activity, DDL editors) stays
 *  Postgres-only and isn't routed through here. */

export type SqlDialect = "postgres" | "mysql" | "sqlite";

/** Quote an identifier: `"name"` (Postgres, SQLite) or `` `name` `` (MySQL),
 *  doubling the quote character inside. MySQL reads `"…"` as a string
 *  literal by default, so the quote style is not interchangeable. */
export function quoteIdent(d: SqlDialect, name: string): string {
  return d === "mysql"
    ? "`" + name.replace(/`/g, "``") + "`"
    : `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table`, each part quoted. */
export function qualify(d: SqlDialect, schema: string, table: string): string {
  return `${quoteIdent(d, schema)}.${quoteIdent(d, table)}`;
}

/** A string literal. MySQL also treats `\` as an escape character inside
 *  literals (unless NO_BACKSLASH_ESCAPES is set — doubling stays correct
 *  either way for `'`, and only matters for `\`), so it's doubled there too.
 *  Postgres with standard_conforming_strings (the default since 9.1) takes
 *  backslashes literally. */
export function stringLiteral(d: SqlDialect, s: string): string {
  const body = d === "mysql" ? s.replace(/\\/g, "\\\\") : s;
  return `'${body.replace(/'/g, "''")}'`;
}

/** Case-insensitive `LIKE`: Postgres has ILIKE; MySQL has none, so compare
 *  lower-cased (its `LIKE` already ignores case under the default `_ci`
 *  collations, but not under `_bin`/`_cs` ones). SQLite's `LIKE` ignores
 *  case already (ASCII only — and so does its LOWER()). */
export function ilike(d: SqlDialect, expr: string, pattern: string, negate: boolean): string {
  const verb = negate ? "NOT LIKE" : "LIKE";
  if (d === "postgres") return `${expr} ${negate ? "NOT ILIKE" : "ILIKE"} ${pattern}`;
  if (d === "sqlite") return `${expr} ${verb} ${pattern}`;
  return `LOWER(${expr}) ${verb} LOWER(${pattern})`;
}

/** Escape `%`, `_` and `\` so user input matches literally inside a LIKE
 *  pattern. `\` is the escape character: the default in Postgres and MySQL,
 *  declared with `ESCAPE` in SQLite (which has no default one). */
function escapeLike(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** `expr` contains `value` as a substring — the grid's CONTAINS filters.
 *  Case-sensitive: plain `LIKE` in Postgres, `LIKE BINARY` in MySQL (whose
 *  `LIKE` follows the column collation, case-insensitive by default), and
 *  `instr()` in SQLite (whose `LIKE` always ignores ASCII case). */
export function contains(
  d: SqlDialect,
  expr: string,
  value: string,
  opts: { caseInsensitive: boolean; negate: boolean },
): string {
  const { caseInsensitive, negate } = opts;
  if (d === "sqlite") {
    if (!caseInsensitive) return `instr(${expr}, ${stringLiteral(d, value)}) ${negate ? "=" : ">"} 0`;
    const pattern = stringLiteral(d, `%${escapeLike(value)}%`);
    return `${expr} ${negate ? "NOT LIKE" : "LIKE"} ${pattern} ESCAPE '\\'`;
  }
  const pattern = stringLiteral(d, `%${escapeLike(value)}%`);
  if (caseInsensitive) return ilike(d, expr, pattern, negate);
  const verb = negate ? "NOT LIKE" : "LIKE";
  return d === "mysql" ? `${expr} ${verb} BINARY ${pattern}` : `${expr} ${verb} ${pattern}`;
}
