/** SQL dialect helpers: the few places Postgres and MySQL/MariaDB differ in
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
 *  collations, but not under `_bin`/`_cs` ones). */
export function ilike(d: SqlDialect, expr: string, pattern: string, negate: boolean): string {
  if (d === "postgres") return `${expr} ${negate ? "NOT ILIKE" : "ILIKE"} ${pattern}`;
  return `LOWER(${expr}) ${negate ? "NOT LIKE" : "LIKE"} LOWER(${pattern})`;
}

/** Case-sensitive `LIKE`: MySQL's `LIKE` follows the column collation, which
 *  is case-insensitive by default; `LIKE BINARY` compares bytes. */
export function like(d: SqlDialect, expr: string, pattern: string, negate: boolean): string {
  const verb = negate ? "NOT LIKE" : "LIKE";
  return d === "mysql" ? `${expr} ${verb} BINARY ${pattern}` : `${expr} ${verb} ${pattern}`;
}
