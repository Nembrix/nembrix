import type { FilterChip, Tab } from "@/store";
import type { CellValue } from "@/ipc/types";
import {
  ilike, like, qualify, quoteIdent, stringLiteral, type SqlDialect,
} from "@/lib/sql-dialect";

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

/** Quote a Redis argument for the editor's `redis-cli` syntax (see the
 *  db-redis tokenizer): plain when it has no whitespace or quote characters,
 *  otherwise double-quoted with `\` and `"` escaped and control characters as
 *  `\n`/`\r`/`\t`. */
export function quoteRedisArg(arg: string): string {
  if (arg !== "" && !/[\s"'\\]/.test(arg)) return arg;
  const body = arg
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${body}"`;
}

/** The Redis type of an introspected key. The driver stamps every column's
 *  `type_name` with it (see db-redis introspect). */
export function redisKeyType(rel: { columns: { type_name: string }[] } | undefined): string | undefined {
  return rel?.columns[0]?.type_name;
}

/** The read command that browses one key in the table-data view, bounded by
 *  the grid's row limit. `*SCAN`'s COUNT is a hint, so hashes/sets may return
 *  somewhat more or fewer — but never the whole of a huge key. */
export function buildRedisBrowse(key: string, type: string | undefined, limit: number): string {
  const k = quoteRedisArg(key);
  const last = Math.max(limit, 1) - 1;
  switch (type) {
    case "string": return `GET ${k}`;
    case "hash":   return `HSCAN ${k} 0 COUNT ${limit}`;
    case "list":   return `LRANGE ${k} 0 ${last}`;
    case "set":    return `SSCAN ${k} 0 COUNT ${limit}`;
    case "zset":   return `ZRANGE ${k} 0 ${last} WITHSCORES`;
    case "stream": return `XRANGE ${k} - + COUNT ${limit}`;
    // Module types (ReJSON-RL, TSDB-TYPE, …) have no generic reader.
    default:       return `TYPE ${k}`;
  }
}

/** Command returning the size of a key, for the grid's row total; null when
 *  the type has no cardinality command. */
export function buildRedisCount(key: string, type: string | undefined): string | null {
  const k = quoteRedisArg(key);
  switch (type) {
    case "hash":   return `HLEN ${k}`;
    case "list":   return `LLEN ${k}`;
    case "set":    return `SCARD ${k}`;
    case "zset":   return `ZCARD ${k}`;
    case "stream": return `XLEN ${k}`;
    default:       return null;
  }
}

/** A filter value as a SQL literal: bare when numeric, else quoted for the
 *  dialect. Empty for the null-check operators, which take no operand. */
function quoteValue(v: string | null, op: FilterChip["op"], d: SqlDialect): string {
  if (op === "IS NULL" || op === "IS NOT NULL") return "";
  if (v == null) return "";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return stringLiteral(d, v);
}

/** Escape % and _ in a substring so the user's value can't accidentally
 *  match more than intended in a LIKE/ILIKE pattern. Backslash is the LIKE
 *  escape character in both Postgres and MySQL; `stringLiteral` then makes
 *  sure the backslashes survive MySQL's own literal escaping. */
function escapeLike(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Compile one chip to a SQL predicate. Some user-facing operators don't
 *  map 1:1 to SQL — CONTAINS becomes LIKE '%value%', NOT CONTAINS becomes
 *  NOT LIKE, ICONTAINS a case-insensitive match (see `like` / `ilike`). */
function compileChip(f: FilterChip, d: SqlDialect): string {
  const col = quoteIdent(d, f.column);
  switch (f.op) {
    case "IS NULL":      return `${col} IS NULL`;
    case "IS NOT NULL":  return `${col} IS NOT NULL`;
    case "CONTAINS":
    case "NOT CONTAINS":
    case "ICONTAINS":
    case "NOT ICONTAINS": {
      const pattern = stringLiteral(d, `%${escapeLike(f.value ?? "")}%`);
      const negate = f.op.startsWith("NOT");
      return f.op.endsWith("ICONTAINS")
        ? ilike(d, col, pattern, negate)
        : like(d, col, pattern, negate);
    }
    default: {
      const lit = quoteValue(f.value, f.op, d);
      return lit ? `${col} ${f.op} ${lit}` : `${col} ${f.op}`;
    }
  }
}

/** The WHERE clause for the filter chips (including the leading `WHERE`);
 *  empty when no chip is active. Shared with the exact row count so the
 *  count matches the grid. */
export function buildWhereClause(filters: FilterChip[], d: SqlDialect = "postgres"): string {
  // Skip chips the user has toggled off in the builder. `enabled` is
  // undefined for legacy persisted chips → treat as enabled.
  const active = filters.filter((f) => f.enabled !== false);
  if (!active.length) return "";
  return `WHERE ${active.map((f) => compileChip(f, d)).join(" AND ")}`;
}

/** `SELECT * FROM schema.table [WHERE …] [ORDER BY …] LIMIT n;` for the
 *  table-data view on a SQL connection. */
export function buildSql(
  rel: { schema: string; table: string } | undefined,
  filters: FilterChip[],
  sort: Tab["sort"],
  limit: number,
  d: SqlDialect = "postgres",
): string {
  if (!rel) return "";
  let sql = `SELECT * FROM ${qualify(d, rel.schema, rel.table)}`;
  const where = buildWhereClause(filters, d);
  if (where) sql += ` ${where}`;
  if (sort) sql += ` ORDER BY ${quoteIdent(d, sort.column)} ${sort.dir.toUpperCase()}`;
  sql += ` LIMIT ${limit}`;
  return sql + ";";
}
