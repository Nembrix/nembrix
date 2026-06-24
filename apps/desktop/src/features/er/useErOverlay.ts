/**
 * React binding for the ER overlay store. Keeps a per-(connection,
 * schema) overlay in state, syncs it to localStorage, exposes
 * mutation helpers + reset.
 *
 * The hook is consciously simple — one useState + one useEffect for
 * persistence. We're not reaching for a zustand slice or a context
 * because the overlay belongs to a single tab; lifting it any higher
 * would buy us nothing.
 */

import { useCallback, useEffect, useState } from "react";
import type { RelationNode } from "@/ipc/types";
import {
  type ErMode, type OverlayColumn, type OverlayForeignKey, type OverlayState, type OverlayTable,
  clearOverlay, isDirty, loadOverlay, overlayFromLive, overlaySketchpad,
  saveOverlay,
} from "./overlay";

interface UseErOverlayOpts {
  connId: string;
  schemaName: string;
  /** Live tables from the schema cache — used as the baseline for
   *  live-fork mode and any time we Reset. */
  liveTables: RelationNode[];
}

export interface UseErOverlayResult {
  state: OverlayState;
  mode: ErMode;
  dirty: boolean;
  setMode: (mode: ErMode) => void;
  reset: () => void;
  /* ─── table-level mutations ─── */
  addTable: (name: string) => void;
  renameTable: (current: string, next: string) => void;
  dropTable: (name: string) => void;
  /* ─── column-level mutations ─── */
  addColumn: (table: string, column: OverlayColumn) => void;
  renameColumn: (table: string, current: string, next: string) => void;
  dropColumn: (table: string, name: string) => void;
  updateColumn: (table: string, name: string, patch: Partial<OverlayColumn>) => void;
  togglePk: (table: string, column: string) => void;
  /* ─── FK-level mutations ─── */
  addForeignKey: (
    fromTable: string,
    fromColumn: string,
    toTable: string,
    toColumn: string,
  ) => void;
  dropForeignKey: (table: string, fkName: string) => void;
}

