import { create } from "zustand";
import type {
  ConnectionRecord,
  RowBatch,
  SchemaTree,
  ColMeta,
  CellValue,
} from "@/ipc/types";
import { bumpRecent } from "@/features/connections/recent";

export type TabKind = "query" | "table_data" | "structure" | "activity" | "roles" | "er_diagram" | "schema_diff";

export interface Tab {
  id: string;
  connId: string;
  kind: TabKind;
  title: string;
  sql?: string;
  columns?: ColMeta[];
  rows?: CellValue[][];
  running?: boolean;
  error?: string;
  elapsedMs?: number;
  /** performance.now() value when the current query started. Set when
   *  running flips true; cleared (or left stale) when done. The UI uses
   *  this to render a live elapsed timer without rerendering the store
   *  on every tick. */
  queryStartedAt?: number;
  /** Bumped by external callers (e.g. inspector re-clicking the same
   *  table) to force the run effect to re-fetch even when the SQL
   *  signature is unchanged. */
  refreshTick?: number;
  /** Pending cell edits keyed by `${rowIdx}:${colIdx}` → string the user
   *  typed. Committed in a single transaction on ⌘S; Esc / discard
   *  clears the map. NOT persisted across reload — too risky for stale
   *  PK references to fire UPDATEs against the wrong row. */
  pendingEdits?: Record<string, string>;
  /** Total row count for the underlying relation (with filters applied).
   *  Two-phase: first the planner estimate from pg_class, then the
   *  exact COUNT(*). `rowsTotalEstimated=true` while the estimate is
   *  showing; flips to false once the exact figure lands. */
  rowsTotal?: number;
  rowsTotalEstimated?: boolean;
  /** Hint set when a tab was opened from a sidebar table — enables
   *  schema-aware features (FK navigation, filter chips, chart axis defaults). */
  sourceRelation?: { schema: string; table: string };
  /** Active filter chips that compile to WHERE expressions. */
  filters?: FilterChip[];
  /** Row indices pinned to the top of the grid (UI-only). */
  pinned?: number[];
  /** Column names hidden in the data view (GUI control). */
  hiddenColumns?: string[];
  /** Row limit applied to the data view's SELECT (GUI control). */
  limit?: number;
  /** Sort key for the data view. */
  sort?: { column: string; dir: "asc" | "desc" };
}

/** Faceted filter chip. `op` is the SQL operator; `value` is the rendered
 *  value (we re-parse for numbers, otherwise quote). For composite types,
 *  emit as `EXPR-style` with `raw=true` so user can write their own predicate. */
export interface FilterChip {
  id: string;
  column: string;
  op: "=" | "!=" | "<" | "<=" | ">" | ">="
    | "IS NULL" | "IS NOT NULL"
    | "LIKE" | "ILIKE"
    | "CONTAINS" | "NOT CONTAINS"
    | "ICONTAINS" | "NOT ICONTAINS";
  value: string | null;
  /** When false, the chip is staged in the builder but NOT included in
   *  the SQL — the user can author multiple filters and toggle which
   *  ones are active. Defaults to true when omitted. */
  enabled?: boolean;
}

export type InspectorView = "items" | "queries" | "history";

export interface SelectedTable {
  schema: string;
  name: string;
}

/**
 * A live database session — one connect attempt against one saved
 * connection record. Multiple sessions can point at the same saved
 * connection; they have independent status, schema cache, and tabs.
 *
 * The `id` is what the rest of the store keys against (in `status`,
 * `schemas`, `activeSchema`, `Tab.connId`, etc.) so existing code keeps
 * working — we just changed what that key *means*. The `connectionId`
 * field points back at the saved record for env / color / display.
 */
export interface Session {
  id: string;
  connectionId: string;
  /** Human-readable suffix when the same connection has multiple sessions —
   *  "#2", "#3", … (set when the second session opens). */
  label?: string;
  openedAt: string;
}

/** Discriminated union for the ObjectOp dialog. */
export type ObjectOpRequest =
  | { kind: "db_new" }
  | { kind: "db_rename" }
  | { kind: "db_duplicate" }
  | { kind: "db_drop" }
  | { kind: "table_new" }
  | { kind: "table_rename"; schema: string; name: string }
  | { kind: "table_duplicate"; schema: string; name: string }
  | { kind: "table_move"; schema: string; name: string }
  | { kind: "table_drop"; schema: string; name: string }
  | { kind: "view_new" }
  | { kind: "mview_new" }
  | { kind: "function_new" }
  | { kind: "schema_new" };

export type EditorAction = "run" | "run-all" | "cancel" | "format" | "toggle-comment";

export interface PanelState {
  rail: boolean;
  inspector: boolean;
  results: boolean;
}

