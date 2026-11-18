import { sql, MySQL, PostgreSQL, SQLite, SQLConfig } from "@codemirror/lang-sql";
import type { SqlDialect } from "@/lib/sql-dialect";
import type { Extension } from "@codemirror/state";
import type { SchemaTree } from "@/ipc/types";

/**
 * Build a Postgres-dialect CodeMirror extension whose autocomplete pulls
 * table/column names from the cached SchemaTree. Alias-aware: after
 * `FROM foo AS f`, typing `f.` offers foo's columns.
 *
 * SQLConfig.schema is `{ table: ["col1", "col2"], ... }`. We flatten the
 * schema tree into this shape; CodeMirror handles `.`-completion itself.
 *
 * The completion items are tagged with distinct `type` values so the
 * popover can render icon glyphs (via cm-completionIcon-<type> CSS) for
 * tables, views, functions, and columns — no text "type" labels.
 *
 * For each table we ALSO register a richer completion entry whose
 * `info` callback returns the column list, so hovering / "More info"
 * in the popover shows what's inside the table without leaving the
 * editor.
 */
export function buildSqlExtension(
  tree: SchemaTree | undefined,
  d: SqlDialect = "postgres",
): Extension {
  // Unqualified names resolve against Postgres' `public`, SQLite's `main`,
  // or — in MySQL, where a database is the schema — the connection's own
  // database, which the driver lists first.
  const home = d === "mysql" ? tree?.databases[0]?.schemas[0]?.name : d === "sqlite" ? "main" : "public";
  type SchemaItem = string | { label: string; type: string; info?: string };
  const schema: Record<string, SchemaItem[]> = {};
  const tableTypeByName = new Map<string, "table" | "view" | "type">();
  const defaultTable: string[] = [];

  if (tree) {
    for (const db of tree.databases) {
      for (const sc of db.schemas) {
        for (const t of sc.tables) {
          const cols = t.columns.map((c) => ({
            label: c.name,
            type: "property",
            info: `${c.type_name}${c.nullable ? "" : " NOT NULL"}`,
          } satisfies SchemaItem));
          schema[t.name] = cols;
          schema[`${sc.name}.${t.name}`] = cols;
          tableTypeByName.set(t.name, "table");
          if (sc.name === home) defaultTable.push(t.name);
        }
        for (const v of sc.views) {
          const cols = v.columns.map((c) => ({
            label: c.name,
            type: "property",
            info: `${c.type_name}${c.nullable ? "" : " NOT NULL"}`,
          } satisfies SchemaItem));
          schema[v.name] = cols;
          schema[`${sc.name}.${v.name}`] = cols;
          tableTypeByName.set(v.name, "view");
          if (sc.name === home) defaultTable.push(v.name);
        }
      }
    }
  }

  // Build the table-list completion entries. We register BOTH bare
  // names ("users") and schema-qualified names ("public.users") so the
  // popover suggests qualified forms when the user types
  // "schemaname.". The `type: "type"` tag drives the table icon in
  // the popover styling (cm-completionIcon-type → "▦").
  const tableEntries = tree
    ? Object.keys(schema)
        .filter((k) => !k.includes("."))
        .map((label) => ({
          label,
          type: tableTypeByName.get(label) === "view" ? "type" : "type",
        }))
    : undefined;

  return sql({
    dialect: { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite }[d],
    upperCaseKeywords: true,
    schema: schema as SQLConfig["schema"],
    defaultTable: defaultTable[0],
    defaultSchema: home,
    tables: tableEntries,
  } as SQLConfig);
}
