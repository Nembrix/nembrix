/**
 * Canonical menu IDs — mirrored from src-tauri/src/menu.rs.
 * Keep both in sync. The frontend handles every id here; the native side
 * just forwards clicks via the `menu:invoke` event.
 */
export const MENU = {
  // App
  PREFERENCES: "app.preferences",

  // File
  NEW_CONNECTION: "file.new_connection",
  NEW_QUERY_TAB: "file.new_query_tab",
  NEW_WINDOW: "file.new_window",
  OPEN_SAVED_QUERY: "file.open_saved_query",
  SAVE_QUERY: "file.save_query",
  SAVE_QUERY_AS: "file.save_query_as",
  IMPORT: "file.import",
  EXPORT: "file.export",
  CLOSE_TAB: "file.close_tab",

  // Edit (most are predefined; we own these custom ones)
  FIND: "edit.find",
  FIND_NEXT: "edit.find_next",
  REPLACE: "edit.replace",

  // View
  COMMAND_PALETTE: "view.command_palette",
  TOGGLE_RAIL: "view.toggle_rail",
  TOGGLE_INSPECTOR: "view.toggle_inspector",
  TOGGLE_RESULTS: "view.toggle_results",
  NEXT_TAB: "view.next_tab",
  PREV_TAB: "view.prev_tab",

  // Connection
  CONNECT: "conn.connect",
  DISCONNECT: "conn.disconnect",
  MANAGE_CONNECTIONS: "conn.manage",
  /** Sentinel id — the MenuBar renders this as 0..N dynamic entries,
   *  one per recent connection. Not dispatched directly. */
  RECENT_CONNECTIONS_MARKER: "conn.recent_marker",
  /** Prefix used to build per-connection menu ids; the dispatcher
   *  strips the prefix to get the underlying connectionId. */
  RECENT_CONNECTION_PREFIX: "conn.recent:",
  EDIT_CONNECTION: "conn.edit",
  DUPLICATE_CONNECTION: "conn.duplicate",
  DELETE_CONNECTION: "conn.delete",
  REFRESH_SCHEMA: "conn.refresh_schema",

  // Database
  DB_NEW: "db.new",
  DB_RENAME: "db.rename",
  DB_DUPLICATE: "db.duplicate",
  DB_DROP: "db.drop",
  DB_MANAGE_ROLES: "db.manage_roles",
  DB_ACTIVITY: "db.activity",
  DB_ER_DIAGRAM: "db.er_diagram",
  DB_SCHEMA_DIFF: "db.schema_diff",
  DB_COPY_TO: "db.copy_to",

  // Table
  TABLE_NEW: "table.new",
  TABLE_RENAME: "table.rename",
  TABLE_DUPLICATE: "table.duplicate",
  TABLE_MOVE_SCHEMA: "table.move_schema",
  TABLE_DROP: "table.drop",
  TABLE_TRUNCATE: "table.truncate",
  TABLE_VACUUM: "table.vacuum",
  TABLE_REINDEX: "table.reindex",
  TABLE_COPY_CREATE: "table.copy_create",
  TABLE_COPY_NAME: "table.copy_name",
  TABLE_COPY_TO: "table.copy_to",

  // Query
  QUERY_RUN_CURRENT: "query.run_current",
  QUERY_RUN_ALL: "query.run_all",
  QUERY_CANCEL: "query.cancel",
  QUERY_FORMAT: "query.format",
  QUERY_EXPLAIN: "query.explain",
  QUERY_EXPLAIN_ANALYZE: "query.explain_analyze",
  QUERY_TOGGLE_COMMENT: "query.toggle_comment",
  QUERY_TOGGLE_LIMIT: "query.toggle_limit",

  // Window
  BRING_TO_FRONT: "window.bring_to_front",
  /** Hard reload the renderer — escape hatch for a frozen UI. */
  APP_RELOAD: "window.app_reload",

  // Help
  HELP_DOCS: "help.docs",
  HELP_SHORTCUTS: "help.shortcuts",
  HELP_REPORT_ISSUE: "help.report_issue",
  HELP_ABOUT: "help.about",
} as const;

export type MenuId = (typeof MENU)[keyof typeof MENU];

/** Menu structure used by the browser-mode top-bar menu. */
export interface MenuItem {
  id?: string;
  label?: string;
  accel?: string;
  separator?: true;
  disabled?: boolean;
}
export interface MenuGroup {
  label: string;
  items: MenuItem[];
}

