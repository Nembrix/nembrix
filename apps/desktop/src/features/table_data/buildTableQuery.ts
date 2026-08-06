import type { FilterChip, Tab } from "@/store";

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
