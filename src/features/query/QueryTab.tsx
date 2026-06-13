import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { Play, Square, Sparkles, Star } from "lucide-react";
import { buildSqlExtension } from "@/editor/sql-completion";
import { useStore, type Tab, type FilterChip } from "@/store";
import * as api from "@/ipc/commands";
import DataGrid from "@/components/DataGrid";
import FilterBar from "@/features/grid/FilterBar";
import ChartPane from "@/features/grid/ChartPane";
import { rewriteSqlWithFilters } from "@/features/grid/filter-sql";
import { rememberRecentSql } from "@/palette/items";
import { destructiveReason } from "@/features/connections/environment";
import RunningTimer from "@/components/RunningTimer";
import AnalysisPane from "@/features/query/AnalysisPane";
import { recordSlowQuery } from "@/features/query/slowQueries";

type ResultView = "data" | "message" | "chart" | "analysis";

export default function QueryTab({ tab }: { tab: Tab }) {
  const { schemas, updateTab, appendBatch, activeTabId, editorTick, editorAction, panels } = useStore();
  const tree = schemas[tab.connId];
  const handleRef = useRef<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [view, setView] = useState<ResultView>("data");

  const lineCount = useMemo(() => (tab.sql ?? "").split("\n").length, [tab.sql]);
  const selectedChars = (tab.sql ?? "").length;
  const filters = tab.filters ?? [];

  const run = async () => {
    const sql = tab.sql ?? "";
    if (!sql.trim()) return;
    // Production / staging guard — type the connection name to confirm.
    const conn = useStore.getState().connections.find((c) => c.id === tab.connId);
    const reason = destructiveReason(conn?.environment, sql);
    if (reason && conn) {
      const typed = prompt(
        `⚠ ${reason} against ${conn.environment?.toUpperCase()}\n\n` +
        `To run this on "${conn.name}", type the connection name to confirm:`,
      );
      if (typed !== conn.name) {
        setStatusMsg("Cancelled — confirmation did not match.");
        return;
      }
    }
    rememberRecentSql(sql);
    const started = performance.now();
    updateTab(tab.id, {
      columns: undefined, rows: [], running: true, error: undefined,
      queryStartedAt: started, elapsedMs: undefined,
    });
    setStatusMsg("Running…");
    setView("data");
    try {
      handleRef.current = await api.stream(tab.connId, sql, (b) => {
        appendBatch(tab.id, b);
        if (b.done) {
          const ms = Math.round(performance.now() - started);
          updateTab(tab.id, { elapsedMs: ms, running: false });
          useStore.getState().bumpHistory();
          setStatusMsg(`Done in ${ms} ms`);
          // Record into the local slow-query log. The recorder no-ops
          // when below threshold or disabled, so this is safe to call
          // for every completed query.
          recordSlowQuery(
            { connId: tab.connId, connName: conn?.name, sql, elapsedMs: ms },
            Date.now(),
          );
        }
      });
    } catch (e) {
      updateTab(tab.id, { running: false, error: String(e) });
      setStatusMsg(`Error: ${e}`);
      setView("message");
    }
  };

  const cancel = async () => {
    if (!handleRef.current) return;
    try { await api.cancel(tab.connId, handleRef.current); } catch (e) { console.error(e); }
  };

  const format = async () => {
    try {
      const out = await api.formatSql(tab.sql ?? "");
      updateTab(tab.id, { sql: out });
    } catch (e) { console.error(e); }
  };

  const saveAsNamed = async () => {
    const current = tab.sql ?? "";
    if (!current.trim()) return;
    const name = prompt("Name this saved query:", tab.title === "Query" ? "" : tab.title);
    if (!name) return;
    try {
      await api.saveSavedQuery({
        id: null,
        conn_id: tab.connId,
        name,
        sql: current,
      });
      useStore.getState().bumpSavedQueries();
      updateTab(tab.id, { title: name });
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  };

  // Filter chip mutations: keep the SQL and chip list in lockstep, then re-run.
  const applyFilters = (next: FilterChip[]) => {
    const newSql = rewriteSqlWithFilters(tab.sql ?? "", next);
    updateTab(tab.id, { filters: next, sql: newSql });
    // Defer the run so the editor sees the new value first.
    setTimeout(run, 0);
  };
  const removeFilter = (id: string) => applyFilters(filters.filter((f) => f.id !== id));
  const clearFilters = () => applyFilters([]);

  // React to menu-driven editor actions, but only on the active tab.
  useEffect(() => {
    if (activeTabId !== tab.id || !editorAction) return;
    if (editorAction === "run" || editorAction === "run-all") run();
    else if (editorAction === "cancel") cancel();
    else if (editorAction === "format") format();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTick]);

  const sqlExt = buildSqlExtension(tree);
  const rowCount = tab.rows?.length ?? 0;

  return (
    <div className="editor-shell">
      <div className="editor-wrap">
        <CodeMirror
          value={tab.sql ?? ""}
          height="100%"
          theme="dark"
          extensions={[
            sqlExt,
            Prec.highest(
              keymap.of([
                { key: "Mod-Enter", run: () => { run(); return true; } },
                { key: "Mod-Shift-f", run: () => { format(); return true; } },
                { key: "Mod-i", run: () => { format(); return true; } },
              ]),
            ),
          ]}
          onChange={(v) => updateTab(tab.id, { sql: v })}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            autocompletion: true,
            foldGutter: true,
            indentOnInput: true,
          }}
        />
      </div>

      <div className="editor-toolbar">
        <span className="muted">
          {lineCount} {lineCount === 1 ? "line" : "lines"}, {selectedChars} characters
        </span>
        <div className="spacer" />
        <span className="muted">No limit</span>
        <button className="btn-pill" onClick={format} title="Format (⌘I)">
          <Sparkles size={12} /> Beautify <span className="kbd">⌘I</span>
        </button>
        <button className="btn-pill" onClick={saveAsNamed} title="Save query…">
          <Star size={12} /> Save
        </button>
        {tab.running ? (
          <button className="btn-pill danger" onClick={cancel}>
            <Square size={12} /> Cancel
          </button>
        ) : (
          <button className="btn-pill primary" onClick={run} title="Run (⌘↵)">
            <Play size={12} /> Run Current <span className="kbd">⌘↵</span>
          </button>
        )}
      </div>

      {panels.results && (
      <div className="result-shell">
        <div className="result-segments">
          <div className="segmented" role="tablist">
            <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>Data</button>
            <button className={view === "message" ? "active" : ""} onClick={() => setView("message")}>Message</button>
            <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>Chart</button>
            <button className={view === "analysis" ? "active" : ""} onClick={() => setView("analysis")}>Analysis</button>
          </div>
          <span className="meta">
            <RunningTimer
              running={tab.running}
              startedAt={tab.queryStartedAt}
              elapsedMs={tab.elapsedMs}
            />
            {rowCount > 0 && ` · ${rowCount} ${rowCount === 1 ? "row" : "rows"}`}
            {filters.length > 0 && ` · ${filters.length} filter${filters.length === 1 ? "" : "s"}`}
          </span>
          <div className="spacer" />
          <span className="muted">{statusMsg}</span>
        </div>

        <FilterBar filters={filters} onRemove={removeFilter} onClear={clearFilters} />

        <div className="result-body">
          {view === "data" && (tab.error
            ? <div className="message-pane err">{tab.error}</div>
            : <DataGrid tab={tab} />)}
          {view === "message" && (
            <div className="message-pane">
              {tab.error ? <span className="err">{tab.error}</span> : statusMsg || "—"}
            </div>
          )}
          {view === "chart" && tab.columns && tab.rows && (
            <ChartPane columns={tab.columns} rows={tab.rows} />
          )}
          {view === "analysis" && (
            <AnalysisPane connId={tab.connId} sql={tab.sql ?? ""} />
          )}
        </div>
      </div>
      )}
    </div>
  );
}
