/**
 * Render a list of `DiffOp`s as a Postgres migration script.
 *
 * Output is a single transaction (`BEGIN; … COMMIT;`) so a mid-migration
 * failure rolls everything back. The user reviews the preview in the UI
 * before we ever send it to the server.
 *
 * Statement order:
 *  1. DROP foreign keys (so columns we're about to drop don't choke)
 *  2. DROP indexes
 *  3. DROP columns
 *  4. DROP tables (CASCADE)
 *  5. ADD tables
 *  6. ADD columns
 *  7. ALTER column types / NOT NULL / DEFAULT
 *  8. ADD indexes
 *  9. ADD foreign keys (last, after the tables they reference exist)
 *
 * Renames and complex restructures still go through the existing per-column
 * dialogs — this generator only handles the straightforward "add / drop /
 * change-shape" cases the diff engine produces.
 */

import type { ColumnNode, IndexNode, RelationNode } from "@/ipc/types";
import type { DiffOp } from "./engine";

export function generateMigration(ops: DiffOp[]): string {
  if (ops.length === 0) return "-- Nothing to migrate.\n";
  const stages: string[] = [];
  const grouped = groupOps(ops);
  for (const stmt of grouped.dropFks)     stages.push(dropFk(stmt));
  for (const stmt of grouped.dropIndexes) stages.push(dropIndex(stmt));
  for (const stmt of grouped.dropColumns) stages.push(dropColumn(stmt));
  for (const stmt of grouped.dropTables)  stages.push(dropTable(stmt));
  for (const stmt of grouped.addTables)   stages.push(addTable(stmt));
  for (const stmt of grouped.addColumns)  stages.push(addColumn(stmt));
  for (const stmt of grouped.changeColumns) stages.push(...changeColumn(stmt));
  for (const stmt of grouped.addIndexes)  stages.push(addIndex(stmt));
  for (const stmt of grouped.addFks)      stages.push(addFk(stmt));
  return ["BEGIN;", ...stages, "COMMIT;"].join("\n");
}

/* ───────────────────────── per-op statement builders ───────────────── */

function addTable(op: DiffOp): string {
  const r = op.payload as RelationNode;
  const cols = r.columns.map(formatColumn).join(",\n  ");
  let pk = "";
  if (r.primary_key.length) {
    pk = `,\n  PRIMARY KEY (${r.primary_key.map(qi).join(", ")})`;
  }
  return `CREATE TABLE ${qi(op.schema)}.${qi(op.table)} (\n  ${cols}${pk}\n);`;
}

function dropTable(op: DiffOp): string {
  return `DROP TABLE ${qi(op.schema)}.${qi(op.table)} CASCADE;`;
}

function addColumn(op: DiffOp): string {
  const c = op.payload as ColumnNode;
  return `ALTER TABLE ${qi(op.schema)}.${qi(op.table)} ADD COLUMN ${formatColumn(c)};`;
}

function dropColumn(op: DiffOp): string {
  return `ALTER TABLE ${qi(op.schema)}.${qi(op.table)} DROP COLUMN ${qi(op.column!)};`;
}

function changeColumn(op: DiffOp): string[] {
  const t = `ALTER TABLE ${qi(op.schema)}.${qi(op.table)}`;
  switch (op.kind) {
    case "column.changeType": {
      const { to } = op.payload as { from: string; to: string };
      return [`${t} ALTER COLUMN ${qi(op.column!)} TYPE ${to};`];
    }
    case "column.setNotNull":
      return [`${t} ALTER COLUMN ${qi(op.column!)} SET NOT NULL;`];
    case "column.dropNotNull":
      return [`${t} ALTER COLUMN ${qi(op.column!)} DROP NOT NULL;`];
    case "column.setDefault":
      return [`${t} ALTER COLUMN ${qi(op.column!)} SET DEFAULT ${op.payload};`];
    case "column.dropDefault":
      return [`${t} ALTER COLUMN ${qi(op.column!)} DROP DEFAULT;`];
    default:
      return [];
  }
}

function addIndex(op: DiffOp): string {
  const ix = op.payload as IndexNode;
  const unique = ix.is_unique && !ix.is_primary ? "UNIQUE " : "";
  const method = ix.method && ix.method !== "btree" ? ` USING ${ix.method}` : "";
  // PK is implicit; if this is a primary-key index, leave it to the table
  // creation step rather than emitting a separate CREATE INDEX.
  if (ix.is_primary) return `-- (primary key index ${ix.name} is part of the table definition)`;
  return `CREATE ${unique}INDEX ${qi(ix.name)} ON ${qi(op.schema)}.${qi(op.table)}${method} (${ix.columns.map(qi).join(", ")});`;
}

function dropIndex(op: DiffOp): string {
  const ix = op.payload as IndexNode;
  return `DROP INDEX ${qi(op.schema)}.${qi(ix.name)};`;
}

function addFk(op: DiffOp): string {
  const fk = op.payload as { name: string; columns: string[]; referenced_schema: string; referenced_table: string; referenced_columns: string[] };
  return `ALTER TABLE ${qi(op.schema)}.${qi(op.table)} ADD CONSTRAINT ${qi(fk.name)} FOREIGN KEY (${fk.columns.map(qi).join(", ")}) REFERENCES ${qi(fk.referenced_schema)}.${qi(fk.referenced_table)} (${fk.referenced_columns.map(qi).join(", ")});`;
}

function dropFk(op: DiffOp): string {
  const fk = op.payload as { name: string };
  return `ALTER TABLE ${qi(op.schema)}.${qi(op.table)} DROP CONSTRAINT ${qi(fk.name)};`;
}

/* ───────────────────────── helpers ───────────────────────── */

function formatColumn(c: ColumnNode): string {
  let s = `${qi(c.name)} ${c.type_name}`;
  if (!c.nullable) s += " NOT NULL";
  if (c.default != null) s += ` DEFAULT ${c.default}`;
  return s;
}

function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function groupOps(ops: DiffOp[]) {
  const g = {
    dropFks: [] as DiffOp[], dropIndexes: [] as DiffOp[], dropColumns: [] as DiffOp[],
    dropTables: [] as DiffOp[], addTables: [] as DiffOp[], addColumns: [] as DiffOp[],
    changeColumns: [] as DiffOp[], addIndexes: [] as DiffOp[], addFks: [] as DiffOp[],
  };
  for (const op of ops) {
    switch (op.kind) {
      case "fk.drop":            g.dropFks.push(op); break;
      case "index.drop":         g.dropIndexes.push(op); break;
      case "column.drop":        g.dropColumns.push(op); break;
      case "table.drop":         g.dropTables.push(op); break;
      case "table.add":          g.addTables.push(op); break;
      case "column.add":         g.addColumns.push(op); break;
      case "column.changeType":
      case "column.setNotNull":
      case "column.dropNotNull":
      case "column.setDefault":
      case "column.dropDefault": g.changeColumns.push(op); break;
      case "index.add":          g.addIndexes.push(op); break;
      case "fk.add":             g.addFks.push(op); break;
    }
  }
  return g;
}
