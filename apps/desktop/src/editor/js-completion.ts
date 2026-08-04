import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaTree } from "@/ipc/types";

/**
 * Completion for JavaScript scripting mode. Two layers:
 *
 *  1. The scripting API + common JS — `db`, `db.query(…)`, `console.log(…)`,
 *     `await`, and the loop/branch keywords, so a user discovers the surface
 *     without reading the docs.
 *  2. Schema-aware SQL INSIDE a string literal — when the cursor sits in a
 *     `"…"`/`'…'`/`` `…` `` string (the argument of `db.query`), we offer the
 *     same table/column names the SQL editor does, so `db.query("SELECT * FROM |")`
 *     completes tables just like plain SQL.
 *
 * Returned as a JS language extension so it composes with the syntax
 * highlighting already in place.
 */
export function buildJsScriptExtension(tree: SchemaTree | undefined): Extension {
  // Flatten the schema into table names + column names once.
  const tables: Completion[] = [];
  const columns: Completion[] = [];
  const seenCol = new Set<string>();
  if (tree) {
    for (const db of tree.databases) {
      for (const sc of db.schemas) {
        const rels = [...sc.tables, ...sc.views];
        for (const t of rels) {
          tables.push({ label: t.name, type: "type" });
          if (sc.name !== "public") tables.push({ label: `${sc.name}.${t.name}`, type: "type" });
          for (const c of t.columns) {
            if (seenCol.has(c.name)) continue;
            seenCol.add(c.name);
            columns.push({
              label: c.name,
              type: "property",
              info: `${c.type_name}${c.nullable ? "" : " NOT NULL"}`,
            });
          }
        }
      }
    }
  }

  // A small SQL keyword set — enough to feel like the SQL editor inside a query string.
  const SQL_KEYWORDS = [
    "SELECT", "FROM", "WHERE", "INSERT INTO", "UPDATE", "DELETE FROM", "VALUES",
    "SET", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "GROUP BY", "ORDER BY",
    "LIMIT", "OFFSET", "RETURNING", "AND", "OR", "NOT", "NULL", "AS",
  ].map((label) => ({ label, type: "keyword" }) satisfies Completion);

  // The scripting API + common JS control flow.
  const API: Completion[] = [
    { label: "db.query", type: "function", info: "await db.query(sql, params?) → rows[]", apply: "db.query(" },
    { label: "db", type: "namespace", info: "The database handle — only db.query is exposed." },
    { label: "console.log", type: "function", info: "console.log(...args) → Message tab", apply: "console.log(" },
    { label: "await", type: "keyword" },
    { label: "const", type: "keyword" },
    { label: "let", type: "keyword" },
    { label: "for", type: "keyword", info: "for (const row of rows) { … }" },
    { label: "if", type: "keyword" },
    { label: "return", type: "keyword" },
  ];

  const source = (ctx: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    // Are we inside a string literal? lang-javascript names these "String"
    // and "TemplateString".
    const inString = node.type.name === "String" || node.type.name === "TemplateString";

    if (inString) {
      // SQL context: complete keywords + tables + columns. Match the current
      // word (letters, digits, underscore, dot for schema-qualified names).
      const word = ctx.matchBefore(/[\w.]*/);
      if (!word) return null;
      if (word.from === word.to && !ctx.explicit) return null;
      return {
        from: word.from,
        options: [...SQL_KEYWORDS, ...tables, ...columns],
        validFor: /^[\w.]*$/,
      };
    }

    // JS/API context.
    const word = ctx.matchBefore(/[\w.]*/);
    if (!word) return null;
    if (word.from === word.to && !ctx.explicit) return null;
    return {
      from: word.from,
      options: API,
      validFor: /^[\w.]*$/,
    };
  };

  return [
    javascript(),
    javascriptLanguage.data.of({ autocomplete: source }),
  ];
}
