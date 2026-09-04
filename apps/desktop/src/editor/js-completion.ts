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
  return [javascript(), javascriptLanguage.data.of({ autocomplete: buildJsCompletionSource(tree) })];
}

/**
 * The completion source behind {@link buildJsScriptExtension}, exported so it
 * can be exercised directly against an `EditorState` in tests.
 */
export function buildJsCompletionSource(
  tree: SchemaTree | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
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
    { label: "console.log", type: "function", info: "console.log(...args) → Console tab", apply: "console.log(" },
    { label: "console.error", type: "function", info: "console.error(...args) → Console tab", apply: "console.error(" },
    { label: "console.warn", type: "function", info: "console.warn(...args) → Console tab", apply: "console.warn(" },
    { label: "await", type: "keyword" },
    { label: "const", type: "keyword" },
    { label: "let", type: "keyword" },
    // `for…of` over `forEach`: an `async` callback passed to forEach is not
    // awaited, so every `await db.query` inside it escapes the loop and the
    // script finishes before the queries do. The snippet steers past that.
    {
      label: "for",
      type: "keyword",
      info: "for (const row of rows) { … } — use this, not forEach, to await per row",
      apply: "for (const row of rows) {\n  \n}",
    },
    {
      label: "forEach",
      type: "method",
      info: "rows.forEach(cb) — does NOT await an async callback; prefer for…of",
      apply: "forEach((row) => )",
    },
    { label: "if", type: "keyword" },
    { label: "try", type: "keyword", info: "try { … } catch (e) { console.error(e.message) }" },
    { label: "return", type: "keyword" },
    // Dates: the paren-less `Date.now()` is the one people actually want for a
    // millisecond stamp; `new Date()` is offered for the object form.
    { label: "Date.now", type: "function", info: "Date.now() → epoch milliseconds", apply: "Date.now()" },
    { label: "new Date", type: "class", info: "new Date() → Date object", apply: "new Date()" },
    { label: "toISOString", type: "method", info: "date.toISOString() → \"2026-09-02T…Z\"", apply: "toISOString()" },
    { label: "getTime", type: "method", info: "date.getTime() → epoch milliseconds", apply: "getTime()" },
    { label: "JSON.stringify", type: "function", info: "JSON.stringify(value, null, 2)", apply: "JSON.stringify(" },
    { label: "Promise.all", type: "function", info: "await Promise.all(rows.map(async (r) => …))", apply: "Promise.all(" },
  ];

  // Methods offered only after a `.` — completing a query result or an array.
  // `db.query` resolves to the rows array itself, with `.columns`/`.rowCount`
  // /`.rows` hung off it, so both shapes belong here.
  const MEMBERS: Completion[] = [
    { label: "rows", type: "property", info: "The row array (self-reference on a db.query result)" },
    { label: "columns", type: "property", info: "string[] — column names" },
    { label: "rowCount", type: "property", info: "number — how many rows came back" },
    { label: "length", type: "property", info: "number — array length" },
    { label: "map", type: "method", apply: "map((row) => )", info: "rows.map(cb) → any[]" },
    { label: "filter", type: "method", apply: "filter((row) => )", info: "rows.filter(cb) → any[]" },
    { label: "forEach", type: "method", apply: "forEach((row) => )", info: "Does NOT await an async callback; prefer for…of" },
    { label: "find", type: "method", apply: "find((row) => )", info: "rows.find(cb) → row | undefined" },
    { label: "slice", type: "method", apply: "slice(", info: "rows.slice(start, end?)" },
    { label: "entries", type: "method", apply: "entries()", info: "for (const [i, row] of rows.entries())" },
    { label: "message", type: "property", info: "error.message — the driver's own words" },
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

    // Member context: right after a `.`, offer result/array/error members
    // rather than the top-level API, so `rows.` doesn't suggest `const`.
    // `db.` and `console.` are excluded — those are namespaces whose members
    // live in API as dotted labels (`db.query`, `console.log`), and stealing
    // them here would hide the one call the sandbox actually exposes.
    const member = ctx.matchBefore(/(\w*)\.\w*/);
    if (member) {
      const receiver = member.text.slice(0, member.text.indexOf("."));
      if (receiver !== "db" && receiver !== "console" && receiver !== "JSON" && receiver !== "Promise") {
        return {
          // Keep the receiver and dot; replace only the partial word after it.
          from: member.from + member.text.indexOf(".") + 1,
          options: MEMBERS,
          validFor: /^\w*$/,
        };
      }
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

  return source;
}
