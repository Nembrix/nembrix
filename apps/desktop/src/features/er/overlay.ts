/**
 * ER tab edit overlay.
 *
 * The diagram normally renders the live schema as-is. Once the user
 * makes an edit (rename a column, add a table, drop a FK, etc.), the
 * overlay layer takes over: it stores a mutable copy of the schema
 * keyed by (connectionId, schemaName, mode), and the canvas reads from
 * that instead of the schema cache.
 *
 * Modes:
 *   - "live-fork"  — start from the live schema, edits live on top
 *   - "sketchpad"  — start blank, design from scratch
 *
 * Persistence: localStorage. Survives reload but cleared by Reset.
 *
 * The overlay tracks "dirty" state per table + column so the canvas
 * can render a modified indicator (or use it for the diff that Apply
 * later compiles into DDL).
 */

import type { RelationNode, ColumnNode, ForeignKey } from "@/ipc/types";

export type ErMode = "live-fork" | "sketchpad";

/** What a column looks like inside the overlay. Includes a `_dirty`
 *  flag distinct from the column's other fields, used purely by the
 *  UI to flag "this differs from the live schema". */
export interface OverlayColumn extends ColumnNode {
  _dirty?: boolean;
  /** Set on freshly-added columns so the DDL emitter knows to issue
   *  ADD COLUMN rather than ALTER COLUMN. */
  _added?: boolean;
}

export interface OverlayForeignKey extends ForeignKey {
  /** Set on FKs added in this session so the DDL emitter knows to
   *  issue ADD CONSTRAINT rather than ignore it. */
  _added?: boolean;
}

export interface OverlayTable {
  name: string;
  /** Original name when the user renamed the table. Empty/undefined
   *  when unchanged. The DDL emitter reads this to decide between
   *  CREATE TABLE and ALTER TABLE … RENAME. */
  originalName?: string;
  columns: OverlayColumn[];
  primary_key: string[];
  foreign_keys: OverlayForeignKey[];
  indexes: RelationNode["indexes"];
  _added?: boolean;
  _droppedColumns?: string[];   // original names of columns the user removed
  _droppedFks?: string[];       // names of original FKs the user dropped
  _dirty?: boolean;
}

export interface OverlayState {
  mode: ErMode;
  tables: OverlayTable[];
  /** Names of tables the user dropped (only meaningful in live-fork).
   *  Used by the DDL emitter to issue DROP TABLE. */
  droppedTables: string[];
}

const KEY_PREFIX = "nembrix.er.overlay.v1";

function key(connId: string, schemaName: string): string {
  return `${KEY_PREFIX}.${connId}.${schemaName}`;
}

/** Load whatever is persisted for this (connection, schema). Returns
 *  null when nothing is stored — caller falls back to building from
 *  the live schema. */
export function loadOverlay(connId: string, schemaName: string): OverlayState | null {
  try {
    const raw = localStorage.getItem(key(connId, schemaName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverlayState;
    if (!parsed.mode || !Array.isArray(parsed.tables)) return null;
    return parsed;
  } catch { return null; }
}

export function saveOverlay(connId: string, schemaName: string, state: OverlayState): void {
  try {
    localStorage.setItem(key(connId, schemaName), JSON.stringify(state));
  } catch { /* localStorage may be full or disabled */ }
}

export function clearOverlay(connId: string, schemaName: string): void {
  try { localStorage.removeItem(key(connId, schemaName)); } catch { /* ignore */ }
}

/** Build an overlay from a live schema. Used when entering live-fork
 *  mode with no prior persistence, OR when the user hits Reset. */
export function overlayFromLive(tables: RelationNode[]): OverlayState {
  return {
    mode: "live-fork",
    tables: tables.map((t): OverlayTable => ({
      name: t.name,
      columns: t.columns.map((c) => ({ ...c })),
      primary_key: [...t.primary_key],
      foreign_keys: t.foreign_keys.map((fk) => ({ ...fk })),
      indexes: t.indexes.map((i) => ({ ...i })),
    })),
    droppedTables: [],
  };
}

/** Build an empty sketchpad overlay. */
export function overlaySketchpad(): OverlayState {
  return { mode: "sketchpad", tables: [], droppedTables: [] };
}

/** True when this overlay contains any pending change vs. the live
 *  schema. In sketchpad mode any non-empty state is dirty. */
export function isDirty(state: OverlayState): boolean {
  if (state.mode === "sketchpad") return state.tables.length > 0;
  if (state.droppedTables.length > 0) return true;
  for (const t of state.tables) {
    if (t._added || t._dirty) return true;
    if (t.originalName && t.originalName !== t.name) return true;
    if (t._droppedColumns && t._droppedColumns.length > 0) return true;
    if (t._droppedFks && t._droppedFks.length > 0) return true;
    for (const c of t.columns) {
      if (c._added || c._dirty) return true;
    }
    for (const fk of t.foreign_keys) {
      if (fk._added) return true;
    }
  }
  return false;
}

/** Convenience accessors used by the canvas — projects the overlay
 *  into the (RelationNode[], droppedTables) shape the rest of the
 *  diagram code already understands. */
export function projectAsRelations(state: OverlayState): RelationNode[] {
  return state.tables.map((t) => ({
    name: t.name,
    columns: t.columns.map(({ _dirty, _added, ...c }) => {
      void _dirty; void _added;
      return c;
    }),
    primary_key: t.primary_key,
    foreign_keys: t.foreign_keys.map(({ _added, ...fk }) => {
      void _added;
      return fk;
    }),
    indexes: t.indexes,
  }));
}
