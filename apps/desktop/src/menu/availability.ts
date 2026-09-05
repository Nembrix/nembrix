/**
 * Single source of truth for which menu items are clickable in the current
 * app state. Used by:
 *   - the browser-mode top MenuBar (greys out disabled rows)
 *   - the dispatcher (refuses to fire disabled ids — defense in depth)
 *   - the palette (filters disabled actions unless explicitly named)
 *   - the Tauri sync layer (calls `update_menu_state` on the Rust side)
 *
 * Predicates are pure (snapshot → boolean) so they're trivially testable and
 * memo-friendly. Items not listed here are always enabled — e.g. "New
 * Connection…", "Documentation", "Report an Issue…".
 */

import { MENU, type MenuId } from "./ids";
import type { useStore } from "@/store";

type Snapshot = ReturnType<typeof useStore.getState>;

/** Subset of state that any predicate can read. Keeps Snapshot from leaking. */
function ctx(s: Snapshot) {
  // selectedConnId is a *session* id post-sessions-refactor; resolve it
  // back to the underlying saved-connection record. Falling back to a
  // direct connection-id lookup keeps any pre-session code paths working.
  const sess = s.selectedConnId
    ? s.sessions.find((x) => x.id === s.selectedConnId)
    : undefined;
  const connId = sess?.connectionId ?? s.selectedConnId ?? null;
  const conn = connId
    ? s.connections.find((c) => c.id === connId)
    : undefined;
  // Status is keyed by session id (rail writes per-session). Read straight
  // off selectedConnId so we get the live session's status.
  const status = s.selectedConnId
    ? s.status[s.selectedConnId] ?? "disconnected"
    : "disconnected";
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return {
    connSelected: !!conn,
    connected: status === "connected",
    disconnected: status === "disconnected" || status === "error",
    schemaLoaded: !!s.selectedConnId && !!s.schemas[s.selectedConnId],
    tableSelected: !!s.selectedTable,
    tabActive: !!tab,
    tabIsQuery: tab?.kind === "query",
    tabRunning: !!tab?.running,
    hasTabs: s.tabs.length > 0,
    canCycleTabs: s.tabs.length > 1,
  };
}

type Predicate = (s: Snapshot) => boolean;

/**
 * Map of menu id → predicate. An id absent from this map is treated as
 * always-enabled.
 */
const RULES: Partial<Record<MenuId, Predicate>> = {
  // File
  [MENU.NEW_QUERY_TAB]:   (s) => ctx(s).connected,
  // Import/Export open a dialog that needs a connection to read from. Their
  // handlers already bail out without one, but silently — the menu row and
  // palette entry looked live and clicking did nothing. A rule here greys them
  // out instead, so the reason is visible.
  [MENU.IMPORT]:          (s) => ctx(s).connSelected,
  [MENU.EXPORT]:          (s) => ctx(s).connSelected,
  [MENU.SAVE_QUERY]:      (s) => ctx(s).tabIsQuery,
  [MENU.SAVE_QUERY_AS]:   (s) => ctx(s).tabIsQuery,
  [MENU.CLOSE_TAB]:       (s) => ctx(s).hasTabs,

  // Edit (CodeMirror takes care of cut/copy/paste; find/replace need an editor)
  [MENU.FIND]:            (s) => ctx(s).tabIsQuery,
  [MENU.FIND_NEXT]:       (s) => ctx(s).tabIsQuery,
  [MENU.REPLACE]:         (s) => ctx(s).tabIsQuery,

  // View
  [MENU.NEXT_TAB]:        (s) => ctx(s).canCycleTabs,
  [MENU.PREV_TAB]:        (s) => ctx(s).canCycleTabs,

  // Connection
  [MENU.CONNECT]:         (s) => ctx(s).connSelected && !ctx(s).connected,
  [MENU.DISCONNECT]:      (s) => ctx(s).connected,
  [MENU.EDIT_CONNECTION]: (s) => ctx(s).connSelected,
  [MENU.DUPLICATE_CONNECTION]: (s) => ctx(s).connSelected,
  [MENU.DELETE_CONNECTION]:    (s) => ctx(s).connSelected,
  [MENU.REFRESH_SCHEMA]:  (s) => ctx(s).connected,

  // Database (all require an open connection)
  [MENU.DB_NEW]:          (s) => ctx(s).connected,
  [MENU.DB_RENAME]:       (s) => ctx(s).connected,
  [MENU.DB_DUPLICATE]:    (s) => ctx(s).connected,
  [MENU.DB_DROP]:         (s) => ctx(s).connected,
  [MENU.DB_MANAGE_ROLES]: (s) => ctx(s).connected,
  [MENU.DB_ACTIVITY]:     (s) => ctx(s).connected,
  [MENU.DB_ER_DIAGRAM]:   (s) => ctx(s).connected && ctx(s).schemaLoaded,
  [MENU.DB_SCHEMA_DIFF]:  (s) => ctx(s).connected,

  // Table (need a connected DB AND a focused table)
  [MENU.TABLE_NEW]:         (s) => ctx(s).connected,
  [MENU.TABLE_RENAME]:      (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_DUPLICATE]:   (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_MOVE_SCHEMA]: (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_DROP]:        (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_TRUNCATE]:    (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_VACUUM]:      (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_REINDEX]:     (s) => ctx(s).connected && ctx(s).tableSelected,
  [MENU.TABLE_COPY_CREATE]: (s) => ctx(s).tableSelected,
  [MENU.TABLE_COPY_NAME]:   (s) => ctx(s).tableSelected,

  // Query (need an open query tab on a connected DB)
  [MENU.QUERY_RUN_CURRENT]:    (s) => ctx(s).tabIsQuery && ctx(s).connected && !ctx(s).tabRunning,
  [MENU.QUERY_RUN_ALL]:        (s) => ctx(s).tabIsQuery && ctx(s).connected && !ctx(s).tabRunning,
  [MENU.QUERY_CANCEL]:         (s) => ctx(s).tabIsQuery && ctx(s).tabRunning,
  [MENU.QUERY_FORMAT]:         (s) => ctx(s).tabIsQuery,
  [MENU.QUERY_EXPLAIN]:        (s) => ctx(s).tabIsQuery && ctx(s).connected,
  [MENU.QUERY_EXPLAIN_ANALYZE]:(s) => ctx(s).tabIsQuery && ctx(s).connected,
  [MENU.QUERY_TOGGLE_COMMENT]: (s) => ctx(s).tabIsQuery,
  [MENU.QUERY_TOGGLE_LIMIT]:   (s) => ctx(s).tabIsQuery,
};

export function isEnabled(id: MenuId, s: Snapshot): boolean {
  const p = RULES[id];
  return p ? p(s) : true;
}

/**
 * Snapshot of enabled/disabled state for every id we have a rule for.
 * Used to drive the native menu sync — we only push deltas that matter.
 */
export function disabledIds(s: Snapshot): string[] {
  const out: string[] = [];
  for (const id of Object.keys(RULES) as MenuId[]) {
    if (!isEnabled(id, s)) out.push(id);
  }
  return out;
}