interface State {
  /** Saved connection records (templates). */
  connections: ConnectionRecord[];
  /** Live sessions — what the rail iterates. Each session has its own
   *  status, schema, tabs etc. */
  sessions: Session[];
  /** Status, schemas, activeSchema are keyed by sessionId. */
  status: Record<string, "disconnected" | "connecting" | "connected" | "error">;
  schemas: Record<string, SchemaTree | undefined>;
  tabs: Tab[];
  activeTabId: string | null;
  /** Currently-selected session id (rail selection). Was previously a
   *  connection id; semantically it's now a session id but the variable
   *  name is kept for blast-radius reasons — the field IS a session id. */
  selectedConnId: string | null;
  selectedTable: SelectedTable | null;

  inspectorView: InspectorView;
  activeSchema: Record<string, string | undefined>;
  itemFilter: string;
  panels: PanelState;

  /** Modal flags. */
  connectionFormOpen: boolean;
  /** When set, the connection form opens prefilled to edit this id. */
  connectionFormEditingId: string | null;
  objectOp: ObjectOpRequest | null;
  shortcutsOpen: boolean;
  preferencesOpen: boolean;
  aboutOpen: boolean;
  paletteOpen: boolean;
  /** Bulk export dialog. Null when closed. */
  bulkExportOpen: boolean;
  bulkExportSchema: string | null;
  /** Import dialog. */
  importOpen: boolean;
  importSchema: string | null;
  /** Connection manager dialog (list + search/filter, lives alongside the
   *  rail which only shows live sessions). */
  connectionManagerOpen: boolean;
  /** Cross-connection copy dialog. Mode + an optional preselected source
   *  (when opened from a context menu in the inspector). */
  copyOpen: boolean;
  copyMode: "table" | "database";
  /** Optional preselect — e.g. right-click "Copy to connection…" on a table. */
  copySource: { connId: string; schema?: string; table?: string } | null;

  /** Editor action bus: bumps a counter the active tab subscribes to. */
  editorTick: number;
  editorAction: EditorAction | null;

  /** Bumped when a query runs successfully — the History list re-fetches. */
  historyTick: number;
  /** Bumped when a saved query is added/removed/updated. */
  savedQueriesTick: number;

  setConnections: (cs: ConnectionRecord[]) => void;
  setStatus: (id: string, s: State["status"][string]) => void;
  setSchema: (id: string, s: SchemaTree) => void;

  /** Open a new session for the given saved connection. Returns the new
   *  session id so callers can immediately wire up tabs / introspect. */
  openSession: (connectionId: string) => string;
  /** Close a session — removes it from the rail and closes any tabs it owns. */
  closeSession: (sessionId: string) => void;

