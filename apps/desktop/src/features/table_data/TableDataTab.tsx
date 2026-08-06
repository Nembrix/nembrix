import { useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCcw, Eye, EyeOff, ArrowUpDown, ArrowUp, ArrowDown, Filter as FilterIcon, BarChart3,
  Database, KeyRound, Info, Download, Search, Plus,
} from "lucide-react";
import { useStore, type Tab, type FilterChip } from "@/store";
import * as api from "@/ipc/commands";
import { buildMongoFind } from "./buildTableQuery";
import DataGrid from "@/components/DataGrid";
import FilterBuilder from "@/features/grid/FilterBuilder";
import ChartPane from "@/features/grid/ChartPane";
import { matches } from "@/features/grid/quick-search";
import ColumnAlterDialog, { type AlterField } from "@/features/table_data/ColumnAlterDialog";
import AddColumnDialog from "@/features/table_data/AddColumnDialog";
import ExportDialog from "@/features/export/ExportDialog";
import RunningTimer from "@/components/RunningTimer";
import ErrorBoundary from "@/components/ErrorBoundary";
import { enumValuesFor } from "@/features/table_data/enum_values";
import { fetchEstimate, fetchExact, fetchMongoCount } from "@/features/table_data/row_count";
import { formatBytes, useTableStats } from "@/features/table_data/useTableStats";
import type { ColumnNode, RelationNode } from "@/ipc/types";

type ResultView = "data" | "structure" | "indexes" | "info" | "chart";

/**
 * Pure-GUI table data view. No SQL editor. Runs `SELECT * FROM rel` (or
 * a tweaked variant honoring filters / sort / limit) every time the user
 * touches a control. The grid offers column show/hide, filter chips, sort,
 * row pinning, FK navigation, and the chart tab.
 */
