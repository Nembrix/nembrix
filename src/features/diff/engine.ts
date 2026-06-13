/**
 * Schema diff engine.
 *
 * Compares two `SchemaTree`s and produces a list of `DiffOp`s. Each op is a
 * structured representation of "something to do to make `left` look like
 * `right`" — the migration SQL generator turns these into ALTER/DDL.
 *
 * Design notes:
 *  - We compare by *name* at every level. Two columns named `email` are
 *    treated as the same column regardless of their order; a column rename
 *    looks like one DROP and one ADD here. That's intentional — renames
 *    need user confirmation and aren't safe to infer.
 *  - The engine is deliberately schema-pair scoped. The user picks
 *    `(connA, schemaA, connB, schemaB)`. If you want to diff whole DBs you
 *    iterate over the engine externally.
 *  - Indexes whose only difference is the auto-generated name (often the
 *    case with implicit PK indexes) are matched by their column-set + uniqueness
 *    instead of by name, so a `users_pkey` on each side doesn't show up as
 *    a spurious "different index" pair.
 */

import type { ColumnNode, IndexNode, RelationNode, SchemaNode } from "@/ipc/types";

export type DiffOpKind =
  | "table.add" | "table.drop"
  | "column.add" | "column.drop" | "column.changeType"
  | "column.setNotNull" | "column.dropNotNull"
  | "column.setDefault" | "column.dropDefault"
  | "index.add" | "index.drop"
  | "fk.add" | "fk.drop";

export interface DiffOp {
  kind: DiffOpKind;
  /** Schema + table — present on every op. */
  schema: string;
  table: string;
  /** Column name (column.*). */
  column?: string;
  /** Convenient short summary for the UI. */
  summary: string;
  /** Used by the renderer for grouping. */
  group: "tables" | "columns" | "indexes" | "fks";
  /** Strongly-typed payload for the SQL generator. */
  payload?: unknown;
}

export interface DiffResult {
  ops: DiffOp[];
  /** Per-table summaries — handy for the tree UI. */
  perTable: Map<string, { added: number; removed: number; changed: number }>;
}

/* ───────────────────────── public entry point ───────────────────────── */

export function diffSchemas(left: SchemaNode, right: SchemaNode): DiffResult {
  const ops: DiffOp[] = [];

  const leftTables = new Map(left.tables.map((t) => [t.name, t]));
  const rightTables = new Map(right.tables.map((t) => [t.name, t]));

  // 1) Tables added (in right, not in left) and removed.
  for (const [name, rt] of rightTables) {
    if (!leftTables.has(name)) {
      ops.push({
        kind: "table.add",
        schema: right.name,
        table: name,
        summary: `+ table ${right.name}.${name}`,
        group: "tables",
        payload: rt,
      });
    }
  }
  for (const [name] of leftTables) {
    if (!rightTables.has(name)) {
      ops.push({
        kind: "table.drop",
        schema: left.name,
        table: name,
        summary: `- table ${left.name}.${name}`,
        group: "tables",
      });
    }
  }

  // 2) For tables present in both, compare columns / indexes / FKs.
  for (const [name, lt] of leftTables) {
    const rt = rightTables.get(name);
    if (!rt) continue;
    diffTable(left.name, lt, rt, ops);
  }

  // 3) Per-table summary.
  const perTable = new Map<string, { added: number; removed: number; changed: number }>();
  for (const op of ops) {
    const key = `${op.schema}.${op.table}`;
    const sum = perTable.get(key) ?? { added: 0, removed: 0, changed: 0 };
    if (op.kind.endsWith(".add")) sum.added += 1;
    else if (op.kind.endsWith(".drop")) sum.removed += 1;
    else sum.changed += 1;
    perTable.set(key, sum);
  }
  return { ops, perTable };
}

function diffTable(schema: string, left: RelationNode, right: RelationNode, ops: DiffOp[]) {
  diffColumns(schema, left, right, ops);
  diffIndexes(schema, left, right, ops);
  diffFks(schema, left, right, ops);
}

/* ───────────────────────── columns ───────────────────────── */

