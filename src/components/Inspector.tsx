import { useEffect, useMemo, useState } from "react";
import {
  Search, Table2, Eye, FunctionSquare as FunctionIcon, ChevronDown,
  RefreshCcw, Plus, Trash2, Star, X,
} from "lucide-react";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import type { HistoryEntry, SavedQuery } from "@/ipc/types";
import ContextMenu, { type ContextItem } from "@/components/ContextMenu";
import Tooltip from "@/components/Tooltip";
import { isCollapsed, toggleCollapsed } from "@/components/inspector_prefs";
import {
  clearSlowQueries, loadSettings as loadSlowSettings, loadSlowQueries,
  saveSettings as saveSlowSettings, type SlowQueryEntry,
} from "@/features/query/slowQueries";

type ItemKind = "table" | "view" | "function";

interface InspectorItem {
  kind: ItemKind;
  name: string;
}

export default function Inspector() {
  const {
    selectedConnId,
    schemas,
    setSchema,
    status,
    inspectorView,
    setInspectorView,
    activeSchema,
    setActiveSchema,
    itemFilter,
    setItemFilter,
    addTab,
  } = useStore();

  // Group collapse state — resolved from the session's underlying
  // connection id so multiple sessions of the same connection share
  // the user's preference. Defaults: functions collapsed, others open.
  const realConnId = useMemo(() => {
    if (!selectedConnId) return null;
    const sess = useStore.getState().sessions.find((s) => s.id === selectedConnId);
    return sess?.connectionId ?? selectedConnId;
  }, [selectedConnId]);
  const [collapseTick, setCollapseTick] = useState(0);
  const isGroupCollapsed = (kind: ItemKind) =>
    realConnId ? isCollapsed(realConnId, kind) : (kind === "function");
  const toggleCollapseGroup = (kind: ItemKind) => {
    if (!realConnId) return;
    toggleCollapsed(realConnId, kind);
    setCollapseTick((t) => t + 1);
  };
  void collapseTick;
  const [ctx, setCtx] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);

  // Lazily load schema when a connection is selected and connected.
  useEffect(() => {
    if (!selectedConnId) return;
    if (status[selectedConnId] !== "connected") return;
    if (schemas[selectedConnId]) return;
    api.introspect(selectedConnId).then((t) => setSchema(selectedConnId, t)).catch(() => {});
  }, [selectedConnId, status, schemas, setSchema]);

  const tree = selectedConnId ? schemas[selectedConnId] : undefined;
  const db = tree?.databases[0];

  const currentSchemaName = selectedConnId
    ? activeSchema[selectedConnId] ?? db?.schemas[0]?.name
    : undefined;

  const currentSchema = useMemo(
    () => db?.schemas.find((s) => s.name === currentSchemaName),
    [db, currentSchemaName],
  );

  const groups = useMemo(() => {
    if (!currentSchema) return { table: [], view: [], function: [] } as Record<ItemKind, InspectorItem[]>;
    const f = itemFilter.toLowerCase();
    const pass = (n: string) => !f || n.toLowerCase().includes(f);
    return {
      table: currentSchema.tables.filter((t) => pass(t.name)).map((t) => ({ kind: "table" as const, name: t.name })),
      view: currentSchema.views.filter((v) => pass(v.name)).map((v) => ({ kind: "view" as const, name: v.name })),
      function: currentSchema.functions.filter((fn) => pass(fn.name)).map((fn) => ({ kind: "function" as const, name: fn.name })),
    };
  }, [currentSchema, itemFilter]);

  const openTable = (name: string) => {
    if (!selectedConnId || !currentSchemaName) return;
    // If there's already a table_data tab open for this session pointed
    // at the same relation, just focus it — opening a second tab for
    // the same table is almost never what the user wants. The existing
    // tab keeps its filters / sort / pinned rows; data refreshes on
    // re-focus because the run effect re-fires whenever the SQL signature
    // changes (and we bump editorTick to force a re-fetch).
    const existing = useStore.getState().tabs.find((t) =>
      t.kind === "table_data"
      && t.connId === selectedConnId
      && t.sourceRelation?.schema === currentSchemaName
      && t.sourceRelation?.table === name,
    );
    if (existing) {
      useStore.getState().setActiveTab(existing.id);
      // Bump the tab's refreshTick to force the run effect to re-fetch
      // even when filters / sort / limit haven't changed. Existing
      // filters stay intact — only the data is reloaded.
      useStore.getState().updateTab(existing.id, {
        refreshTick: (existing.refreshTick ?? 0) + 1,
      });
      return;
    }
    addTab({
      id: crypto.randomUUID(),
      connId: selectedConnId,
      kind: "table_data",
      title: name,
      sourceRelation: { schema: currentSchemaName, table: name },
      limit: 200,
    });
  };

  const onItemContextMenu = (e: React.MouseEvent, kind: ItemKind, name: string) => {
    e.preventDefault();
    if (!selectedConnId || !currentSchemaName) return;
    useStore.getState().selectTable({ schema: currentSchemaName, name });
    const schema = currentSchemaName;
    const items: ContextItem[] = [
      { label: "Open in new query tab",
        onClick: () => openTable(name) },
      { label: "Copy qualified name",
        onClick: () => navigator.clipboard.writeText(`"${schema}"."${name}"`) },
      { separator: true },
      { label: "Rename…",
        onClick: () => useStore.getState().openObjectOp({ kind: "table_rename", schema, name }) },
      { label: "Duplicate…",
        onClick: () => useStore.getState().openObjectOp({ kind: "table_duplicate", schema, name }) },
      { label: "Move to schema…",
        onClick: () => useStore.getState().openObjectOp({ kind: "table_move", schema, name }) },
      { separator: true },
      { label: "VACUUM ANALYZE",
        onClick: () => api.execute(selectedConnId, `VACUUM (ANALYZE) "${schema}"."${name}";`) },
      { label: "REINDEX",
        onClick: () => api.execute(selectedConnId, `REINDEX TABLE "${schema}"."${name}";`) },
      { separator: true },
      { label: "Copy to connection…",
        onClick: () => useStore.getState().openCopy("table", { connId: selectedConnId, schema, table: name }) },
      { separator: true },
      { label: "Drop…", danger: true,
        onClick: () => useStore.getState().openObjectOp({ kind: "table_drop", schema, name }) },
    ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  };

  const openQueryTab = () => {
    if (!selectedConnId) return;
    addTab({
      id: crypto.randomUUID(),
      connId: selectedConnId,
      kind: "query",
      title: "Query",
      sql: "",
    });
  };

  const refresh = async () => {
    if (!selectedConnId) return;
    try {
      const t = await api.introspect(selectedConnId);
      setSchema(selectedConnId, t);
    } catch {}
  };

  if (!selectedConnId) {
    return (
      <aside className="inspector">
        <div className="placeholder">
          <span className="muted">Select a connection on the left.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector-segments">
        <div className="segmented" role="tablist">
          <button
            className={inspectorView === "items" ? "active" : ""}
            onClick={() => setInspectorView("items")}
          >Items</button>
          <button
            className={inspectorView === "queries" ? "active" : ""}
            onClick={() => setInspectorView("queries")}
          >Queries</button>
          <button
            className={inspectorView === "history" ? "active" : ""}
            onClick={() => setInspectorView("history")}
          >History</button>
        </div>
      </div>

      {inspectorView === "items" && (
        <>
          <div className="inspector-search">
            <div className="search-wrap compact">
              <Search size={13} />
              <input
                className="search-input"
                placeholder="Search for item…"
                value={itemFilter}
                onChange={(e) => setItemFilter(e.target.value)}
                aria-label="Filter items"
              />
              {itemFilter && (
                <button
                  className="search-clear"
                  onClick={() => setItemFilter("")}
                  title="Clear"
                  aria-label="Clear search"
                  type="button"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <Tooltip label="New query tab" shortcut="⌘T">
              <button className="icon-btn" data-testid="new-query-btn" onClick={openQueryTab}>
                <Plus size={14} />
              </button>
            </Tooltip>
          </div>

          <div className="inspector-list">
            {(["function", "table", "view"] as ItemKind[]).map((kind) => {
              const items = groups[kind];
              if (!items.length) return null;
              const label = { table: "Tables", view: "Views", function: "Functions" }[kind];
              const groupCollapsed = isGroupCollapsed(kind);
              return (
                <div key={kind}>
                  <div
                    className={`item-group-header ${groupCollapsed ? "collapsed" : ""}`}
                    onClick={() => toggleCollapseGroup(kind)}
                  >
                    <ChevronDown size={12} className="chev" />
                    <span>{label}</span>
                    <span className="muted" style={{ marginLeft: "auto", fontSize: 10 }}>
                      {items.length}
                    </span>
                  </div>
                  {!groupCollapsed && items.map((it) => (
                    <div
                      key={it.name}
                      className="item-row"
                      onDoubleClick={() => kind !== "function" && openTable(it.name)}
                      onContextMenu={(e) => kind === "table" && onItemContextMenu(e, kind, it.name)}
                      title={it.name}
                    >
                      <span className="icon">
                        {kind === "table" && <Table2 size={12} />}
                        {kind === "view" && <Eye size={12} />}
                        {kind === "function" && <FunctionIcon size={12} />}
                      </span>
                      <span>{it.name}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {!tree && status[selectedConnId] !== "connected" && (
              <div className="placeholder" style={{ height: "auto", padding: 14 }}>
                <span className="muted">Not connected. Click ▶ in the status bar.</span>
              </div>
            )}
            {tree && !groups.table.length && !groups.view.length && !groups.function.length && (
              <div className="placeholder" style={{ height: "auto", padding: 14 }}>
                <span className="muted">No items match your filter.</span>
              </div>
            )}
          </div>

          <div className="inspector-footer">
            <Tooltip label="Refresh schema" shortcut="⌘R" side="top">
              <button className="icon-btn" onClick={refresh}>
                <RefreshCcw size={13} />
              </button>
            </Tooltip>
            <Tooltip label={`Create in ${currentSchemaName ?? "schema"}`} side="top">
              <button
                className="icon-btn"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const open = (req: typeof ctx extends infer T ? never : never) => {
                    void req;
                  };
                  void open;
                  setCtx({
                    x: rect.left,
                    y: rect.bottom + 2,
                    items: [
                      { label: "New Table",
                        onClick: () => useStore.getState().openObjectOp({ kind: "table_new" }) },
                      { label: "New View",
                        onClick: () => useStore.getState().openObjectOp({ kind: "view_new" }) },
                      { label: "New Materialized View",
                        onClick: () => useStore.getState().openObjectOp({ kind: "mview_new" }) },
                      { label: "New Function/Procedure",
                        onClick: () => useStore.getState().openObjectOp({ kind: "function_new" }) },
                      { separator: true },
                      { label: "New Schema…",
                        onClick: () => useStore.getState().openObjectOp({ kind: "schema_new" }) },
                    ],
                  });
                }}
                aria-label="New object…"
              >
                <Plus size={13} />
              </button>
            </Tooltip>
            <select
              className="schema-select"
              value={currentSchemaName ?? ""}
              onChange={(e) => setActiveSchema(selectedConnId, e.target.value)}
              aria-label="Schema"
            >
              {db?.schemas.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {inspectorView === "queries" && <SavedQueriesList connId={selectedConnId} />}
      {inspectorView === "history" && <QueryHistoryList connId={selectedConnId} />}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </aside>
  );
}

/* ────────────────────────── History list ──────────────────────────
   Reloads when the active tab's editor commits a Run (we re-fetch on
   `historyTick` from the store). Click a row → opens a new query tab
   with the SQL preloaded. */
function QueryHistoryList({ connId }: { connId: string }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [slow, setSlow] = useState<SlowQueryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // "all" pulls from the backend; "slow" reads the local slow-query log.
  const [scope, setScope] = useState<"all" | "slow">("all");
  const [slowSettings, setSlowSettings] = useState(loadSlowSettings());
  const tick = useStore((s) => s.historyTick);
  const addTab = useStore((s) => s.addTab);

  useEffect(() => {
    let cancelled = false;
    api.queryHistory(connId, 200)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    setSlow(loadSlowQueries().filter((e) => e.connId === connId));
    return () => { cancelled = true; };
  }, [connId, tick]);

  const filteredAll = useMemo(() => {
    if (!items) return [];
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter((h) => h.sql.toLowerCase().includes(f));
  }, [items, filter]);

  const filteredSlow = useMemo(() => {
    if (!filter) return slow;
    const f = filter.toLowerCase();
    return slow.filter((h) => h.sql.toLowerCase().includes(f));
  }, [slow, filter]);

  const openSqlTab = (sql: string) => {
    addTab({ id: crypto.randomUUID(), connId, kind: "query", title: "From history", sql });
  };

  return (
    <>
      <div className="inspector-search">
        <div className="search-wrap">
          <Search size={13} />
          <input
            className="search-input"
            placeholder="Filter history…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter history"
          />
        </div>
      </div>
      <div className="history-scope-row">
        <div className="segmented" role="tablist">
          <button
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >All</button>
          <button
            className={scope === "slow" ? "active" : ""}
            onClick={() => setScope("slow")}
            title={`Slow queries — anything over ${slowSettings.thresholdMs} ms`}
          >Slow ({filteredSlow.length})</button>
        </div>
        {scope === "slow" && (
          <div className="history-slow-controls">
            <label className="muted" style={{ fontSize: 11 }}>
              ≥{" "}
              <input
                type="number"
                value={slowSettings.thresholdMs}
                onChange={(e) => {
                  const next = { ...slowSettings, thresholdMs: Math.max(1, Number(e.target.value) || 0) };
                  setSlowSettings(next);
                  saveSlowSettings(next);
                }}
                style={{ width: 60 }}
                min={1}
              /> ms
            </label>
            <button
              className="btn-pill"
              onClick={() => { clearSlowQueries(); setSlow([]); }}
              title="Clear the local slow-query log"
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <div className="inspector-list">
        {err && scope === "all" && <div className="message-pane err" style={{ padding: 10 }}>{err}</div>}

        {scope === "all" && items != null && filteredAll.length === 0 && (
          <div className="placeholder muted" style={{ height: "auto", padding: 14 }}>
            {filter ? "No matches." : "No history yet — run some queries."}
          </div>
        )}
        {scope === "all" && filteredAll.map((h, i) => (
          <div
            key={`${h.run_at}-${i}`}
            className="history-row"
            title={`${h.elapsed_ms} ms · ${h.run_at}`}
            onClick={() => openSqlTab(h.sql)}
          >
            <span className="history-sql">{h.sql.replace(/\s+/g, " ").slice(0, 200)}</span>
            <span className="muted history-meta">{h.elapsed_ms} ms</span>
          </div>
        ))}

        {scope === "slow" && filteredSlow.length === 0 && (
          <div className="placeholder muted" style={{ height: "auto", padding: 14 }}>
            {filter
              ? "No matches."
              : `No slow queries (threshold ${slowSettings.thresholdMs} ms).`}
          </div>
        )}
        {scope === "slow" && filteredSlow.map((h) => (
          <div
            key={h.id}
            className="history-row"
            title={`${h.elapsedMs} ms · ${new Date(h.at).toLocaleString()}`}
            onClick={() => openSqlTab(h.sql)}
          >
            <span className="history-sql">{h.sql.replace(/\s+/g, " ").slice(0, 200)}</span>
            <span className="muted history-meta">{h.elapsedMs} ms</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ────────────────────────── Saved queries list ────────────────────── */
function SavedQueriesList({ connId }: { connId: string }) {
  const [items, setItems] = useState<SavedQuery[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const tick = useStore((s) => s.savedQueriesTick);
  const addTab = useStore((s) => s.addTab);

  useEffect(() => {
    let cancelled = false;
    api.listSavedQueries(connId)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [connId, tick]);

  const filtered = useMemo(() => {
    if (!items) return [];
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter((s) => s.name.toLowerCase().includes(f) || s.sql.toLowerCase().includes(f));
  }, [items, filter]);

  const openSavedTab = (q: SavedQuery) => {
    addTab({ id: crypto.randomUUID(), connId, kind: "query", title: q.name, sql: q.sql });
  };
  const remove = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteSavedQuery(id);
      useStore.getState().bumpSavedQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <>
      <div className="inspector-search">
        <div className="search-wrap">
          <Search size={13} />
          <input
            className="search-input"
            placeholder="Filter saved queries…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter saved queries"
          />
        </div>
      </div>
      <div className="inspector-list">
        {err && <div className="message-pane err" style={{ padding: 10 }}>{err}</div>}
        {items != null && filtered.length === 0 && (
          <div className="placeholder muted" style={{ height: "auto", padding: 14 }}>
            {filter ? "No matches." : "Save a query from the editor (⌘S) to see it here."}
          </div>
        )}
        {filtered.map((q) => (
          <div key={q.id} className="saved-row" onClick={() => openSavedTab(q)}>
            <Star size={11} className="muted" />
            <span className="saved-name">{q.name}</span>
            <span className="saved-sql muted">{q.sql.replace(/\s+/g, " ").slice(0, 60)}</span>
            <button className="icon-btn danger" onClick={(e) => remove(q.id, e)} title="Delete">
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
