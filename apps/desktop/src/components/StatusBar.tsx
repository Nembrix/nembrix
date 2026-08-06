/**
 * StatusBar — the slim band beneath the menu/banner that tells you,
 * at a glance, which connection is hot and how the current query went.
 *
 * Layout (left → right):
 *
 *   [🔒 lock]  [🛢 db]  [SQL]    [ ENV | engine ver : db : tab ]
 *
 *   - Lock: connect / disconnect the selected session in one click.
 *     Tinted by environment colour so the production rail spills
 *     into the toolbar without needing to read text.
 *   - DB picker: opens a small popover with the connection's other
 *     databases (TODO: wire to a real list; v1 just opens Manage
 *     Connections so the action isn't a dead end).
 *   - SQL: opens a fresh Query tab on the active connection. ⌘T
 *     does the same thing — this is the discoverable affordance.
 *   - Pill: ENV | PostgreSQL <ver> · db · tab · running/elapsed.
 *     Mirrors what the title bar used to say but lives where the
 *     eye lands when looking at "which connection am I about to
 *     mutate?".
 *
 * Hidden entirely when there's no selected connection — at that
 * point the empty-state in the main area is more useful than a
 * "no connection" placeholder up here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Unlock, Database, FileCode2, RefreshCcw, Table2, Eye, ChevronDown, Search, X } from "lucide-react";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import Tooltip from "@/components/Tooltip";
import { colorFor, ENV_LABEL } from "@/features/connections/environment";
import { engineLabel } from "@/features/connections/engines";
import { isTauri } from "@/ipc/commands";

export default function StatusBar() {
  const {
    connections, status, setSchema, selectedConnId,
    tabs, activeTabId, addTab, openConnectionManager, sessions,
    schemas, activeSchema, setActiveSchema, updateTab, setActiveTab,
    readOnly, setReadOnly,
  } = useStore();

  // `selectedConnId` is a *session* id when one is open — sessions sit on
  // top of connections and have their own status. Resolve through the
  // sessions table so the bar renders for both a raw connection and a
  // live session. The original code looked up connections directly and
  // got `undefined` for sessions, leaving the title-bar strip empty.
  const conn = useMemo(() => {
    if (!selectedConnId) return undefined;
    const direct = connections.find((c) => c.id === selectedConnId);
    if (direct) return direct;
    const sess = sessions.find((s) => s.id === selectedConnId);
    return sess ? connections.find((c) => c.id === sess.connectionId) : undefined;
  }, [connections, sessions, selectedConnId]);
  // Status keys vary by mode — sessions store status under the session
  // id, raw connections under the connection id. Try both.
  const statusKey = selectedConnId ?? conn?.id;

  // ALL hooks must be declared above the conditional early return below.
  // Putting hooks after the early-return tripped the Rules of Hooks and
  // caused the window to blink + go blank when `conn` toggled between
  // null and a value (mounting/unmounting a different number of hooks
  // each render).
  const [refreshing, setRefreshing] = useState(false);
  const [dbMenuOpen, setDbMenuOpen] = useState(false);
  const [dbFilter, setDbFilter] = useState("");
  const dbWrapRef = useRef<HTMLDivElement>(null);
  const dbSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dbMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!dbWrapRef.current?.contains(e.target as Node)) setDbMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [dbMenuOpen]);
  // Reset the filter and focus the search box each time the menu opens so
  // the user can start typing immediately without a stale query.
  useEffect(() => {
    if (dbMenuOpen) {
      setDbFilter("");
      dbSearchRef.current?.focus();
    }
  }, [dbMenuOpen]);

  // Always render the bar — in Tauri it doubles as the draggable
  // title-bar strip, and in dev/browser mode it gives the developer a
  // persistent place to read connection state. When no conn is
  // selected we show a muted "No connection" hint instead of vanishing.
  if (!conn) {
    return (
      <div className="status-bar status-bar-empty">
        {!isTauri && <span className="muted" style={{ fontSize: 11 }}>No connection selected</span>}
      </div>
    );
  }

  // Prefer the session-scoped status (live, per-tab), fall back to the
  // raw connection-level status. Either is enough to tint the lock.
  const st = (statusKey ? status[statusKey] : undefined) ?? status[conn.id] ?? "disconnected";
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const envRing = colorFor(conn.environment ?? undefined, conn.color);
  const envLabel = conn.environment
    ? ENV_LABEL[conn.environment as keyof typeof ENV_LABEL]
    : "";
  // Display name for the connection's engine (the pill was hardcoded to
  // "PostgreSQL") — from the central engine registry so it stays in sync.
  const engineName = engineLabel(conn.engine);
  const isMongo = conn.engine === "mongo";

  const newQueryTab = () => {
    addTab({
      id: crypto.randomUUID(),
      connId: statusKey ?? conn.id,
      kind: "query",
      title: "Query",
      sql: "",
    });
  };

  // Refresh handler (state declared above the early return).
  const refreshSchema = async () => {
    if (refreshing) return;
    const key = statusKey ?? conn.id;
    setRefreshing(true);
    try {
      const tree = await api.introspect(key);
      setSchema(key, tree);
    } catch { /* error surfaces in the inspector's own state */ }
    finally { setRefreshing(false); }
  };

  const dbTree = statusKey ? schemas[statusKey] : undefined;
  const dbSchemas = dbTree?.databases[0]?.schemas ?? [];
  const currentSchemaName = statusKey
    ? activeSchema[statusKey] ?? dbSchemas[0]?.name
    : undefined;
  const currentSchemaNode = dbSchemas.find((s) => s.name === currentSchemaName);

  // Case-insensitive substring filter, applied to schemas, tables and
  // views alike. Mirrors the Inspector's `itemFilter` matching so the two
  // search boxes behave the same.
  const f = dbFilter.trim().toLowerCase();
  const matches = (name: string) => !f || name.toLowerCase().includes(f);
  const filteredSchemas = dbSchemas.filter((s) => matches(s.name));
  const filteredTables = currentSchemaNode?.tables.filter((t) => matches(t.name)) ?? [];
  const filteredViews = currentSchemaNode?.views.filter((v) => matches(v.name)) ?? [];
  const hasResults =
    filteredTables.length > 0 || filteredViews.length > 0
    || (dbSchemas.length > 1 && filteredSchemas.length > 0);

  const openTableFromMenu = (schema: string, name: string) => {
    const sessKey = statusKey;
    if (!sessKey) return;
    setDbMenuOpen(false);
    // Focus an existing tab for this relation if one is open, mirroring
    // the Inspector's behaviour so we don't spawn duplicate tabs.
    const existing = tabs.find((t) =>
      t.kind === "table_data"
      && t.connId === sessKey
      && t.sourceRelation?.schema === schema
      && t.sourceRelation?.table === name,
    );
    if (existing) {
      if (activeTabId !== existing.id) setActiveTab(existing.id);
      updateTab(existing.id, { refreshTick: (existing.refreshTick ?? 0) + 1 });
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      connId: sessKey,
      kind: "table_data",
      title: name,
      sourceRelation: { schema, table: name },
    });
  };

  return (
    <div className="status-bar" style={{ ["--env-ring" as never]: envRing }}>
      <div className="status-actions">
        {(() => {
          const ro = statusKey ? !!readOnly[statusKey] : false;
          return (
            <Tooltip label={ro ? "Read-only — click to allow writes" : "Click to switch to read-only"}>
              <button
                className={`status-action status-lock ${st} ${ro ? "ro" : ""}`}
                data-testid="status-readonly"
                onClick={() => statusKey && setReadOnly(statusKey, !ro)}
                disabled={st !== "connected"}
                aria-label={ro ? "Read-only on" : "Read-only off"}
              >
                {ro ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </Tooltip>
          );
        })()}

        <div className="status-db-wrap" ref={dbWrapRef}>
          <Tooltip label="Browse tables">
            <button
              className="status-action"
              onClick={() => setDbMenuOpen((o) => !o)}
              aria-label="Browse tables"
              disabled={st !== "connected"}
            >
              <Database size={14} />
              <ChevronDown size={10} style={{ marginLeft: 1 }} />
            </button>
          </Tooltip>
          {dbMenuOpen && (
            <div className="status-db-menu" role="menu">
              {/* Refresh progress — a thin indeterminate bar that appears
                  while introspection is in flight, so the menu shows the
                  connection is doing work rather than looking frozen. */}
              {refreshing && (
                <div className="status-db-progress" role="progressbar" aria-label="Refreshing schema">
                  <div className="status-db-progress-bar" />
                </div>
              )}

              {/* Search box — filters schemas, tables and views as you type. */}
              <div className="status-db-search">
                <div className="search-wrap compact">
                  <Search size={12} />
                  <input
                    ref={dbSearchRef}
                    className="search-input"
                    type="text"
                    placeholder="Search tables…"
                    value={dbFilter}
                    onChange={(e) => setDbFilter(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setDbFilter(""); }}
                    aria-label="Search tables"
                  />
                  {dbFilter && (
                    <button
                      className="search-clear"
                      onClick={() => { setDbFilter(""); dbSearchRef.current?.focus(); }}
                      aria-label="Clear search"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              {dbSchemas.length === 0 && !refreshing && (
                <div className="muted" style={{ padding: 10, fontSize: 11 }}>
                  No schema cached yet — try refreshing.
                </div>
              )}
              {dbSchemas.length > 0 && !hasResults && !refreshing && (
                <div className="muted" style={{ padding: 10, fontSize: 11 }}>
                  No matches for “{dbFilter}”.
                </div>
              )}
              {dbSchemas.length > 1 && filteredSchemas.length > 0 && (
                <>
                  <div className="status-db-section">Schema</div>
                  {filteredSchemas.map((s) => (
                    <div
                      key={s.name}
                      className={`status-db-schema ${s.name === currentSchemaName ? "active" : ""}`}
                      onClick={() => statusKey && setActiveSchema(statusKey, s.name)}
                    >
                      {s.name}
                    </div>
                  ))}
                </>
              )}
              {currentSchemaNode && (filteredTables.length > 0 || filteredViews.length > 0) && (
                <>
                  <div className="status-db-section">Tables · {currentSchemaName}</div>
                  {filteredTables.map((t) => (
                    <div
                      key={`t-${t.name}`}
                      className="status-db-item"
                      onClick={() => openTableFromMenu(currentSchemaNode.name, t.name)}
                      title={t.name}
                    >
                      <span className="icon"><Table2 size={12} /></span>
                      <span>{t.name}</span>
                    </div>
                  ))}
                  {filteredViews.length > 0 && (
                    <>
                      <div className="status-db-section">Views</div>
                      {filteredViews.map((v) => (
                        <div
                          key={`v-${v.name}`}
                          className="status-db-item"
                          onClick={() => openTableFromMenu(currentSchemaNode.name, v.name)}
                          title={v.name}
                        >
                          <span className="icon"><Eye size={12} /></span>
                          <span>{v.name}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
              <div className="status-db-section" style={{ borderTop: "1px solid var(--border-soft)", marginTop: 4 }}>
                <span
                  style={{ cursor: "pointer", color: "var(--accent)" }}
                  onClick={() => { setDbMenuOpen(false); openConnectionManager(); }}
                >
                  Manage connections…
                </span>
              </div>
            </div>
          )}
        </div>

        <Tooltip label={`New ${isMongo ? "query" : "SQL"} tab`} shortcut="⌘T">
          <button
            className="status-action status-sql"
            onClick={newQueryTab}
            aria-label={`New ${isMongo ? "query" : "SQL"} tab`}
          >
            <FileCode2 size={12} />
            <span>{isMongo ? "Query" : "SQL"}</span>
          </button>
        </Tooltip>
      </div>

      <div className={`status-pill ${st}`} title={`${conn.name} (${conn.host}:${conn.port})`}>
        {envLabel && (
          <span className="pill-env">{envLabel.toUpperCase()}</span>
        )}
        <span className="pill-sep">·</span>
        <span className="pill-engine">{engineName}</span>
        {conn.database && (
          <>
            <span className="pill-sep">:</span>
            <span className="pill-db">{conn.database}</span>
          </>
        )}
        {activeTab && (
          <>
            <span className="pill-sep">·</span>
            <span className="pill-tab">{activeTab.title}</span>
          </>
        )}
        {/* Row count + elapsed time intentionally omitted here — the
            record-level toolbar under the grid already shows "N of M rows"
            and the running timer, so repeating them in the status pill was
            redundant noise. */}
      </div>

      <Tooltip label={refreshing ? "Refreshing…" : "Refresh schema"} shortcut="⌘R">
        <button
          className={`status-action status-refresh ${refreshing ? "spinning" : ""}`}
          onClick={() => void refreshSchema()}
          disabled={st !== "connected" || refreshing}
          aria-label="Refresh schema"
        >
          <RefreshCcw size={13} />
        </button>
      </Tooltip>

      {/* Connection-wide progress — an indeterminate bar along the bottom
          edge of the status bar while a refresh/introspect is in flight.
          Visible whether or not the DB menu is open, so clicking Refresh
          always gives feedback that the connection is working. */}
      {refreshing && (
        <div className="status-bar-progress" role="progressbar" aria-label="Refreshing connection">
          <div className="status-bar-progress-bar" />
        </div>
      )}
    </div>
  );
}
