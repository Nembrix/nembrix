import type { FilterChip, Tab } from "@/store";
import type { CellValue } from "@/ipc/types";

/** Build `db.<collection>.find(<filter>).sort(...).limit(N)` for the table-data
 *  view on a MongoDB connection. The SQL path (SELECT …) stays in TableDataTab;
 *  this exists because the Mongo driver rejects SQL with "expected
 *  db.<collection>.<method>(…)" — the query MUST match the engine's dialect.
 *
 *  `rel.table` is the collection name (rel.schema is the db, not part of the
 *  command). Pure + exported so it's unit-testable. */
export function buildMongoFind(
  rel: { schema: string; table: string },
  filters: FilterChip[],
  sort: Tab["sort"],
  limit: number,
): string {
  const query = mongoFilterDoc(filters);
  let cmd = `db.${rel.table}.find(${JSON.stringify(query)})`;
  if (sort) {
    cmd += `.sort(${JSON.stringify({ [sort.column]: sort.dir === "desc" ? -1 : 1 })})`;
  }
  cmd += `.limit(${limit})`;
  return cmd;
}

/** Translate the grid's filter chips into a Mongo query document. Mirrors the
 *  operators the SQL WHERE builder supports; disabled chips and unknown
 *  operators are skipped so the command stays valid. */
export function mongoFilterDoc(filters: FilterChip[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const f of filters) {
    if (f.enabled === false) continue; // staged-but-off chips don't filter
    const col = f.column;
    const raw = f.value ?? "";
    const val = coerce(raw);
    const regex = (opts: string) => ({ $regex: escapeRegex(raw), $options: opts });
    switch (f.op) {
      case "=":  doc[col] = val; break;
      case "!=": doc[col] = { $ne: val }; break;
      case ">":  doc[col] = { $gt: val }; break;
      case ">=": doc[col] = { $gte: val }; break;
      case "<":  doc[col] = { $lt: val }; break;
      case "<=": doc[col] = { $lte: val }; break;
      case "IS NULL":     doc[col] = null; break;
      case "IS NOT NULL": doc[col] = { $ne: null }; break;
      case "LIKE":
      case "CONTAINS":      doc[col] = regex(""); break;
      case "ILIKE":
      case "ICONTAINS":     doc[col] = regex("i"); break;
      case "NOT CONTAINS":  doc[col] = { $not: regex("") }; break;
      case "NOT ICONTAINS": doc[col] = { $not: regex("i") }; break;
      default: break; // unknown → skip
    }
  }
  return doc;
}

/** Best-effort scalar coercion so numeric/boolean equality filters compare
 *  correctly in Mongo (the chip value is a string). Non-numeric stays a string. */
function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Escape a user string so it's a literal substring inside a $regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ───────────────────────── Mongo writes / count ─────────────────────────
//
// The table-data grid's write path (cell edits, +Row inserts, row deletes)
// and the row-count query were all built as Postgres SQL. On a Mongo
// connection those strings are sent to the Mongo driver, which rejects them
// with "expected db.<collection>.<method>(…)". These builders emit the
// equivalent mongo-shell command the driver's parser accepts. They're pure +
// exported so they're unit-testable exactly like buildMongoFind.
//
// The primary key of every Mongo collection is `_id` (see db-mongo's
// introspect.rs). The `_id` value arrives in the grid as a CellValue: an
// ObjectId comes back as a 24-hex `text` cell (value.rs renders it via
// `oid.to_hex()`), a string `_id` as `text`, an int `_id` as `int`. To match
// an ObjectId in a filter we must emit extended JSON `{"$oid":"…"}` — the
// driver's parser folds that back into a typed ObjectId (parse.rs relies on
// bson's `Bson::try_from`). A 24-hex text `_id` is therefore treated as an
// ObjectId; anything else matches by its literal scalar form.

/** True for a 24-char lowercase/uppercase hex string — the shape Mongo
 *  renders an ObjectId as in the grid. Used to decide whether an `_id`
 *  text cell should match as an ObjectId (extended JSON) or a plain string. */
function isObjectIdHex(s: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(s);
}

/** Turn an `_id` CellValue into the JSON-serializable value that, once
 *  JSON.stringify'd inside a filter document, the Mongo driver parses back
 *  into the matching BSON. ObjectId hex → `{ $oid: "…" }`; scalars pass
 *  through as-is. */
export function mongoIdMatchValue(id: CellValue): unknown {
  switch (id.kind) {
    case "int":
    case "float":
      return id.value;
    case "bool":
      return id.value;
    case "text":
    case "raw":
      return isObjectIdHex(id.value) ? { $oid: id.value } : id.value;
    case "document":
      return id.value;
    case "null":
      return null;
    case "bytes":
      // No shell form for a binary _id; fall back to the hex string so the
      // command stays valid (it won't match, but it won't error either).
      return id.value.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/** `{ "_id": <matchValue> }` filter document for a single row. */
export function mongoIdFilter(id: CellValue): Record<string, unknown> {
  return { _id: mongoIdMatchValue(id) };
}

/** Coerce a user-typed cell string into the JSON value written into a Mongo
 *  document (for $set on edit, or a field on insert). Mirrors the scalar
 *  coercion the filter builder uses so "true"/numbers become typed values;
 *  the "__NULL__" sentinel becomes JSON null. */
export function mongoCellValue(input: string): unknown {
  if (input === "__NULL__") return null;
  return coerce(input);
}

/** `db.<coll>.updateOne({ _id: <id> }, { $set: { <col>: <val> } })` for one
 *  edited cell. `newValue` is the user-typed string (or "__NULL__"). */
export function buildMongoUpdate(opts: {
  collection: string;
  id: CellValue;
  column: string;
  newValue: string;
}): string {
  const filter = mongoIdFilter(opts.id);
  const update = { $set: { [opts.column]: mongoCellValue(opts.newValue) } };
  return `db.${opts.collection}.updateOne(${JSON.stringify(filter)}, ${JSON.stringify(update)})`;
}

/** `db.<coll>.insertOne({ <field>: <val>, … })` for one draft row. `_id` is
 *  omitted so Mongo generates it. Empty draft → `insertOne({})`. */
export function buildMongoInsert(opts: {
  collection: string;
  fields: { column: string; value: string }[];
}): string {
  const doc: Record<string, unknown> = {};
  for (const f of opts.fields) {
    if (f.column === "_id") continue; // let Mongo assign it
    doc[f.column] = mongoCellValue(f.value);
  }
  return `db.${opts.collection}.insertOne(${JSON.stringify(doc)})`;
}

/** `db.<coll>.deleteOne({ _id: <id> })` for one row. */
export function buildMongoDelete(opts: { collection: string; id: CellValue }): string {
  return `db.${opts.collection}.deleteOne(${JSON.stringify(mongoIdFilter(opts.id))})`;
}

/** `db.<coll>.countDocuments(<filterDoc>)` — the Mongo equivalent of the
 *  SQL row-count. Reuses the filter-chip → query-doc translation so the
 *  count matches the visible rows. */
export function buildMongoCount(
  rel: { schema: string; table: string },
  filters: FilterChip[],
): string {
  return `db.${rel.table}.countDocuments(${JSON.stringify(mongoFilterDoc(filters))})`;
}