export function useErOverlay({ connId, schemaName, liveTables }: UseErOverlayOpts): UseErOverlayResult {
  // Initial load: persisted overlay wins, otherwise build from live.
  const [state, setState] = useState<OverlayState>(() => {
    const persisted = loadOverlay(connId, schemaName);
    return persisted ?? overlayFromLive(liveTables);
  });

  // Persist on every change. Cheap to JSON.stringify even with dozens
  // of tables; deferring with useDeferredValue isn't worth the
  // complexity at this scale.
  useEffect(() => {
    saveOverlay(connId, schemaName, state);
  }, [connId, schemaName, state]);

  const setMode = useCallback((mode: ErMode) => {
    setState((cur) => {
      if (cur.mode === mode) return cur;
      // Switching modes wipes the current overlay — keeping live-fork
      // edits when we drop into sketchpad would be confusing, and vice
      // versa.
      return mode === "live-fork" ? overlayFromLive(liveTables) : overlaySketchpad();
    });
  }, [liveTables]);

  const reset = useCallback(() => {
    setState(() => {
      // Reset in sketchpad clears the canvas. Reset in live-fork
      // re-mirrors the current live schema.
      return state.mode === "sketchpad" ? overlaySketchpad() : overlayFromLive(liveTables);
    });
    clearOverlay(connId, schemaName);
  }, [state.mode, liveTables, connId, schemaName]);

  const addTable = useCallback((name: string) => {
    setState((cur) => {
      if (cur.tables.some((t) => t.name === name)) return cur;
      const newTable: OverlayTable = {
        name,
        columns: [{
          name: "id", type_name: "integer", nullable: false,
          default: "nextval('seq')", _added: true,
        }],
        primary_key: ["id"],
        foreign_keys: [],
        indexes: [],
        _added: true,
      };
      return { ...cur, tables: [...cur.tables, newTable] };
    });
  }, []);

  const renameTable = useCallback((current: string, next: string) => {
    if (current === next || !next) return;
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) =>
        t.name !== current ? t
          : {
              ...t,
              name: next,
              originalName: t.originalName ?? (t._added ? undefined : current),
              _dirty: !t._added,
            },
      ),
    }));
  }, []);

  const dropTable = useCallback((name: string) => {
    setState((cur) => {
      const target = cur.tables.find((t) => t.name === name);
      if (!target) return cur;
      const tables = cur.tables.filter((t) => t.name !== name);
      // Only original (non-added) tables get queued for DROP TABLE; if
      // the user added it in this session we just throw it away.
      const droppedTables = target._added
        ? cur.droppedTables
        : [...cur.droppedTables, target.originalName ?? target.name];
      return { ...cur, tables, droppedTables };
    });
  }, []);

  const addColumn = useCallback((table: string, column: OverlayColumn) => {
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        if (t.columns.some((c) => c.name === column.name)) return t;
        return {
          ...t,
          columns: [...t.columns, { ...column, _added: true }],
          _dirty: !t._added ? true : t._dirty,
        };
      }),
    }));
  }, []);

  const renameColumn = useCallback((table: string, current: string, next: string) => {
    if (current === next || !next) return;
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        const columns = t.columns.map((c) =>
          c.name !== current ? c : { ...c, name: next, _dirty: !c._added },
        );
        // Track the PK rename too so the diff stays in sync.
        const primary_key = t.primary_key.map((p) => (p === current ? next : p));
        return { ...t, columns, primary_key, _dirty: !t._added ? true : t._dirty };
      }),
    }));
  }, []);

  const dropColumn = useCallback((table: string, name: string) => {
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        const target = t.columns.find((c) => c.name === name);
        if (!target) return t;
        const columns = t.columns.filter((c) => c.name !== name);
        const primary_key = t.primary_key.filter((p) => p !== name);
        // Only original columns get queued for ALTER … DROP COLUMN.
        const _droppedColumns = target._added
          ? t._droppedColumns
          : [...(t._droppedColumns ?? []), name];
        return { ...t, columns, primary_key, _droppedColumns, _dirty: !t._added ? true : t._dirty };
      }),
    }));
  }, []);

  const updateColumn = useCallback((table: string, name: string, patch: Partial<OverlayColumn>) => {
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        const columns = t.columns.map((c) =>
          c.name !== name ? c : { ...c, ...patch, _dirty: !c._added },
        );
        return { ...t, columns, _dirty: !t._added ? true : t._dirty };
      }),
    }));
  }, []);

  const togglePk = useCallback((table: string, column: string) => {
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        const pkSet = new Set(t.primary_key);
        if (pkSet.has(column)) pkSet.delete(column);
        else pkSet.add(column);
        return { ...t, primary_key: [...pkSet], _dirty: !t._added ? true : t._dirty };
      }),
    }));
  }, []);

  const addForeignKey = useCallback(
    (fromTable: string, fromColumn: string, toTable: string, toColumn: string) => {
      if (!fromTable || !fromColumn || !toTable || !toColumn) return;
      // Self-referential FKs are valid SQL but rarely what the user wants
      // from a drag, so we don't filter them out — pg will refuse if the
      // target column isn't unique, which surfaces in the Apply step.
      setState((cur) => {
        const sc = (cur as OverlayState & { _schemaName?: string });
        void sc;
        const src = cur.tables.find((t) => t.name === fromTable);
        const dst = cur.tables.find((t) => t.name === toTable);
        if (!src || !dst) return cur;
        // Skip duplicates — column-level matching is enough; pg will
        // collapse identical constraints anyway.
        const existing = src.foreign_keys.find(
          (fk) =>
            fk.referenced_table === toTable
            && fk.columns.length === 1
            && fk.columns[0] === fromColumn
            && fk.referenced_columns[0] === toColumn,
        );
        if (existing) return cur;
        const fkName = `${fromTable}_${fromColumn}_fkey`;
        const newFk: OverlayForeignKey = {
          name: fkName,
          columns: [fromColumn],
          referenced_schema: schemaName,
          referenced_table: toTable,
          referenced_columns: [toColumn],
          _added: true,
        };
        return {
          ...cur,
          tables: cur.tables.map((t) =>
            t.name !== fromTable ? t : { ...t, foreign_keys: [...t.foreign_keys, newFk] },
          ),
        };
      });
    },
    [schemaName],
  );

  const dropForeignKey = useCallback((table: string, fkName: string) => {
    setState((cur) => ({
      ...cur,
      tables: cur.tables.map((t) => {
        if (t.name !== table) return t;
        const target = t.foreign_keys.find((fk) => fk.name === fkName);
        if (!target) return t;
        const foreign_keys = t.foreign_keys.filter((fk) => fk.name !== fkName);
        const _droppedFks = target._added
          ? t._droppedFks
          : [...(t._droppedFks ?? []), fkName];
        return { ...t, foreign_keys, _droppedFks };
      }),
    }));
  }, []);

  return {
    state,
    mode: state.mode,
    dirty: isDirty(state),
    setMode, reset,
    addTable, renameTable, dropTable,
    addColumn, renameColumn, dropColumn, updateColumn, togglePk,
    addForeignKey, dropForeignKey,
  };
}
