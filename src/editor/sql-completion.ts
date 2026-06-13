import { sql, PostgreSQL, SQLConfig } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import type { SchemaTree } from "@/ipc/types";

/**
 * Build a Postgres-dialect CodeMirror extension whose autocomplete pulls
 * table/column names from the cached SchemaTree. Alias-aware: after
 * `FROM foo AS f`, typing `f.` offers foo's columns.
 *
 * SQLConfig.schema is `{ table: ["col1", "col2"], ... }`. We flatten the
 * schema tree into this shape; CodeMirror handles `.`-completion itself.
 */
export function buildSqlExtension(tree: SchemaTree | undefined): Extension {
  const schema: SQLConfig["schema"] = {};
  const defaultTable: string[] = [];
  const defaultSchema: string[] = [];

  if (tree) {
    for (const db of tree.databases) {
      for (const sc of db.schemas) {
        defaultSchema.push(sc.name);
        for (const t of [...sc.tables, ...sc.views]) {
          const cols = t.columns.map((c) => c.name);
          schema[t.name] = cols;
          schema[`${sc.name}.${t.name}`] = cols;
          if (sc.name === "public") defaultTable.push(t.name);
        }
      }
    }
  }

  return sql({
    dialect: PostgreSQL,
    upperCaseKeywords: true,
    schema,
    defaultTable: defaultTable.length ? defaultTable[0] : undefined,
    defaultSchema: "public",
  });
}
