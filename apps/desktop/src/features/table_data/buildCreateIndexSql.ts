// Extracted from AddIndexDialog so that file exports only its component — a
// component module with extra exports breaks React Fast Refresh
// (react-refresh/only-export-components).

export function buildCreateIndexSql(
  schema: string,
  table: string,
  columns: string[],
  unique: boolean,
): string {
  const name = `${table}_${columns.join("_")}_idx`;
  const cols = columns.map(qi).join(", ");
  const kind = unique ? "UNIQUE INDEX" : "INDEX";
  return `CREATE ${kind} ${qi(name)} ON ${qi(schema)}.${qi(table)} (${cols});`;
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