function diffColumns(schema: string, left: RelationNode, right: RelationNode, ops: DiffOp[]) {
  const leftCols = new Map(left.columns.map((c) => [c.name, c]));
  const rightCols = new Map(right.columns.map((c) => [c.name, c]));

  for (const [name, rc] of rightCols) {
    if (!leftCols.has(name)) {
      ops.push({
        kind: "column.add",
        schema, table: left.name, column: name,
        summary: `+ column ${name} ${formatColumnDecl(rc)}`,
        group: "columns",
        payload: rc,
      });
    }
  }
  for (const [name] of leftCols) {
    if (!rightCols.has(name)) {
      ops.push({
        kind: "column.drop",
        schema, table: left.name, column: name,
        summary: `- column ${name}`,
        group: "columns",
      });
    }
  }
  for (const [name, lc] of leftCols) {
    const rc = rightCols.get(name);
    if (!rc) continue;
    if (lc.type_name !== rc.type_name) {
      ops.push({
        kind: "column.changeType",
        schema, table: left.name, column: name,
        summary: `~ ${name} type ${lc.type_name} → ${rc.type_name}`,
        group: "columns",
        payload: { from: lc.type_name, to: rc.type_name },
      });
    }
    if (lc.nullable !== rc.nullable) {
      ops.push({
        kind: rc.nullable ? "column.dropNotNull" : "column.setNotNull",
        schema, table: left.name, column: name,
        summary: rc.nullable
          ? `~ ${name} drop NOT NULL`
          : `~ ${name} set NOT NULL`,
        group: "columns",
      });
    }
    if ((lc.default ?? null) !== (rc.default ?? null)) {
      ops.push({
        kind: rc.default == null ? "column.dropDefault" : "column.setDefault",
        schema, table: left.name, column: name,
        summary: rc.default == null
          ? `~ ${name} drop default`
          : `~ ${name} default ← ${rc.default}`,
        group: "columns",
        payload: rc.default,
      });
    }
  }
}

/* ───────────────────────── indexes ───────────────────────── */

/** Stable key based on what an index actually does — columns + uniqueness +
 *  method — so two indexes with different auto-names still match if they're
 *  semantically equivalent. */
function indexFingerprint(ix: IndexNode): string {
  return `${ix.is_unique ? "u" : ""}${ix.is_primary ? "p" : ""}|${ix.method}|${ix.columns.join(",")}`;
}

function diffIndexes(schema: string, left: RelationNode, right: RelationNode, ops: DiffOp[]) {
  const leftByFp = new Map<string, IndexNode>();
  for (const ix of left.indexes) leftByFp.set(indexFingerprint(ix), ix);
  const rightByFp = new Map<string, IndexNode>();
  for (const ix of right.indexes) rightByFp.set(indexFingerprint(ix), ix);

  for (const [fp, rix] of rightByFp) {
    if (!leftByFp.has(fp)) {
      ops.push({
        kind: "index.add",
        schema, table: left.name,
        summary: `+ index ${rix.name} (${rix.columns.join(", ")})`,
        group: "indexes",
        payload: rix,
      });
    }
  }
  for (const [fp, lix] of leftByFp) {
    if (!rightByFp.has(fp)) {
      ops.push({
        kind: "index.drop",
        schema, table: left.name,
        summary: `- index ${lix.name}`,
        group: "indexes",
        payload: lix,
      });
    }
  }
}

/* ───────────────────────── foreign keys ───────────────────────── */

function fkFingerprint(fk: { columns: string[]; referenced_schema: string; referenced_table: string; referenced_columns: string[] }): string {
  return `${fk.columns.join(",")}→${fk.referenced_schema}.${fk.referenced_table}(${fk.referenced_columns.join(",")})`;
}

function diffFks(schema: string, left: RelationNode, right: RelationNode, ops: DiffOp[]) {
  const leftByFp = new Map(left.foreign_keys.map((fk) => [fkFingerprint(fk), fk]));
  const rightByFp = new Map(right.foreign_keys.map((fk) => [fkFingerprint(fk), fk]));

  for (const [fp, rfk] of rightByFp) {
    if (!leftByFp.has(fp)) {
      ops.push({
        kind: "fk.add",
        schema, table: left.name,
        summary: `+ FK ${rfk.columns.join(", ")} → ${rfk.referenced_schema}.${rfk.referenced_table}`,
        group: "fks",
        payload: rfk,
      });
    }
  }
  for (const [fp, lfk] of leftByFp) {
    if (!rightByFp.has(fp)) {
      ops.push({
        kind: "fk.drop",
        schema, table: left.name,
        summary: `- FK ${lfk.name}`,
        group: "fks",
        payload: lfk,
      });
    }
  }
}

/* ───────────────────────── helpers ───────────────────────── */

export function formatColumnDecl(c: ColumnNode): string {
  let s = c.type_name;
  if (!c.nullable) s += " NOT NULL";
  if (c.default != null) s += ` DEFAULT ${c.default}`;
  return s;
}