export const MENUS: MenuGroup[] = [
  {
    label: "File",
    items: [
      { id: MENU.NEW_CONNECTION, label: "New Connection…", accel: "⌘N" },
      { id: MENU.NEW_QUERY_TAB, label: "New Query Tab", accel: "⌘T" },
      { id: MENU.NEW_WINDOW, label: "New Window", accel: "⌘⇧N" },
      { separator: true },
      { id: MENU.OPEN_SAVED_QUERY, label: "Open Saved Query…", accel: "⌘O" },
      { id: MENU.SAVE_QUERY, label: "Save Query", accel: "⌘S" },
      { id: MENU.SAVE_QUERY_AS, label: "Save Query As…", accel: "⌘⇧S" },
      { separator: true },
      { id: MENU.IMPORT, label: "Import…" },
      { id: MENU.EXPORT, label: "Export…" },
      { separator: true },
      { id: MENU.CLOSE_TAB, label: "Close Tab", accel: "⌘W" },
    ],
  },
  {
    label: "Edit",
    items: [
      { id: MENU.FIND, label: "Find…", accel: "⌘F" },
      { id: MENU.FIND_NEXT, label: "Find Next", accel: "⌘G" },
      { id: MENU.REPLACE, label: "Find & Replace…", accel: "⌘⌥F" },
    ],
  },
  {
    label: "View",
    items: [
      { id: MENU.COMMAND_PALETTE, label: "Command Palette…", accel: "⌘P" },
      { separator: true },
      { id: MENU.TOGGLE_RAIL, label: "Toggle Connection Rail", accel: "⌘0" },
      { id: MENU.TOGGLE_INSPECTOR, label: "Toggle Inspector", accel: "⌘1" },
      { id: MENU.TOGGLE_RESULTS, label: "Toggle Results Pane", accel: "⌘2" },
      { separator: true },
      { id: MENU.NEXT_TAB, label: "Next Tab", accel: "⌃Tab" },
      { id: MENU.PREV_TAB, label: "Previous Tab", accel: "⌃⇧Tab" },
    ],
  },
  {
    label: "Connection",
    items: [
      { id: MENU.MANAGE_CONNECTIONS, label: "Manage Connections…", accel: "⌘⇧L" },
      { id: MENU.RECENT_CONNECTIONS_MARKER },
      { separator: true },
      { id: MENU.CONNECT, label: "Connect", accel: "⌘K" },
      { id: MENU.DISCONNECT, label: "Disconnect", accel: "⌘⇧K" },
      { separator: true },
      { id: MENU.EDIT_CONNECTION, label: "Edit Connection…" },
      { id: MENU.DUPLICATE_CONNECTION, label: "Duplicate Connection" },
      { id: MENU.DELETE_CONNECTION, label: "Delete Connection" },
      { separator: true },
      { id: MENU.REFRESH_SCHEMA, label: "Refresh Schema", accel: "⌘R" },
    ],
  },
  {
    label: "Database",
    items: [
      { id: MENU.DB_NEW, label: "New Database…" },
      { id: MENU.DB_RENAME, label: "Rename Database…" },
      { id: MENU.DB_DUPLICATE, label: "Duplicate Database…" },
      { id: MENU.DB_DROP, label: "Drop Database…" },
      { separator: true },
      { id: MENU.DB_MANAGE_ROLES, label: "Manage Roles & Grants…" },
      { id: MENU.DB_ACTIVITY, label: "Server Activity" },
      { id: MENU.DB_ER_DIAGRAM, label: "ER Diagram" },
      { id: MENU.DB_SCHEMA_DIFF, label: "Schema Diff…" },
      { id: MENU.DB_COPY_TO, label: "Copy to Connection…" },
    ],
  },
  {
    label: "Table",
    items: [
      { id: MENU.TABLE_NEW, label: "New Table…", accel: "⌘⌥N" },
      { id: MENU.TABLE_RENAME, label: "Rename Table…" },
      { id: MENU.TABLE_DUPLICATE, label: "Duplicate Table…" },
      { id: MENU.TABLE_MOVE_SCHEMA, label: "Move to Schema…" },
      { id: MENU.TABLE_DROP, label: "Drop Table…" },
      { separator: true },
      { id: MENU.TABLE_TRUNCATE, label: "Truncate Table…" },
      { id: MENU.TABLE_VACUUM, label: "VACUUM ANALYZE" },
      { id: MENU.TABLE_REINDEX, label: "REINDEX" },
      { separator: true },
      { id: MENU.TABLE_COPY_CREATE, label: "Copy CREATE Statement" },
      { id: MENU.TABLE_COPY_NAME, label: "Copy Qualified Name" },
      { id: MENU.TABLE_COPY_TO, label: "Copy to Connection…" },
    ],
  },
  {
    label: "Query",
    items: [
      { id: MENU.QUERY_RUN_CURRENT, label: "Run Current", accel: "⌘↵" },
      { id: MENU.QUERY_RUN_ALL, label: "Run All", accel: "⌘⇧↵" },
      { id: MENU.QUERY_CANCEL, label: "Cancel Running Query", accel: "⌘." },
      { separator: true },
      { id: MENU.QUERY_FORMAT, label: "Format / Beautify", accel: "⌘I" },
      { id: MENU.QUERY_EXPLAIN, label: "EXPLAIN" },
      { id: MENU.QUERY_EXPLAIN_ANALYZE, label: "EXPLAIN ANALYZE" },
      { separator: true },
      { id: MENU.QUERY_TOGGLE_COMMENT, label: "Toggle Line Comment", accel: "⌘/" },
      { id: MENU.QUERY_TOGGLE_LIMIT, label: "Toggle Row Limit" },
    ],
  },
  {
    label: "Help",
    items: [
      { id: MENU.HELP_DOCS, label: "Documentation" },
      { id: MENU.HELP_SHORTCUTS, label: "Keyboard Shortcuts" },
      { separator: true },
      { id: MENU.APP_RELOAD, label: "Reload App", accel: "⌘⇧R" },
      { separator: true },
      { id: MENU.HELP_REPORT_ISSUE, label: "Report an Issue…" },
      { id: MENU.HELP_ABOUT, label: "About Nembrix…" },
    ],
  },
];
