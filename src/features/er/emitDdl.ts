/**
 * Diff the ER overlay against the original (pre-edit) schema and emit
 * the SQL DDL needed to reconcile them.
 *
 * Order matters — Postgres rejects mid-transaction reordering for some
 * dependency chains, so we lay statements out in the order that always
 * works:
 *
 *   1. DROP FOREIGN KEYs   (so we can DROP COLUMNs they reference)
 *   2. DROP COLUMNs         (so we can DROP TABLEs cleanly)
 *   3. DROP TABLEs
 *   4. CREATE TABLEs        (new tables come fully formed)
 *   5. RENAME TABLEs        (after creates so name conflicts don't bite)
 *   6. ADD COLUMNs to existing tables
 *   7. ALTER COLUMNs        (type / nullable / default changes)
 *   8. RENAME COLUMNs       (last so the rest of the script references
 *                             the original names)
 *   9. ADD FOREIGN KEYs     (last — the columns they reference now exist)
 *
 * The whole block is wrapped in BEGIN; ... COMMIT; so a runtime error
 * rolls everything back.
 */

import type { OverlayColumn, OverlayState, OverlayTable } from "./overlay";
import type { ForeignKey } from "@/ipc/types";

/** Quote a Postgres identifier — naïve double-quote-and-escape, which
 *  is correct for everything that isn't already double-quoted. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/** Render a column definition for CREATE TABLE / ADD COLUMN. */
function columnSql(c: OverlayColumn): string {
  const parts = [ident(c.name), c.type_name];
  if (c.nullable === false) parts.push("NOT NULL");
  if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
  return parts.join(" ");
}

/** Find a table by its original name (or current name if it was added). */
function originalNameOf(t: OverlayTable): string {
  return t.originalName ?? t.name;
}

export interface DdlPlan {
  /** Ordered statements; the dialog renders them as one big preview. */
  statements: string[];
  /** Per-statement label so the dialog can group them. */
  labels: string[];
}

export function emitDdl(state: OverlayState, schemaName: string): DdlPlan {
  const out: string[] = [];
  const labels: string[] = [];

  const push = (label: string, sql: string) => { out.push(sql); labels.push(label); };

  // ── 1. Drop FKs that were removed in this session ──
  for (const t of state.tables) {
    for (const fkName of t._droppedFks ?? []) {
      push("Drop FK",
        `ALTER TABLE ${qualified(schemaName, originalNameOf(t))} `
        + `DROP CONSTRAINT ${ident(fkName)};`);
    }
  }

  // ── 2. Drop columns ──
  for (const t of state.tables) {
    for (const colName of t._droppedColumns ?? []) {
      push("Drop column",
        `ALTER TABLE ${qualified(schemaName, originalNameOf(t))} `
        + `DROP COLUMN ${ident(colName)};`);
    }
  }

  // ── 3. Drop tables ──
  for (const name of state.droppedTables) {
    push("Drop table", `DROP TABLE ${qualified(schemaName, name)};`);
  }

  // ── 4. Create tables ──
  for (const t of state.tables) {
    if (!t._added) continue;
    const cols = t.columns.map(columnSql);
    if (t.primary_key.length > 0) {
      cols.push(`PRIMARY KEY (${t.primary_key.map(ident).join(", ")})`);
    }
    push("Create table",
      `CREATE TABLE ${qualified(schemaName, t.name)} (\n  ${cols.join(",\n  ")}\n);`);
  }

  // ── 5. Rename tables ──
  for (const t of state.tables) {
    if (t._added) continue;
    if (t.originalName && t.originalName !== t.name) {
      push("Rename table",
        `ALTER TABLE ${qualified(schemaName, t.originalName)} `
        + `RENAME TO ${ident(t.name)};`);
    }
  }

  // ── 6. Add columns to existing tables ──
  for (const t of state.tables) {
    if (t._added) continue;
    for (const c of t.columns) {
      if (!c._added) continue;
      push("Add column",
        `ALTER TABLE ${qualified(schemaName, t.name)} `
        + `ADD COLUMN ${columnSql(c)};`);
    }
  }

  // ── 7. Alter columns (type / nullable / default changes) ──
  //
  // We can only emit a sensible ALTER from a flag — the diff against
  // the live schema would require keeping a baseline copy of every
  // column. For now we surface a TODO-comment block when columns are
  // marked _dirty but not _added; an interactive type picker comes in
  // a later pass.
  for (const t of state.tables) {
    if (t._added) continue;
    for (const c of t.columns) {
      if (c._added || !c._dirty) continue;
      push("Alter column",
        `-- TODO: ALTER COLUMN ${ident(c.name)} TYPE ${c.type_name} `
        + `${c.nullable ? "" : "NOT NULL "}`
        + `${c.default != null ? "DEFAULT " + c.default : ""}`
        + ` (manual review required)`);
    }
  }

  // ── 8. Rename columns ──
  //
  // Column renames don't have an `originalName` field on OverlayColumn
  // because the simpler diff model is "if a column is in the original
  // table and not in the overlay, it was dropped". A future patch can
  // add an OverlayColumn.originalName, but for now renames present as
  // drop+add; users can fix manually.

  // ── 9. Add FKs ──
  for (const t of state.tables) {
    for (const fk of t.foreign_keys) {
      // Only emit FKs that were added in this session OR every FK on
      // a freshly-created table (the CREATE doesn't include them).
      if (!fk._added && !t._added) continue;
      push("Add FK",
        `ALTER TABLE ${qualified(schemaName, t.name)} `
        + `ADD CONSTRAINT ${ident(fk.name)} `
        + `FOREIGN KEY (${fk.columns.map(ident).join(", ")}) `
        + `REFERENCES ${qualified(fk.referenced_schema, fk.referenced_table)} `
        + `(${fk.referenced_columns.map(ident).join(", ")});`);
    }
  }

  return { statements: out, labels };
}

/** Wrap statements in a transaction. Returns a single string ready
 *  to feed `api.execute`. */
export function asTransaction(plan: DdlPlan): string {
  return ["BEGIN;", ...plan.statements, "COMMIT;"].join("\n");
}

// Re-export the FK type so other files importing emitDdl don't have to
// reach into ipc/types directly.
export type { ForeignKey };
