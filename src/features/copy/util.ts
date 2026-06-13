import type { CellValue, ColumnNode, RelationNode } from "@/ipc/types";

/**
 * Convert a CellValue (the typed wire format the streamer emits) into the
 * `string | null` shape `composeInsertBatch` expects. Bytes go to a Postgres
 * `\x…` hex literal; documents JSON-serialize.
 */
export function cellToInsertValue(c: CellValue): string | null {
  switch (c.kind) {
    case "null":      return null;
    case "bool":      return c.value ? "true" : "false";
    case "int":       return String(c.value);
    case "float":     return String(c.value);
    case "text":      return c.value;
    case "raw":       return c.value;
    case "document":  return JSON.stringify(c.value);
    case "bytes": {
      let hex = "";
      for (const b of c.value) hex += b.toString(16).padStart(2, "0");
      // Postgres bytea hex literal — the insert composer will quote it.
      return `\\x${hex}`;
    }
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function columnDdl(col: ColumnNode): string {
  let s = `${quoteIdent(col.name)} ${col.type_name}`;
  if (!col.nullable) s += " NOT NULL";
  if (col.default) s += ` DEFAULT ${col.default}`;
  return s;
}

/**
 * Emit a CREATE TABLE statement for a relation. Foreign keys and indexes
 * are intentionally NOT included here — the copy flow re-creates those in
 * a second pass after all tables exist, so the order doesn't matter.
 */
export function emitCreateTable(
  qualifiedTarget: string,
  rel: RelationNode,
  opts: { ifNotExists?: boolean } = {},
): string {
  const cols = rel.columns.map(columnDdl);
  if (rel.primary_key.length > 0) {
    cols.push(`PRIMARY KEY (${rel.primary_key.map(quoteIdent).join(", ")})`);
  }
  const head = opts.ifNotExists ? "CREATE TABLE IF NOT EXISTS" : "CREATE TABLE";
  return `${head} ${qualifiedTarget} (\n  ${cols.join(",\n  ")}\n);`;
}

export function emitCreateSchema(name: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(name)};`;
}

/**
 * Emit ALTER TABLE statements to add the relation's foreign keys after
 * all referenced tables exist. Returns one statement per FK so a failure
 * is isolated.
 */
export function emitForeignKeys(
  qualifiedTarget: string,
  rel: RelationNode,
  targetSchemaRename?: (srcSchema: string) => string,
): string[] {
  return rel.foreign_keys.map((fk) => {
    const refSchema = targetSchemaRename ? targetSchemaRename(fk.referenced_schema) : fk.referenced_schema;
    const refTable  = `${quoteIdent(refSchema)}.${quoteIdent(fk.referenced_table)}`;
    return (
      `ALTER TABLE ${qualifiedTarget} ` +
      `ADD CONSTRAINT ${quoteIdent(fk.name)} ` +
      `FOREIGN KEY (${fk.columns.map(quoteIdent).join(", ")}) ` +
      `REFERENCES ${refTable} (${fk.referenced_columns.map(quoteIdent).join(", ")});`
    );
  });
}

/**
 * Emit CREATE INDEX statements for the relation, skipping the index that
 * backs the PRIMARY KEY (Postgres creates that automatically) and any
 * uniqueness index that the CREATE TABLE statement's PRIMARY KEY clause
 * already covers.
 *
 * If `rewriteSchema` is provided we string-replace the source schema name
 * inside `pg_get_indexdef()` output — the definition is fully-qualified
 * and would otherwise target the source schema.
 */
export function emitIndexes(
  rel: RelationNode,
  srcSchema: string,
  tgtSchema: string,
): string[] {
  const out: string[] = [];
  for (const idx of rel.indexes) {
    if (idx.is_primary) continue;
    // pg_get_indexdef returns absolute identifiers like:
    //   CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)
    // We rewrite the schema-qualified table reference if the target schema
    // differs. The simple regex below assumes the schema name is a bare
    // identifier — good enough for typical Postgres schemas.
    let def = idx.definition;
    if (srcSchema !== tgtSchema) {
      const escaped = srcSchema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      def = def.replace(
        new RegExp(`\\b${escaped}\\.`, "g"),
        `${tgtSchema}.`,
      );
    }
    // Make CREATE INDEX idempotent so re-runs against an existing target
    // don't fail. Postgres supports IF NOT EXISTS for both plain and unique.
    def = def.replace(
      /^CREATE (UNIQUE )?INDEX /,
      (_, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `,
    );
    out.push(def.endsWith(";") ? def : def + ";");
  }
  return out;
}

/**
 * For columns whose default is a `nextval('seq'::regclass)` (serial/identity),
 * emit a `SELECT setval(...)` that bumps the sequence to MAX(col) on the
 * target table. Without this, the next INSERT on the target would reuse an
 * id that's already in the copied data.
 *
 * The setval runs against the TARGET connection's data because we just
 * finished copying. We extract the sequence name from the default expr.
 */
export function emitSequenceResets(
  qualifiedTarget: string,
  rel: RelationNode,
): string[] {
  const out: string[] = [];
  for (const col of rel.columns) {
    if (!col.default) continue;
    // nextval('schema.seq_name'::regclass) or nextval('seq_name'::regclass)
    const m = col.default.match(/nextval\('([^']+)'::regclass\)/i);
    if (!m) continue;
    const seq = m[1]; // may include schema prefix
    const colQ = quoteIdent(col.name);
    // COALESCE so an empty table doesn't blow up (MAX returns NULL).
    out.push(
      `SELECT setval('${seq.replace(/'/g, "''")}', ` +
      `COALESCE((SELECT MAX(${colQ}) FROM ${qualifiedTarget}), 1), ` +
      `(SELECT MAX(${colQ}) FROM ${qualifiedTarget}) IS NOT NULL);`,
    );
  }
  return out;
}

/**
 * Topologically sort relations so referenced tables are created first.
 * Cycles (e.g. employee.manager_id) break ties — those FKs land in the
 * second-pass ALTER TABLE step anyway.
 */
export function topoSortByFks(rels: RelationNode[]): RelationNode[] {
  const byName = new Map(rels.map((r) => [r.name, r]));
  const visited = new Set<string>();
  const out: RelationNode[] = [];
  const visit = (r: RelationNode, stack: Set<string>) => {
    if (visited.has(r.name)) return;
    if (stack.has(r.name)) return; // cycle — bail
    stack.add(r.name);
    for (const fk of r.foreign_keys) {
      const dep = byName.get(fk.referenced_table);
      if (dep) visit(dep, stack);
    }
    stack.delete(r.name);
    visited.add(r.name);
    out.push(r);
  };
  for (const r of rels) visit(r, new Set());
  return out;
}
