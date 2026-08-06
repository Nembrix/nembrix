import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import type { Extension } from "@codemirror/state";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaTree } from "@/ipc/types";

/**
 * CodeMirror autocomplete for the MongoDB Query editor (non-script mode).
 *
 * Mongo's query language is a JS-like shell command — `db.<collection>.<method>(…)`
 * or a `db.<helper>(…)` — so we build on the JavaScript language (for bracket
 * matching / string handling) and layer a Mongo-aware completion source:
 *
 *   - `db` and each **collection** name from the introspected schema
 *   - after `db.<coll>.`, the **collection methods** (find, aggregate, …)
 *   - after `db.`, the top-level **helpers** (getCollectionNames, runCommand)
 *
 * It offers NO SQL keywords — that's the whole point (a Mongo tab must not
 * suggest SELECT/FROM, just as a Postgres tab must not suggest find/aggregate).
 */

/** Read-methods return rows/documents; write-methods mutate. */
const COLLECTION_METHODS: Completion[] = [
  { label: "find",                 type: "method", info: "find(filter?, projection?)", apply: "find(" },
  { label: "findOne",              type: "method", info: "findOne(filter?)", apply: "findOne(" },
  { label: "aggregate",            type: "method", info: "aggregate([ …stages ])", apply: "aggregate([" },
  { label: "countDocuments",       type: "method", info: "countDocuments(filter?)", apply: "countDocuments(" },
  { label: "estimatedDocumentCount", type: "method", info: "estimatedDocumentCount()", apply: "estimatedDocumentCount(" },
  { label: "distinct",             type: "method", info: "distinct(field, filter?)", apply: "distinct(" },
  { label: "insertOne",            type: "method", info: "insertOne(doc)", apply: "insertOne(" },
  { label: "insertMany",           type: "method", info: "insertMany([ …docs ])", apply: "insertMany([" },
  { label: "updateOne",            type: "method", info: "updateOne(filter, update)", apply: "updateOne(" },
  { label: "updateMany",           type: "method", info: "updateMany(filter, update)", apply: "updateMany(" },
  { label: "replaceOne",           type: "method", info: "replaceOne(filter, doc)", apply: "replaceOne(" },
  { label: "deleteOne",            type: "method", info: "deleteOne(filter)", apply: "deleteOne(" },
  { label: "deleteMany",           type: "method", info: "deleteMany(filter)", apply: "deleteMany(" },
];

/** Top-level `db.` helpers (not collection methods). */
const DB_HELPERS: Completion[] = [
  { label: "getCollectionNames", type: "function", info: "db.getCollectionNames()", apply: "getCollectionNames(" },
  { label: "runCommand",         type: "function", info: "db.runCommand({ … })", apply: "runCommand(" },
];

export function buildMongoExtension(tree: SchemaTree | undefined): Extension {
  // Collection names come through the schema tree as "tables".
  const collections: Completion[] = [];
  const seen = new Set<string>();
  if (tree) {
    for (const db of tree.databases) {
      for (const sc of db.schemas) {
        for (const t of [...sc.tables, ...sc.views]) {
          if (seen.has(t.name)) continue;
          seen.add(t.name);
          collections.push({ label: t.name, type: "class", info: "collection" });
        }
      }
    }
  }

  const source = (ctx: CompletionContext): CompletionResult | null => {
    // `db.<coll>.<method>` — offer collection methods.
    const method = ctx.matchBefore(/db\.[A-Za-z_$][\w$]*\.\w*/);
    if (method) {
      const from = method.text.lastIndexOf(".") + method.from + 1;
      return { from, options: COLLECTION_METHODS, validFor: /^\w*$/ };
    }
    // `db.<something>` — offer collections + top-level helpers.
    const afterDb = ctx.matchBefore(/db\.\w*/);
    if (afterDb) {
      const from = afterDb.from + 3; // after "db."
      return { from, options: [...collections, ...DB_HELPERS], validFor: /^\w*$/ };
    }
    // Bare word at the start — offer `db`.
    const word = ctx.matchBefore(/\w*/);
    if (word && (word.from < word.to || ctx.explicit)) {
      return {
        from: word.from,
        options: [{ label: "db", type: "namespace", info: "The database handle" }],
        validFor: /^\w*$/,
      };
    }
    return null;
  };

  return [
    javascript(),
    javascriptLanguage.data.of({ autocomplete: source }),
  ];
}
