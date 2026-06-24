import { MENU } from "./ids";
import { dispatchMenu, registerMenu, registerMenuPrefix, unregisterMenu } from "./dispatch";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import { forgetRecent } from "@/features/connections/recent";

/**
 * Bind every menu id to a behavior. Most actions live on the Zustand store,
 * so the handlers just close over actions and selectors. Pure UI actions
 * (open the connection form, show the keyboard-shortcuts cheat-sheet) are
 * driven by the same store, via dedicated flags.
 */
export function registerAllMenuHandlers() {
  const s = () => useStore.getState();

  // ─── File ───
  registerMenu(MENU.NEW_CONNECTION, () => s().openConnectionForm());
  registerMenu(MENU.NEW_QUERY_TAB, () => {
    const id = s().selectedConnId;
    if (!id) return;
    s().addTab({
      id: crypto.randomUUID(),
      connId: id, kind: "query", title: "Query", sql: "",
    });
  });
  registerMenu(MENU.NEW_WINDOW, () => alert("New Window arrives in v2."));
  registerMenu(MENU.OPEN_SAVED_QUERY, () => alert("Saved queries arrive in v2."));
  registerMenu(MENU.SAVE_QUERY, async () => {
    const st = s();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.kind !== "query") return;
    const sql = tab.sql ?? "";
    if (!sql.trim()) return;
    const name = prompt("Name this saved query:", tab.title === "Query" ? "" : tab.title);
    if (!name) return;
    try {
      await api.saveSavedQuery({ id: null, conn_id: tab.connId, name, sql });
      st.bumpSavedQueries();
      st.updateTab(tab.id, { title: name });
    } catch (e) { alert(`Save failed: ${e}`); }
  });
  registerMenu(MENU.SAVE_QUERY_AS, async () => dispatchMenu(MENU.SAVE_QUERY));
  registerMenu(MENU.IMPORT, () => {
    if (!s().selectedConnId) return;
    s().openImport(null);
  });
  registerMenu(MENU.EXPORT, () => {
    if (!s().selectedConnId) return;
    s().openBulkExport(null);
  });
  registerMenu(MENU.CLOSE_TAB, () => {
    const a = s().activeTabId;
    if (a) s().closeTab(a);
  });

  // ─── Edit (Find/Replace target CodeMirror) ───
  registerMenu(MENU.FIND, () => focusEditor("find"));
  registerMenu(MENU.FIND_NEXT, () => focusEditor("findNext"));
  registerMenu(MENU.REPLACE, () => focusEditor("replace"));

  // ─── View ───
  registerMenu(MENU.COMMAND_PALETTE, () => s().togglePalette());
  registerMenu(MENU.TOGGLE_RAIL, () => s().togglePanel("rail"));
  registerMenu(MENU.TOGGLE_INSPECTOR, () => s().togglePanel("inspector"));
  registerMenu(MENU.TOGGLE_RESULTS, () => s().togglePanel("results"));
  registerMenu(MENU.NEXT_TAB, () => s().cycleTab(1));
  registerMenu(MENU.PREV_TAB, () => s().cycleTab(-1));

  // ─── Connection ───
  registerMenu(MENU.CONNECT, async () => {
    const id = s().selectedConnId; if (!id) return;
    s().setStatus(id, "connecting");
    try {
      await api.connect(id);
      s().setStatus(id, "connected");
      const tree = await api.introspect(id);
      s().setSchema(id, tree);
    } catch { s().setStatus(id, "error"); }
  });
  registerMenu(MENU.DISCONNECT, async () => {
    const id = s().selectedConnId; if (!id) return;
    await api.disconnect(id);
    s().setStatus(id, "disconnected");
  });
  registerMenu(MENU.MANAGE_CONNECTIONS, () => s().openConnectionManager());

  /**
   * Dynamic "Recent connection" entries (Connection menu). The id is
   * `conn.recent:<connectionId>` — the dispatcher passes the suffix
   * through, and we open a session against it. This mirrors the
   * EmptyTabArea's recents-card connect flow.
   */
  registerMenuPrefix(MENU.RECENT_CONNECTION_PREFIX, async (connectionId) => {
    if (!connectionId) return;
    const rec = s().connections.find((c) => c.id === connectionId);
    if (!rec) return;
    const sessionId = s().openSession(connectionId);
    s().setStatus(sessionId, "connecting");
    try {
      await api.connect(connectionId);
      s().setStatus(sessionId, "connected");
      const tree = await api.introspect(connectionId);
      s().setSchema(sessionId, tree);
    } catch (e) {
      s().setStatus(sessionId, "error");
      console.error(e);
    }
  });
  registerMenu(MENU.EDIT_CONNECTION, () => {
    const id = s().selectedConnId;
    if (id) s().openConnectionForm(id);
  });
  registerMenu(MENU.DUPLICATE_CONNECTION, async () => {
    const id = s().selectedConnId; if (!id) return;
    const c = s().connections.find((c) => c.id === id);
    if (!c) return;
    await api.saveConnection({
      id: null, name: `${c.name} copy`, engine: "postgres",
      host: c.host, port: c.port, username: c.username, password: null,
      database: c.database, ssl_mode: c.ssl_mode as never,
      ssh: null, color: c.color,
    });
    s().setConnections(await api.listConnections());
  });
  registerMenu(MENU.DELETE_CONNECTION, async () => {
    const sel = s().selectedConnId; if (!sel) return;
    // Resolve session→connection so we hit the right backend record.
    const sess = s().sessions.find((x) => x.id === sel);
    const connId = sess?.connectionId ?? sel;
    if (!confirm("Delete this connection? Stored secrets will be wiped.")) return;
    await api.deleteConnection(connId);
    forgetRecent(connId);
    s().setConnections(await api.listConnections());
    s().selectConn(null);
  });
  registerMenu(MENU.REFRESH_SCHEMA, async () => {
    const id = s().selectedConnId; if (!id) return;
    try { s().setSchema(id, await api.introspect(id)); } catch {}
  });

  // ─── Database ───
  registerMenu(MENU.DB_NEW,       () => s().openObjectOp({ kind: "db_new" }));
  registerMenu(MENU.DB_RENAME,    () => s().openObjectOp({ kind: "db_rename" }));
  registerMenu(MENU.DB_DUPLICATE, () => s().openObjectOp({ kind: "db_duplicate" }));
  registerMenu(MENU.DB_DROP,      () => s().openObjectOp({ kind: "db_drop" }));
  registerMenu(MENU.DB_MANAGE_ROLES, () => {
    const id = s().selectedConnId;
    if (!id) return;
    // If a Roles tab is already open for this connection, focus it instead
    // of opening another — roles state is global so a single tab is plenty.
    const existing = s().tabs.find((t) => t.kind === "roles" && t.connId === id);
    if (existing) { s().setActiveTab(existing.id); return; }
    s().addTab({
      id: crypto.randomUUID(),
      connId: id,
      kind: "roles",
      title: "Roles & grants",
    });
  });
  registerMenu(MENU.DB_ACTIVITY, () => {
    const id = s().selectedConnId;
    if (!id) return;
    s().addTab({
      id: crypto.randomUUID(),
      connId: id,
      kind: "activity",
      title: "Activity",
    });
  });
  registerMenu(MENU.DB_ER_DIAGRAM, () => {
    const id = s().selectedConnId;
    if (!id) return;
    const schemaName = s().activeSchema[id]
      ?? s().schemas[id]?.databases[0]?.schemas[0]?.name
      ?? "public";
    s().addTab({
      id: crypto.randomUUID(),
      connId: id,
      kind: "er_diagram",
      title: `ER · ${schemaName}`,
      sourceRelation: { schema: schemaName, table: "" },
    });
  });
  registerMenu(MENU.DB_COPY_TO, () => {
    const id = s().selectedConnId;
    if (!id) return;
    s().openCopy("database", { connId: id });
  });
  registerMenu(MENU.DB_SCHEMA_DIFF, () => {
    const id = s().selectedConnId;
    if (!id) return;
    const schemaName = s().activeSchema[id]
      ?? s().schemas[id]?.databases[0]?.schemas[0]?.name
      ?? "public";
    // Reuse an open diff tab on this connection if there is one.
    const existing = s().tabs.find((t) => t.kind === "schema_diff" && t.connId === id);
    if (existing) { s().setActiveTab(existing.id); return; }
    s().addTab({
      id: crypto.randomUUID(),
      connId: id,
      kind: "schema_diff",
      title: "Schema diff",
      sourceRelation: { schema: schemaName, table: "" },
    });
  });

  // ─── Table ───
  registerMenu(MENU.TABLE_NEW,         () => s().openObjectOp({ kind: "table_new" }));
  registerMenu(MENU.TABLE_RENAME,      () => withSelectedTable((sc, t) => s().openObjectOp({ kind: "table_rename", schema: sc, name: t })));
  registerMenu(MENU.TABLE_DUPLICATE,   () => withSelectedTable((sc, t) => s().openObjectOp({ kind: "table_duplicate", schema: sc, name: t })));
  registerMenu(MENU.TABLE_MOVE_SCHEMA, () => withSelectedTable((sc, t) => s().openObjectOp({ kind: "table_move", schema: sc, name: t })));
  registerMenu(MENU.TABLE_DROP,        () => withSelectedTable((sc, t) => s().openObjectOp({ kind: "table_drop", schema: sc, name: t })));
  registerMenu(MENU.TABLE_TRUNCATE,    () => withSelectedTable((sc, t) => runDirect(`TRUNCATE TABLE ${qi(sc)}.${qi(t)};`)));
  registerMenu(MENU.TABLE_VACUUM,      () => withSelectedTable((sc, t) => runDirect(`VACUUM (ANALYZE) ${qi(sc)}.${qi(t)};`)));
  registerMenu(MENU.TABLE_REINDEX,     () => withSelectedTable((sc, t) => runDirect(`REINDEX TABLE ${qi(sc)}.${qi(t)};`)));
  registerMenu(MENU.TABLE_COPY_NAME,   () => withSelectedTable(async (sc, t) => {
    await navigator.clipboard.writeText(`${qi(sc)}.${qi(t)}`);
  }));
  registerMenu(MENU.TABLE_COPY_CREATE, () => withSelectedTable((sc, t) => runDirect(
    `-- show DDL inline; v3 will use pg_dump -t ${qi(sc)}.${qi(t)}`,
  )));
  registerMenu(MENU.TABLE_COPY_TO, () => withSelectedTable((sc, t) => {
    const connId = s().selectedConnId;
    if (!connId) return;
    s().openCopy("table", { connId, schema: sc, table: t });
  }));

  // ─── Query ───
  registerMenu(MENU.QUERY_RUN_CURRENT, () => emitEditorAction("run"));
  registerMenu(MENU.QUERY_RUN_ALL,     () => emitEditorAction("run-all"));
  registerMenu(MENU.QUERY_CANCEL,      () => emitEditorAction("cancel"));
  registerMenu(MENU.QUERY_FORMAT,      () => emitEditorAction("format"));
  registerMenu(MENU.QUERY_EXPLAIN,     () => prefixActive("EXPLAIN "));
  registerMenu(MENU.QUERY_EXPLAIN_ANALYZE, () => prefixActive("EXPLAIN ANALYZE "));
  registerMenu(MENU.QUERY_TOGGLE_COMMENT,  () => emitEditorAction("toggle-comment"));
  registerMenu(MENU.QUERY_TOGGLE_LIMIT,    () => alert("Row limit toggle arrives in v2."));

  // ─── App / Help ───
  registerMenu(MENU.PREFERENCES, () => s().openPreferences());
  registerMenu(MENU.HELP_DOCS, () => {
    window.open("https://github.com/oesukam/nembrix/blob/main/README.md", "_blank");
  });
  registerMenu(MENU.HELP_SHORTCUTS, () => s().openShortcuts());
  registerMenu(MENU.HELP_CHECK_UPDATES, () => s().checkForUpdates());
  registerMenu(MENU.HELP_REPORT_ISSUE, () => {
    window.open("https://github.com/oesukam/nembrix/issues/new", "_blank");
  });
  registerMenu(MENU.HELP_ABOUT, () => s().openAbout());

  // Window menu is handled natively (minimize/maximize) — bring-to-front
  // is a no-op in browser.
  registerMenu(MENU.BRING_TO_FRONT, () => {});
  registerMenu(MENU.APP_RELOAD, () => window.location.reload());
}

