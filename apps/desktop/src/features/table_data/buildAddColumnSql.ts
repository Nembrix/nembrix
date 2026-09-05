// Extracted from AddColumnDialog so that file exports only its component — a
// component module with extra exports breaks React Fast Refresh
// (react-refresh/only-export-components).

export function buildAddColumnSql(
  schema: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  dflt: string,
): string {
  let sql = `ALTER TABLE ${qi(schema)}.${qi(table)} ADD COLUMN ${qi(name)} ${type}`;
  if (dflt.trim()) sql += ` DEFAULT ${dflt.trim()}`;
  if (!nullable) sql += " NOT NULL";
  return sql + ";";
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