  addTab: (t: Tab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  appendBatch: (id: string, b: RowBatch) => void;
  cycleTab: (dir: 1 | -1) => void;

  selectConn: (id: string | null) => void;
  selectTable: (t: SelectedTable | null) => void;
  setInspectorView: (v: InspectorView) => void;
  setActiveSchema: (connId: string, schema: string) => void;
  setItemFilter: (f: string) => void;
  togglePanel: (p: keyof PanelState) => void;

  openConnectionForm: (editId?: string) => void;
  closeConnectionForm: () => void;
  openObjectOp: (r: ObjectOpRequest) => void;
  closeObjectOp: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openPreferences: () => void;
  closePreferences: () => void;
  openAbout: () => void;
  closeAbout: () => void;
  openBulkExport: (schema?: string | null) => void;
  closeBulkExport: () => void;
  openConnectionManager: () => void;
  closeConnectionManager: () => void;
  openCopy: (mode: "table" | "database", source?: State["copySource"]) => void;
  closeCopy: () => void;
  openImport: (schema?: string | null) => void;
  closeImport: () => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;

  fireEditorAction: (a: EditorAction) => void;
  bumpHistory: () => void;
  bumpSavedQueries: () => void;
}

export const useStore = create<State>((set, get) => ({
  connections: [],
  sessions: [],
  status: {},
  schemas: {},
  tabs: [],
  activeTabId: null,
  selectedConnId: null,
  selectedTable: null,
  inspectorView: "items",
  activeSchema: {},
  itemFilter: "",
  panels: { rail: true, inspector: true, results: true },

  connectionFormOpen: false,
  connectionFormEditingId: null,
  objectOp: null,
  shortcutsOpen: false,
  preferencesOpen: false,
  aboutOpen: false,
  paletteOpen: false,
  bulkExportOpen: false,
  bulkExportSchema: null,
  importOpen: false,
  importSchema: null,
  connectionManagerOpen: false,
  copyOpen: false,
  copyMode: "table",
  copySource: null,

  editorTick: 0,
  editorAction: null,
  historyTick: 0,
  savedQueriesTick: 0,

  setConnections: (cs) => set({ connections: cs }),
  setStatus: (id, s) => set((st) => ({ status: { ...st.status, [id]: s } })),
  setSchema: (id, s) => set((st) => ({ schemas: { ...st.schemas, [id]: s } })),

  openSession: (connectionId) => {
    const id = crypto.randomUUID();
    const state = get();
    // If there's already a session for this connection, label this one "#2"
    // (or "#3", etc.) so the rail can distinguish them.
    const siblings = state.sessions.filter((s) => s.connectionId === connectionId);
    const label = siblings.length > 0 ? `#${siblings.length + 1}` : undefined;
    // Promote in the persisted recents list so the quick-pick reflects
    // the user's actual session-opening order.
    bumpRecent(connectionId);
    set((st) => ({
      sessions: [...st.sessions, {
        id, connectionId, label, openedAt: new Date().toISOString(),
      }],
      selectedConnId: id,
    }));
    return id;
  },

  closeSession: (sessionId) =>
    set((st) => ({
      sessions: st.sessions.filter((s) => s.id !== sessionId),
      // Close any tabs that belong to this session.
      tabs: st.tabs.filter((t) => t.connId !== sessionId),
      activeTabId: st.tabs.find((t) => t.id === st.activeTabId && t.connId !== sessionId)
        ? st.activeTabId
        : null,
      // Drop status/schema for this session id.
      status: Object.fromEntries(Object.entries(st.status).filter(([k]) => k !== sessionId)),
      schemas: Object.fromEntries(Object.entries(st.schemas).filter(([k]) => k !== sessionId)),
      activeSchema: Object.fromEntries(Object.entries(st.activeSchema).filter(([k]) => k !== sessionId)),
      // Move rail selection elsewhere if this was the active session.
      selectedConnId: st.selectedConnId === sessionId
        ? st.sessions.find((s) => s.id !== sessionId)?.id ?? null
        : st.selectedConnId,
    })),

  addTab: (t) => set((st) => ({ tabs: [...st.tabs, t], activeTabId: t.id })),
  closeTab: (id) =>
    set((st) => {
      const tabs = st.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId:
          st.activeTabId === id ? tabs[tabs.length - 1]?.id ?? null : st.activeTabId,
      };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  updateTab: (id, patch) =>
    set((st) => ({
      tabs: st.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  appendBatch: (id, b) =>
    set((st) => ({
      tabs: st.tabs.map((t) => {
        if (t.id !== id) return t;
        const columns = t.columns ?? b.columns ?? [];
        const rows = [...(t.rows ?? []), ...b.rows];
        return { ...t, columns, rows, running: !b.done };
      }),
    })),
  cycleTab: (dir) => {
    const { tabs, activeTabId } = get();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    const n = tabs.length;
    const next = ((i < 0 ? 0 : i) + dir + n) % n;
    set({ activeTabId: tabs[next].id });
  },

  selectConn: (id) => set({ selectedConnId: id, selectedTable: null }),
  selectTable: (t) => set({ selectedTable: t }),
  setInspectorView: (v) => set({ inspectorView: v }),
  setActiveSchema: (connId, schema) =>
    set((st) => ({ activeSchema: { ...st.activeSchema, [connId]: schema } })),
  setItemFilter: (f) => set({ itemFilter: f }),
  togglePanel: (p) =>
    set((st) => ({ panels: { ...st.panels, [p]: !st.panels[p] } })),

  openConnectionForm: (editId) =>
    set({ connectionFormOpen: true, connectionFormEditingId: editId ?? null }),
  closeConnectionForm: () =>
    set({ connectionFormOpen: false, connectionFormEditingId: null }),
  openObjectOp: (r) => set({ objectOp: r }),
  closeObjectOp: () => set({ objectOp: null }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openPreferences: () => set({ preferencesOpen: true }),
  closePreferences: () => set({ preferencesOpen: false }),
  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),
  openBulkExport: (schema) =>
    set({ bulkExportOpen: true, bulkExportSchema: schema ?? null }),
  closeBulkExport: () =>
    set({ bulkExportOpen: false, bulkExportSchema: null }),
  openImport: (schema) =>
    set({ importOpen: true, importSchema: schema ?? null }),
  closeImport: () =>
    set({ importOpen: false, importSchema: null }),
  openConnectionManager: () => set({ connectionManagerOpen: true }),
  closeConnectionManager: () => set({ connectionManagerOpen: false }),
  openCopy: (mode, source) =>
    set({ copyOpen: true, copyMode: mode, copySource: source ?? null }),
  closeCopy: () => set({ copyOpen: false, copySource: null }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((st) => ({ paletteOpen: !st.paletteOpen })),

  fireEditorAction: (a) =>
    set((st) => ({ editorAction: a, editorTick: st.editorTick + 1 })),
  bumpHistory: () => set((st) => ({ historyTick: st.historyTick + 1 })),
  bumpSavedQueries: () => set((st) => ({ savedQueriesTick: st.savedQueriesTick + 1 })),
}));