export function unregisterAllMenuHandlers() {
  for (const id of Object.values(MENU)) unregisterMenu(id as never);
}

/* ────────────────── helpers ────────────────── */

function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function withSelectedTable(fn: (schema: string, table: string) => void | Promise<void>) {
  const s = useStore.getState();
  const sel = s.selectedTable;
  if (!sel) {
    alert("Right-click a table or select one in the inspector first.");
    return;
  }
  return fn(sel.schema, sel.name);
}

async function runDirect(sql: string) {
  const s = useStore.getState();
  const id = s.selectedConnId; if (!id) return;
  try {
    await api.execute(id, sql);
    if (s.schemas[id]) s.setSchema(id, await api.introspect(id));
  } catch (e) {
    alert(`Failed: ${e}`);
  }
}

function prefixActive(prefix: string) {
  const s = useStore.getState();
  const t = s.tabs.find((t) => t.id === s.activeTabId);
  if (!t) return;
  s.updateTab(t.id, { sql: prefix + (t.sql ?? "") });
}

/** Editor actions bubble via the store; QueryTab listens to `editorTick`. */
function emitEditorAction(a: "run" | "run-all" | "cancel" | "format" | "toggle-comment") {
  useStore.getState().fireEditorAction(a);
}

/** Hand off to editor-side find/replace. CodeMirror exposes these as commands. */
function focusEditor(_a: "find" | "findNext" | "replace") {
  emitEditorAction("run"); // placeholder — wired to CodeMirror commands next pass
}