export default function TableDataTab({ tab }: { tab: Tab }) {
  const { updateTab, appendBatch, schemas } = useStore();
  // Subscribe to this session's connection status. On app restart a tab is
  // restored before its connection pool is re-established (reconnect runs
  // as a background promise), so a query fired on mount races the
  // reconnect and hits "not connected". We gate the run on this status and
  // re-run once it flips to "connected". undefined = never-set (treat as
  // ready, e.g. the browser/mock path that has no status).
  const connStatus = useStore((s) => s.status[tab.connId]);
  const [view, setView] = useState<ResultView>("data");
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [alterDialog, setAlterDialog] = useState<{ col: ColumnNode; field: AlterField } | null>(null);
  const [addColOpen, setAddColOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<string | null>(null);
  /** Bumped each time the data query runs so an in-flight exact-count
   *  for a previous query can be discarded (sequence-number guard). */
  const countSeqRef = useRef(0);

  // ⌘F focuses the search input — same shortcut the editor uses for find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Only steal ⌘F when this tab is the active one.
        const active = useStore.getState().activeTabId;
        if (active === tab.id) {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab.id]);
  const rel = tab.sourceRelation;
  const limit = tab.limit ?? 200;
  // Stabilize array refs so the SQL-rebuild effect doesn't fire on every render.
  const filters = useMemo(() => tab.filters ?? [], [tab.filters]);
  const hidden = useMemo(() => tab.hiddenColumns ?? [], [tab.hiddenColumns]);

  /** Live relation metadata from the schema cache. */
  const relationMeta = useMemo<RelationNode | undefined>(() => {
    if (!rel) return undefined;
    const tree = schemas[tab.connId];
    const db = tree?.databases[0];
    const sc = db?.schemas.find((s) => s.name === rel.schema);
    return sc?.tables.find((t) => t.name === rel.table)
        ?? sc?.views.find((v) => v.name === rel.table);
  }, [schemas, tab.connId, rel]);

  // Resolve the connection's engine (session → connectionId → connection) so
  // the query is built in the right dialect — SQL vs Mongo's shell command.
  // Subscribe to sessions/connections (not a one-shot getState) so the engine
  // resolves once they hydrate — a table tab can mount before the connection
  // list is populated, and a stale `undefined` here would wrongly build SQL
  // for a Mongo connection.
  const sessions = useStore((s) => s.sessions);
  const conns = useStore((s) => s.connections);
  const engine = useMemo(() => {
    const session = sessions.find((s) => s.id === tab.connId);
    const connectionId = session?.connectionId ?? tab.connId;
    return conns.find((c) => c.id === connectionId)?.engine;
  }, [tab.connId, sessions, conns]);
  const sql = useMemo(
    () =>
      !rel
        ? ""
        : engine === "mongo"
          ? buildMongoFind(rel, filters, tab.sort, limit)
          : buildSql(rel, filters, tab.sort, limit),
    [engine, rel, filters, tab.sort, limit],
  );

  const run = async () => {
    if (!rel) return;
    const started = performance.now();
    updateTab(tab.id, {
      columns: undefined, rows: [], running: true, error: undefined,
      queryStartedAt: started, elapsedMs: undefined,
    });
    try {
      handleRef.current = await api.stream(tab.connId, sql, (b) => {
        appendBatch(tab.id, b);
        if (b.done) {
          updateTab(tab.id, {
            elapsedMs: Math.round(performance.now() - started),
            running: false,
          });
          useStore.getState().bumpHistory();
        }
      });
    } catch (e) {
      updateTab(tab.id, { running: false, error: String(e) });
    }
  };

  // Run when the SQL signature changes, OR when refreshTick is bumped
  // externally (e.g. the inspector re-clicks the same table). Guard with
  // a ref so React's StrictMode double-invoke in dev doesn't dispatch
  // the stream twice (which would double the rows in the grid).
  //
  // We do NOT gate on connection status: gating held the query in the
  // normal open-a-table flow (the tab mounts before the session's status
  // has settled to "connected"), leaving the grid stuck on "No results".
  // Instead we always run, and separately re-run if a "not connected" error
  // resolves once the session connects (the effect below).
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${sql}#${tab.refreshTick ?? 0}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, tab.refreshTick]);

  // Reconnect recovery: on app restart a restored tab may run its query
  // before the session's pool is re-established, failing with "not
  // connected". When the session later flips to "connected", re-run so the
  // grid fills itself instead of showing a stale error (what Refresh did
  // manually). Only re-fires on a genuine not-connected failure, so it never
  // interferes with the normal open-a-table flow.
  useEffect(() => {
    if (connStatus === "connected" && /not connected/i.test(tab.error ?? "")) {
      lastKeyRef.current = null; // force the run effect's key check to re-dispatch
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connStatus, tab.error]);

  /**
   * Two-phase row count. Fires after the data stream finishes (we use
   * `lastSqlRef` as a proxy for "the data run completed"). The estimate
   * is shown immediately; the exact count replaces it when it lands.
   *
   * countSeqRef guards against a later re-run racing the previous
   * exact-count callback — only the most-recent fetch wins.
   */
  useEffect(() => {
    if (!rel || tab.running || (tab.columns?.length ?? 0) === 0) return;
    const seq = ++countSeqRef.current;
    let cancelled = false;

    // Reset to "loading"; the estimate query lands within ~5ms typically.
    updateTab(tab.id, { rowsTotal: undefined, rowsTotalEstimated: undefined });

    // Mongo has no pg_class estimate + COUNT(*) pair — use a single
    // countDocuments(<filterDoc>) that matches the visible rows exactly.
    if (engine === "mongo") {
      void (async () => {
        const n = await fetchMongoCount(tab.connId, rel, filters);
        if (cancelled || countSeqRef.current !== seq) return;
        if (n != null) updateTab(tab.id, { rowsTotal: n, rowsTotalEstimated: false });
      })();
      return () => { cancelled = true; };
    }

    const whereClause = buildWhereClause(filters);

    void (async () => {
      // Phase 1 — fast estimate. Skip when filters are active because
      // the estimate is unfiltered and would be misleading.
      if (!whereClause) {
        const est = await fetchEstimate(tab.connId, rel.schema, rel.table);
        if (cancelled || countSeqRef.current !== seq) return;
        if (est != null) updateTab(tab.id, { rowsTotal: est, rowsTotalEstimated: true });
      }
      // Phase 2 — exact count (timeout-guarded). Replaces the estimate
      // when it arrives. If the COUNT times out we keep the estimate.
      const exact = await fetchExact(tab.connId, rel.schema, rel.table, whereClause || undefined);
      if (cancelled || countSeqRef.current !== seq) return;
      if (exact != null) updateTab(tab.id, { rowsTotal: exact, rowsTotalEstimated: false });
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.running, sql, tab.connId, rel?.schema, rel?.table]);

  if (!rel) {
    return (
      <div className="placeholder">
        <span className="muted">This data view is missing its source relation.</span>
      </div>
    );
  }

  // Build the "visible-only" tab snapshot the grid renders. We don't mutate the
  // stored columns/rows — DataGrid honors a transient prop.
  const visible = filterVisible(tab, hidden, search);

  const toggleColumn = (name: string) => {
    const next = hidden.includes(name)
      ? hidden.filter((n) => n !== name)
      : [...hidden, name];
    updateTab(tab.id, { hiddenColumns: next });
  };
  const allShown = () => updateTab(tab.id, { hiddenColumns: [] });
  const allHidden = () => updateTab(tab.id, {
    hiddenColumns: (tab.columns ?? []).map((c) => c.name),
  });

  const cycleSort = (column: string) => {
    const cur = tab.sort;
    if (!cur || cur.column !== column) {
      updateTab(tab.id, { sort: { column, dir: "asc" } });
    } else if (cur.dir === "asc") {
      updateTab(tab.id, { sort: { column, dir: "desc" } });
    } else {
      updateTab(tab.id, { sort: undefined });
    }
  };

  return (
    <div className="editor-shell">
      {/* ─── 1. View tabs ─── primary navigation, controls what every
            other toolbar in this tab applies to. */}
      <div className="result-segments">
        <div className="segmented" role="tablist">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>
            <FilterIcon size={11} style={{ marginRight: 4 }} />Data
          </button>
          <button className={view === "structure" ? "active" : ""} onClick={() => setView("structure")}>
            <Database size={11} style={{ marginRight: 4 }} />Structure
          </button>
          <button className={view === "indexes" ? "active" : ""} onClick={() => setView("indexes")}>
            <KeyRound size={11} style={{ marginRight: 4 }} />Indexes
          </button>
          <button className={view === "info" ? "active" : ""} onClick={() => setView("info")}>
            <Info size={11} style={{ marginRight: 4 }} />Info
          </button>
          <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
            <BarChart3 size={11} style={{ marginRight: 4 }} />Chart
          </button>
        </div>
        <span className="meta">
          {view === "data" && filters.length > 0 && `${filters.length} filter${filters.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* ─── 2. Filters ─── (Data view only) the filters determine what
            the row count and grid below show, so they live above. */}
      {view === "data" && (
        <FilterBuilder
          columns={tab.columns ?? []}
          filters={filters}
          onApply={(next) => updateTab(tab.id, { filters: next })}
        />
      )}

      {/* ─── 3. Record-level toolbar ─── row count, search, Limit, Sort,
            Columns, Export, Refresh. The schema.table name lives in
            the tab title above; duplicating it here was just noise. */}
      <div className="data-view-toolbar">
        <span className="muted">
          {(() => {
            const loaded = tab.rows?.length ?? 0;
            const total = tab.rowsTotal;
            const totalSuffix = total != null
              ? ` of ${total.toLocaleString()}${tab.rowsTotalEstimated ? " (est.)" : ""}`
              : "";
            if (search.trim() && tab.rows) {
              return `${matches(search.trim(), tab.rows).length} / ${loaded}${totalSuffix} rows`;
            }
            return `${loaded}${totalSuffix} row${loaded === 1 ? "" : "s"}`;
          })()}
        </span>
        <RunningTimer
          running={tab.running}
          startedAt={tab.queryStartedAt}
          elapsedMs={tab.elapsedMs}
          prefix="· "
        />

        {/* +Row appends a draft row to the grid (no DB write yet).
            The user fills cells inline; Save All commits every draft
            row alongside any pending cell edits in one transaction.
            That way tables with NOT NULL columns and no defaults
            don't error on insertion — the user can supply the
            required values before saving. */}
        {(() => {
          const ro = !!useStore.getState().readOnly[tab.connId];
          return (
            <button
              className="btn-pill"
              onClick={() => {
                if (!rel) return;
                const drafts = tab.pendingInserts ?? [];
                updateTab(tab.id, { pendingInserts: [...drafts, {}] });
              }}
              title={ro
                ? "Connection is read-only — unlock it in the status bar"
                : "Append a draft row — fill cells, then Save All to commit"}
              disabled={!rel || ro}
            >
              <Plus size={12} /> Row
            </button>
          );
        })()}

        <div className="spacer" />

        <div className="grid-quick-search">
          <Search size={12} />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search loaded rows…"
            title="Substring search across the rows already loaded — for a SQL-level filter use the Filter chips above"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); searchRef.current?.blur(); } }}
            data-testid="grid-search"
          />
          {search && (
            <button className="grid-quick-search-clear" onClick={() => setSearch("")} title="Clear">×</button>
          )}
        </div>

        <label className="muted">Limit</label>
        <select value={limit} onChange={(e) => updateTab(tab.id, { limit: parseInt(e.target.value) })}>
          {[50, 200, 500, 1000, 5000, 10000].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>

        <SortPill sort={tab.sort} columns={tab.columns ?? []} onCycle={cycleSort}
          onClear={() => updateTab(tab.id, { sort: undefined })} />

        <div className="col-menu-wrap">
          <button className="btn-pill" onClick={() => setColMenuOpen(!colMenuOpen)}>
            <Eye size={12} /> Columns{hidden.length ? ` (${hidden.length})` : ""}
          </button>
          {colMenuOpen && (
            <div className="col-menu" onMouseLeave={() => setColMenuOpen(false)}>
              <div className="col-menu-actions">
                <button className="btn-link" onClick={allShown}>Show all</button>
                <button className="btn-link" onClick={allHidden}>Hide all</button>
              </div>
              <div className="col-menu-list">
                {(tab.columns ?? []).map((c) => {
                  const isHidden = hidden.includes(c.name);
                  return (
                    <div className="col-menu-row" key={c.name} onClick={() => toggleColumn(c.name)}>
                      {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                      <span className={isHidden ? "muted" : ""}>{c.name}</span>
                      <span className="muted type">{c.type_name.toUpperCase()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <button className="btn-pill" onClick={() => setExportOpen(true)} title="Export…">
          <Download size={12} /> Export
        </button>
        <button className="btn-pill" onClick={run} title="Refresh">
          <RefreshCcw size={12} /> Refresh
        </button>
      </div>

      {/* ─── 4. Content ─── */}
      <div className="result-shell" style={{ flex: 1 }}>
        <div className="result-body">
          {view === "data" && (tab.error
            ? <div className="message-pane err">{tab.error}</div>
            : <DataGrid tab={visible} engine={engine} />)}
          {view === "structure" && (
            <ErrorBoundary label="Structure">
              <StructurePane
                rel={relationMeta}
                onAddColumn={() => setAddColOpen(true)}
                onEdit={(col, field) => setAlterDialog({ col, field })}
                connId={tab.connId}
                schema={rel?.schema ?? ""}
                table={rel?.table ?? ""}
                engine={engine}
              />
            </ErrorBoundary>
          )}
          {view === "indexes" && (
            <ErrorBoundary label="Indexes">
              <IndexesPane
                rel={relationMeta}
                connId={tab.connId}
                schema={rel?.schema ?? ""}
                table={rel?.table ?? ""}
                engine={engine}
                onAddIndex={() => addIndex(tab, rel)}
              />
            </ErrorBoundary>
          )}
          {view === "info" && (
            <ErrorBoundary label="Info">
              <InfoPane
                rel={relationMeta}
                connId={tab.connId}
                schema={rel?.schema ?? ""}
                table={rel?.table ?? ""}
                engine={engine}
              />
            </ErrorBoundary>
          )}
          {view === "chart" && visible.columns && visible.rows && (
            <ChartPane columns={visible.columns} rows={visible.rows} />
          )}
        </div>
      </div>
      {alterDialog && rel && (
        <ColumnAlterDialog
          connId={tab.connId}
          schema={rel.schema}
          table={rel.table}
          column={alterDialog.col}
          field={alterDialog.field}
          onClose={() => setAlterDialog(null)}
        />
      )}
      {addColOpen && rel && (
        <AddColumnDialog
          connId={tab.connId}
          schema={rel.schema}
          table={rel.table}
          onClose={() => setAddColOpen(false)}
        />
      )}
      {exportOpen && tab.columns && tab.rows && (
        <ExportDialog
          source={rel}
          connId={tab.connId}
          columns={tab.columns}
          rows={tab.rows}
          onClose={() => setExportOpen(false)}
        />
      )}
      {/* rel here is tab.sourceRelation ({schema, table}), distinct from the
          schema-cache RelationNode (relationMeta) — both are needed. */}
    </div>
  );
}

/** Common Postgres types in the dropdown. Free text after the divider so
 *  the user can still type a parameterized or custom type. */
const COMMON_PG_TYPES = [
  "text", "varchar", "varchar(255)",
  "integer", "bigint", "smallint", "numeric", "real", "double precision",
  "boolean",
  "uuid",
  "date", "timestamp", "timestamptz", "time", "interval",
  "json", "jsonb",
  "bytea",
  "inet", "cidr", "macaddr",
];

function StructurePane({
  rel, onAddColumn, onEdit, connId, schema, table, engine,
}: {
  rel?: RelationNode;
  onAddColumn: () => void;
  /** Used only for fields where a preview dialog is still appropriate. */
  onEdit: (col: ColumnNode, field: AlterField) => void;
  connId: string;
  schema: string;
  table: string;
  engine?: string;
}) {
  const [errByCol, setErrByCol] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  // Mongo has no ALTER/DDL and a fluid, per-document schema. The columns here
  // are inferred from a sample; showing SQL type/nullable/default editors (or
  // Add column) would send pg DDL the Mongo driver rejects. Render a
  // read-only, inferred-schema view instead.
  const isMongo = engine === "mongo";

  if (!rel) return <div className="placeholder muted">No structure metadata yet — reconnect to refresh.</div>;

  if (isMongo) {
    return (
      <div className="pane">
        <div className="pane-toolbar">
          <strong>Fields</strong>
          <span className="muted">{rel.columns.length}</span>
        </div>
        <p className="muted" style={{ margin: "0 0 6px", fontSize: 11 }}>
          Inferred from a sample of documents — MongoDB collections have no
          fixed schema, so fields and types can vary per document. Editing the
          structure here isn't available; change documents directly in the
          Data view.
        </p>
        <table className="meta-table">
          <thead><tr>
            <th>Field</th><th>Type</th><th>Nullable</th><th>Key</th>
          </tr></thead>
          <tbody>
            {rel.columns.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="mono">{c.type_name.toUpperCase()}</td>
                <td>{c.nullable ? "YES" : "NOT NULL"}</td>
                <td>{rel.primary_key.includes(c.name) ? <span className="kbd">PK</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const refresh = async () => {
    try {
      const t = await api.introspect(connId);
      useStore.getState().setSchema(connId, t);
    } catch { /* ignore: best-effort */ }
  };

  const runAlter = async (col: ColumnNode, sql: string) => {
    setPending(col.name);
    setErrByCol((m) => { const { [col.name]: _, ...rest } = m; return rest; });
    try {
      await api.execute(connId, sql);
      await refresh();
    } catch (e) {
      setErrByCol((m) => ({ ...m, [col.name]: String(e) }));
    } finally {
      setPending(null);
    }
  };

  const toggleNullable = (c: ColumnNode) => {
    const verb = c.nullable ? "SET NOT NULL" : "DROP NOT NULL";
    runAlter(
      c,
      `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${c.name}" ${verb};`,
    );
  };

  const changeType = (c: ColumnNode, newType: string) => {
    if (!newType.trim() || newType === c.type_name) return;
    runAlter(
      c,
      `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${c.name}" TYPE ${newType};`,
    );
  };

  /** Set or drop the column default. Empty / null clears it. */
  const changeDefault = (c: ColumnNode, newDefault: string | null) => {
    const verb = newDefault === null
      ? `DROP DEFAULT`
      : `SET DEFAULT ${newDefault}`;
    runAlter(
      c,
      `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${c.name}" ${verb};`,
    );
  };

  return (
    <div className="pane">
      <div className="pane-toolbar">
        <strong>Columns</strong>
        <span className="muted">{rel.columns.length}</span>
        <div className="spacer" />
        <button className="btn-pill" onClick={onAddColumn}>+ Add column</button>
      </div>
      <p className="muted" style={{ margin: "0 0 6px", fontSize: 11 }}>
        Click any cell to edit inline. Type uses a dropdown (pick "custom…"
        to type any expression). Default accepts an expression, or a
        dropdown of allowed values when the column is an enum. Column
        rename still opens the preview dialog.
      </p>
      <table className="meta-table editable">
        <thead><tr>
          <th>Column</th><th>Type</th><th>Nullable</th><th>Default</th><th>Key</th>
        </tr></thead>
        <tbody>
          {rel.columns.map((c) => (
            <FragmentRow
              key={c.name}
              col={c}
              isPk={rel.primary_key.includes(c.name)}
              pending={pending === c.name}
              err={errByCol[c.name]}
              onClearErr={() => setErrByCol((m) => { const { [c.name]: _, ...rest } = m; return rest; })}
              connId={connId}
              onRename={() => onEdit(c, "name")}
              onChangeType={(nt) => changeType(c, nt)}
              onToggleNullable={() => toggleNullable(c)}
              onChangeDefault={(nd) => changeDefault(c, nd)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One row in the editable Structure table — keeps its local edit state
 *  (whether the type input is focused for free-text override) so the
 *  parent doesn't have to track per-row UI flags. */
function FragmentRow({
  col, isPk, pending, err, onClearErr, connId,
  onRename, onChangeType, onToggleNullable, onChangeDefault,
}: {
  col: ColumnNode;
  isPk: boolean;
  pending: boolean;
  err?: string;
  onClearErr: () => void;
  connId: string;
  onRename: () => void;
  onChangeType: (newType: string) => void;
  onToggleNullable: () => void;
  onChangeDefault: (newDefault: string | null) => void;
}) {
  const [editingType, setEditingType] = useState(false);
  const [typeValue, setTypeValue] = useState(col.type_name);
  /** When the user chose "custom…" in the type dropdown we switch to a free
   *  text input so they can type something we don't know about. */
  const [customType, setCustomType] = useState(false);

  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultValue, setDefaultValue] = useState(col.default ?? "");

  /** Allowed labels when the column's type is an enum. null = not an enum,
   *  undefined = haven't checked yet. */
  const [enumLabels, setEnumLabels] = useState<string[] | null | undefined>(undefined);

  useEffect(() => { setTypeValue(col.type_name); }, [col.type_name]);
  useEffect(() => { setDefaultValue(col.default ?? ""); }, [col.default]);

  // Lazy-load enum membership only when the user opens the default
  // editor — saves a round-trip per row otherwise.
  useEffect(() => {
    if (!editingDefault || enumLabels !== undefined) return;
    let cancelled = false;
    void enumValuesFor(connId, col.type_name).then((labels) => {
      if (!cancelled) setEnumLabels(labels);
    });
    return () => { cancelled = true; };
  }, [editingDefault, enumLabels, connId, col.type_name]);

  const commitType = (next: string) => {
    setEditingType(false);
    setCustomType(false);
    if (next && next !== col.type_name) onChangeType(next);
    else setTypeValue(col.type_name);
  };
  const commitDefault = () => {
    setEditingDefault(false);
    const next = defaultValue.trim() === "" ? null : defaultValue;
    if (next !== col.default) onChangeDefault(next);
  };
  const cancelDefault = () => {
    setEditingDefault(false);
    setDefaultValue(col.default ?? "");
  };

  /** Render the type cell. Click → open a <select>; "custom…" → text input. */
  const renderTypeCell = () => {
    if (!editingType) {
      // Display upper-case for visual consistency (matches Postgres's
      // own `\d` output where types render uppercase). The underlying
      // value stays in its canonical case for SQL emission.
      return <span>{col.type_name.toUpperCase()}</span>;
    }
    if (customType) {
      return (
        <input
          type="text"
          className="inline-type-input"
          autoFocus
          value={typeValue}
          onChange={(e) => setTypeValue(e.target.value)}
          onBlur={() => commitType(typeValue)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitType(typeValue);
            if (e.key === "Escape") commitType(col.type_name);
          }}
        />
      );
    }
    // Build the option list: known types + the current value if it's not
    // already in the list (so we don't lose the user's existing pick).
    const known = new Set(COMMON_PG_TYPES);
    const opts = [...COMMON_PG_TYPES];
    if (!known.has(col.type_name)) opts.unshift(col.type_name);
    return (
      <select
        className="inline-type-input"
        autoFocus
        value={typeValue}
        onChange={(e) => {
          if (e.target.value === "__custom__") { setCustomType(true); setTypeValue(""); }
          else commitType(e.target.value);
        }}
        onBlur={() => setEditingType(false)}
      >
        {opts.map((t) => <option key={t} value={t}>{t}</option>)}
        <option value="__custom__">custom…</option>
      </select>
    );
  };

  /** Render the default cell. Click → text input, or <select> for enums. */
  const renderDefaultCell = () => {
    if (!editingDefault) {
      return <span>{col.default ?? "—"}</span>;
    }
    // Enum: dropdown of allowed labels (Postgres expects them as quoted
    // string literals). "(none)" clears the default.
    if (Array.isArray(enumLabels) && enumLabels.length > 0) {
      return (
        <select
          className="inline-type-input"
          autoFocus
          value={defaultValue}
          onChange={(e) => {
            const v = e.target.value;
            setDefaultValue(v);
            // Commit immediately on pick — select doesn't get an Enter.
            setEditingDefault(false);
            const next = v.trim() === "" ? null : `'${v.replace(/'/g, "''")}'::${col.type_name}`;
            if (next !== col.default) onChangeDefault(next);
          }}
          onBlur={() => setEditingDefault(false)}
        >
          <option value="">(none)</option>
          {enumLabels.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      );
    }
    // Free-text default (covers expressions like nextval('seq'), now(),
    // literal strings, numbers, NULL).
    return (
      <input
        type="text"
        className="inline-type-input"
        autoFocus
        placeholder={enumLabels === undefined ? "loading…" : "default expression"}
        value={defaultValue}
        onChange={(e) => setDefaultValue(e.target.value)}
        onBlur={commitDefault}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitDefault();
          if (e.key === "Escape") cancelDefault();
        }}
      />
    );
  };

  return (
    <>
      <tr className={pending ? "row-pending" : ""}>
        <td className="editable-cell" onClick={onRename} title="Rename column">
          {col.name}
        </td>
        <td className="editable-cell mono" onClick={() => setEditingType(true)} title="Change type">
          {renderTypeCell()}
        </td>
        <td>
          <button
            className={`inline-toggle ${col.nullable ? "" : "on"}`}
            onClick={onToggleNullable}
            disabled={pending}
            title={col.nullable ? "Click to SET NOT NULL" : "Click to DROP NOT NULL"}
          >
            <span className="inline-toggle-knob" />
            <span className="inline-toggle-label">{col.nullable ? "YES" : "NOT NULL"}</span>
          </button>
        </td>
        <td className="editable-cell mono muted" onClick={() => setEditingDefault(true)} title="Change default">
          {renderDefaultCell()}
        </td>
        <td>{isPk ? <span className="kbd">PK</span> : ""}</td>
      </tr>
      {err && (
        <tr className="row-err">
          <td colSpan={5}>
            <div className="row-err-body">
              <span>{err}</span>
              <button className="btn-link" onClick={onClearErr}>Dismiss</button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function IndexesPane({
  rel, connId, schema, table, engine, onAddIndex,
}: {
  rel?: RelationNode;
  connId: string;
  schema: string;
  table: string;
  engine?: string;
  onAddIndex: () => void;
}) {
  const isMongo = engine === "mongo";
  // Size/scan stats come from pg_stat_user_indexes — pass empty schema for
  // Mongo so useTableStats skips the catalog query (which the Mongo driver
  // would reject). Index metadata itself still comes from introspection.
  const { indexes: stats } = useTableStats(connId, isMongo ? "" : schema, table);
  const statByName = useMemo(() => {
    const m = new Map<string, { bytes: number; scans: number }>();
    for (const s of stats) m.set(s.name, s);
    return m;
  }, [stats]);

  if (!rel) return <div className="placeholder muted">No index metadata yet.</div>;
  return (
    <div className="pane">
      <div className="pane-toolbar">
        <strong>Indexes</strong>
        <span className="muted">{rel.indexes.length}</span>
        <div className="spacer" />
        {/* Add index emits pg CREATE INDEX DDL — hide it on Mongo. */}
        {!isMongo && <button className="btn-pill" onClick={onAddIndex}>+ Add index</button>}
      </div>
      {rel.indexes.length === 0 ? (
        <div className="placeholder muted">No indexes on this table.</div>
      ) : (
        <table className="meta-table">
          <thead><tr>
            <th>Name</th><th>Columns</th><th>Method</th><th>Unique</th>
            <th>Size</th><th>Scans</th><th>Definition</th>
          </tr></thead>
          <tbody>
            {rel.indexes.map((ix) => {
              const s = statByName.get(ix.name);
              return (
                <tr key={ix.name}>
                  <td>{ix.name}</td>
                  <td className="mono">{ix.columns.join(", ")}</td>
                  <td>{ix.method}</td>
                  <td>{ix.is_primary ? <span className="kbd">PRIMARY</span> : ix.is_unique ? <span className="kbd">UNIQUE</span> : ""}</td>
                  <td className="mono">{s ? formatBytes(s.bytes) : "—"}</td>
                  <td className="mono">{s ? s.scans.toLocaleString() : "—"}</td>
                  <td className="mono muted" title={ix.definition}>{ix.definition}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InfoPane({
  rel, connId, schema, table, engine,
}: {
  rel?: RelationNode;
  connId: string;
  schema: string;
  table: string;
  engine?: string;
}) {
  const isMongo = engine === "mongo";
  // Storage/activity numbers come from pg_class + pg_stat_user_tables. Pass an
  // empty schema for Mongo so useTableStats skips the catalog query entirely
  // (it would otherwise be sent to the Mongo driver and error).
  const { stats, loading, err } = useTableStats(connId, isMongo ? "" : schema, table);
  if (!rel) return <div className="placeholder muted">No metadata yet.</div>;
  return (
    <div className="pane">
      <div className="pane-toolbar"><strong>Info</strong></div>
      <table className="meta-table">
        <tbody>
          <tr><td>Name</td><td className="mono">{rel.name}</td></tr>
          <tr><td>Columns</td><td>{rel.columns.length}</td></tr>
          <tr><td>Primary key</td><td className="mono">{rel.primary_key.join(", ") || "—"}</td></tr>
          <tr><td>Foreign keys</td><td>{rel.foreign_keys.length}</td></tr>
          <tr><td>Indexes</td><td>{rel.indexes.length}</td></tr>
        </tbody>
      </table>

      <div className="pane-toolbar"><strong>Storage &amp; activity</strong></div>
      {isMongo ? (
        <div className="placeholder muted" style={{ padding: 8 }}>
          Not available for MongoDB.
        </div>
      ) : (
        <>
      {err && <div className="message-pane err" style={{ margin: 8 }}>{err}</div>}
      {loading && !stats ? (
        <div className="placeholder muted">Loading stats…</div>
      ) : stats ? (
        <table className="meta-table">
          <tbody>
            <tr><td>Total size</td><td className="mono">{formatBytes(stats.totalBytes)}</td></tr>
            <tr><td>Table (heap)</td><td className="mono">{formatBytes(stats.tableBytes)}</td></tr>
            <tr><td>Indexes</td><td className="mono">{formatBytes(stats.indexBytes)}</td></tr>
            <tr><td>TOAST</td><td className="mono">{formatBytes(stats.toastBytes)}</td></tr>
            <tr>
              <td>Estimated rows</td>
              <td className="mono">
                {stats.estimatedRows >= 0
                  ? stats.estimatedRows.toLocaleString()
                  : "— (run ANALYZE)"}
              </td>
            </tr>
            <tr><td>Seq scans</td><td className="mono">{stats.seqScans.toLocaleString()}</td></tr>
            <tr><td>Index scans</td><td className="mono">{stats.idxScans.toLocaleString()}</td></tr>
            <tr><td>Last vacuum</td><td className="mono muted">{stats.lastVacuum ?? "—"}</td></tr>
            <tr><td>Last analyze</td><td className="mono muted">{stats.lastAnalyze ?? "—"}</td></tr>
          </tbody>
        </table>
      ) : null}
        </>
      )}

      {rel.foreign_keys.length > 0 && (
        <>
          <div className="pane-toolbar"><strong>Foreign keys</strong></div>
          <table className="meta-table">
            <thead><tr><th>Name</th><th>From</th><th>References</th></tr></thead>
            <tbody>
              {rel.foreign_keys.map((fk) => (
                <tr key={fk.name}>
                  <td>{fk.name}</td>
                  <td className="mono">{fk.columns.join(", ")}</td>
                  <td className="mono">{fk.referenced_schema}.{fk.referenced_table}({fk.referenced_columns.join(", ")})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function addIndex(tab: Tab, rel?: { schema: string; table: string }) {
  if (!rel) return;
  const cols = prompt(`Columns to index on ${rel.schema}.${rel.table} (comma-separated):`);
  if (!cols) return;
  const colList = cols.split(",").map((s) => `"${s.trim()}"`).join(", ");
  const name = `${rel.table}_${cols.split(",").map((s) => s.trim()).join("_")}_idx`;
  const sql = `CREATE INDEX "${name}" ON "${rel.schema}"."${rel.table}" (${colList});`;
  void api.execute(tab.connId, sql).then(() => api.introspect(tab.connId))
    .then((t) => useStore.getState().setSchema(tab.connId, t))
    .catch((e) => alert(`Failed: ${e}`));
}

function SortPill({
  sort, columns, onCycle, onClear,
}: {
  sort?: Tab["sort"];
  columns: { name: string }[];
  onCycle: (c: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="col-menu-wrap">
      <button className="btn-pill" onClick={() => setOpen(!open)}>
        {!sort && <><ArrowUpDown size={12} /> Sort</>}
        {sort?.dir === "asc" && <><ArrowUp size={12} /> {sort.column}</>}
        {sort?.dir === "desc" && <><ArrowDown size={12} /> {sort.column}</>}
      </button>
      {open && (
        <div className="col-menu" onMouseLeave={() => setOpen(false)}>
          <div className="col-menu-actions">
            <button className="btn-link" onClick={() => { onClear(); setOpen(false); }}>Clear sort</button>
          </div>
          <div className="col-menu-list">
            {columns.map((c) => (
              <div key={c.name} className="col-menu-row" onClick={() => { onCycle(c.name); setOpen(false); }}>
                {c.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function filterVisible(tab: Tab, hidden: string[], search: string): Tab {
  let cols = tab.columns ?? [];
  let rows = tab.rows ?? [];
  // 1) Drop hidden columns from the projection. Columns the user has hidden
  //    are also not searched — that matches the user's mental model: only
  //    what's on screen counts.
  if (hidden.length && cols.length) {
    const visibleIdx = cols
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !hidden.includes(c.name));
    cols = visibleIdx.map(({ c }) => c);
    rows = rows.map((r) => visibleIdx.map(({ i }) => r[i]));
  }
  // 2) Filter rows by quick-search substring across remaining cells.
  if (search.trim()) {
    const m = matches(search.trim(), rows);
    rows = m.map((mm) => rows[mm.index]);
  }
  return { ...tab, columns: cols, rows };
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
function quoteValue(v: string | null, op: FilterChip["op"]): string {
  if (op === "IS NULL" || op === "IS NOT NULL") return "";
  if (v == null) return "";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** Escape % and _ in a substring so the user's value can't accidentally
 *  match more than intended in a LIKE/ILIKE pattern. */
function escapeLike(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Compile one chip to a SQL predicate. Some user-facing operators don't
 *  map 1:1 to SQL — CONTAINS becomes LIKE '%value%', NOT CONTAINS
 *  becomes NOT LIKE, ICONTAINS uses ILIKE for case-insensitive matching. */
function compileChip(f: FilterChip): string {
  const col = qi(f.column);
  switch (f.op) {
    case "IS NULL":      return `${col} IS NULL`;
    case "IS NOT NULL":  return `${col} IS NOT NULL`;
    case "CONTAINS":
    case "NOT CONTAINS":
    case "ICONTAINS":
    case "NOT ICONTAINS": {
      const v = f.value ?? "";
      const lit = `'%${escapeLike(v).replace(/'/g, "''")}%'`;
      const verb =
        f.op === "CONTAINS"      ? "LIKE" :
        f.op === "NOT CONTAINS"  ? "NOT LIKE" :
        f.op === "ICONTAINS"     ? "ILIKE" :
                                   "NOT ILIKE";
      return `${col} ${verb} ${lit}`;
    }
    default: {
      const lit = quoteValue(f.value, f.op);
      return lit ? `${col} ${f.op} ${lit}` : `${col} ${f.op}`;
    }
  }
}

/** Build the WHERE clause body from filter chips (including the leading
 *  `WHERE`). Returns empty string when no filters are active. Exported so
 *  the row-count helper can build matching exact-count queries. */
function buildWhereClause(filters: FilterChip[]): string {
  // Skip chips the user has toggled off in the builder. `enabled` is
  // undefined for legacy persisted chips → treat as enabled.
  const active = filters.filter((f) => f.enabled !== false);
  if (!active.length) return "";
  return `WHERE ${active.map(compileChip).join(" AND ")}`;
}

function buildSql(
  rel: { schema: string; table: string } | undefined,
  filters: FilterChip[],
  sort: Tab["sort"],
  limit: number,
): string {
  if (!rel) return "";
  let sql = `SELECT * FROM ${qi(rel.schema)}.${qi(rel.table)}`;
  const where = buildWhereClause(filters);
  if (where) sql += ` ${where}`;
  if (sort) sql += ` ORDER BY ${qi(sort.column)} ${sort.dir.toUpperCase()}`;
  sql += ` LIMIT ${limit}`;
  return sql + ";";
}
