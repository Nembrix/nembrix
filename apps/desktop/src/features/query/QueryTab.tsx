import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { keymap, EditorView } from "@codemirror/view";
import { EditorSelection, Prec, StateEffect } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
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

/** Map a JSON value coming back from a script's query result into the grid's
 *  tagged CellValue union, so script results render through the same DataGrid
 *  as normal queries. Objects/arrays land in the collapsible `document` cell. */
function toCell(v: unknown): import("@/ipc/types").CellValue {
  if (v === null || v === undefined) return { kind: "null" };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { kind: "int", value: v }
      : { kind: "float", value: v };
  }
  if (typeof v === "string") return { kind: "text", value: v };
  return { kind: "document", value: v };
}

export default function QueryTab({ tab }: { tab: Tab }) {
  const { schemas, updateTab, appendBatch, activeTabId, editorTick, editorAction, panels } = useStore();
  const tree = schemas[tab.connId];
  const handleRef = useRef<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [view, setView] = useState<ResultView>("data");

  const lineCount = useMemo(() => (tab.sql ?? "").split("\n").length, [tab.sql]);
  const selectedChars = (tab.sql ?? "").length;
  const filters = tab.filters ?? [];

  const isScript = tab.lang === "script";
  // Scripting mode is RDBMS-only. postgres/mysql/sqlite are SQL engines;
  // mongo/redis have their own languages, so we don't offer the toggle there.
  const conn = useStore.getState().connections.find((c) => c.id === tab.connId);
  const sqlEngines = new Set(["postgres", "mysql", "sqlite"]);
  const scriptingAvailable = sqlEngines.has(conn?.engine ?? "");

  /** Tack a LIMIT onto the SQL when the picker is set, the query
   *  looks like a SELECT, and the user didn't already type one. We
   *  parse very loosely — anything with a SELECT keyword and no LIMIT
   *  qualifies. False positives (e.g. a CTE-wrapped statement) are
   *  fine; the server gracefully accepts an outer LIMIT. */
  const attachLimit = (raw: string, limit: number | undefined): string => {
    if (!limit || limit <= 0) return raw;
    const trimmed = raw.trimEnd().replace(/;\s*$/, "");
    const upper = trimmed.toUpperCase();
    if (!upper.includes("SELECT")) return raw;
    if (/\bLIMIT\b\s+\d+/.test(upper)) return raw;
    return `${trimmed}\nLIMIT ${limit};`;
  };

  const runScriptMode = async () => {
    const source = tab.sql ?? "";
    if (!source.trim()) return;
    const started = performance.now();
    updateTab(tab.id, {
      columns: undefined, rows: [], logs: [], running: true, error: undefined,
      queryStartedAt: started, elapsedMs: undefined,
    });
    setStatusMsg("Running script…");
    setView("data");
    try {
      const outcome = await api.runScript(tab.connId, source);
      const ms = Math.round(performance.now() - started);
      // Project the script's { columns, rows: Record<>[] } result into the
      // grid's positional shape (ColMeta[] + CellValue[][]) so DataGrid renders
      // it exactly like a normal query result.
      let columns: import("@/ipc/types").ColMeta[] | undefined;
      let rows: import("@/ipc/types").CellValue[][] | undefined;
      if (outcome.data) {
        columns = outcome.data.columns.map((name) => ({
          name, type_name: "", nullable: true,
        }));
        rows = outcome.data.rows.map((row) =>
          outcome.data!.columns.map((c) => toCell(row[c])),
        );
      }
      updateTab(tab.id, {
        columns, rows: rows ?? [], logs: outcome.logs,
        running: false, elapsedMs: ms,
      });
      useStore.getState().bumpHistory();
      const n = outcome.query_count;
      const rowsN = rows?.length ?? 0;
      setStatusMsg(
        `Done in ${ms} ms · ${n} ${n === 1 ? "query" : "queries"}` +
        `${rowsN > 0 ? `, ${rowsN} ${rowsN === 1 ? "row" : "rows"}` : ""}`,
      );
    } catch (e) {
      updateTab(tab.id, { running: false, error: String(e) });
      setStatusMsg(`Error: ${e}`);
    }
  };

  const run = async () => {
    if (isScript) return runScriptMode();
    const rawSql = tab.sql ?? "";
    if (!rawSql.trim()) return;
    const sql = attachLimit(rawSql, tab.limit);
    // Production / staging guard — type the connection name to confirm.
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
      // Surface the error on the current view (usually Data) instead
      // of forcing a switch to the Message tab — the user reported
      // that the data view going blank looked like the result had
      // vanished. The Data render branch already shows tab.error in
      // a styled error pane, so leaving the view as-is means the
      // user sees the failure right where the data should have been.
      updateTab(tab.id, { running: false, error: String(e) });
      setStatusMsg(`Error: ${e}`);
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

  // The CodeMirror keymap is registered once, on editor creation, rather than
  // through the declarative `extensions` prop. The keymap commands need to
  // invoke `run` / `format` / `saveAsNamed`, which (via run) write handleRef.
  // Building those arrows inside the render-time `extensions` array makes the
  // lint flow-analysis treat that ref write as render-phase access. Stashing
  // the handlers on a ref and wiring the keymap from the `onCreateEditor`
  // callback keeps the ref access firmly inside a callback. The ref always
  // holds the freshest closures, so ⌘-shortcuts run against current state.
  const cmdsRef = useRef({ run, cancel, format, saveAsNamed });
  useEffect(() => {
    cmdsRef.current = { run, cancel, format, saveAsNamed };
  });

  // Language extension: JS syntax/highlighting in script mode, SQL completion
  // otherwise. Swapping this by `tab.lang` is what makes the same editor a
  // JavaScript surface when the user flips the toggle.
  const langExt = isScript ? javascript() : buildSqlExtension(tree);
  const rowCount = tab.rows?.length ?? 0;

  // Editor height — user-draggable via the separator between the
  // editor and the results panel. Persisted to localStorage so the
  // layout survives reloads. Stored as a flex-basis percentage of
  // the editor-shell rather than absolute pixels so resizing the
  // window doesn't squeeze the editor or the results out of view.
  const [editorPct, setEditorPct] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem("nembrix.editor.pct") ?? "");
      if (Number.isFinite(v) && v >= 15 && v <= 85) return v;
    } catch { /* localStorage off */ }
    return 50;
  });
  useEffect(() => {
    try { localStorage.setItem("nembrix.editor.pct", String(editorPct)); } catch { /* ignore: best-effort */ }
  }, [editorPct]);
  const shellRef = useRef<HTMLDivElement>(null);
  // Ref to the CodeMirror EditorView so the wrapper's click handler
  // can dispatch a selection + focus on the live editor — the
  // domEventHandlers extension only fires for events that originate
  // INSIDE the editor's own DOM, so clicks on the wrapper padding /
  // the editor-wrap container were silently ignored.
  const editorViewRef = useRef<EditorView | null>(null);
  const focusEditorAt = (clientX: number, clientY: number) => {
    const view = editorViewRef.current;
    if (!view) return;
    const pos = view.posAtCoords({ x: clientX, y: clientY })
      ?? view.state.doc.length;
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      scrollIntoView: true,
    });
    view.focus();
  };
  const onSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const offsetY = ev.clientY - rect.top;
      const pct = Math.max(15, Math.min(85, (offsetY / rect.height) * 100));
      setEditorPct(pct);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="editor-shell" ref={shellRef}>
      <div
        className="editor-wrap"
        style={{ flex: `1 1 ${editorPct}%` }}
        onMouseDown={(e) => {
          // Clicks on the wrapper padding (i.e. anywhere INSIDE the
          // editor area but OUTSIDE the actual EditorView DOM) should
          // still focus the editor. Skip when the click is on the
          // editor itself — domEventHandlers handles that case.
          const target = e.target as HTMLElement;
          if (target.closest(".cm-editor")) return;
          e.preventDefault();
          focusEditorAt(e.clientX, e.clientY);
        }}
      >
        <CodeMirror
          value={tab.sql ?? ""}
          height="100%"
          theme="dark"
          onCreateEditor={(view) => {
            editorViewRef.current = view;
            // Register the ⌘-shortcut keymap on the live view rather than via
            // the declarative `extensions` prop. The commands read cmdsRef to
            // reach the freshest run/format/save closures; doing this inside
            // onCreateEditor keeps that ref access inside a callback.
            view.dispatch({
              effects: StateEffect.appendConfig.of(
                Prec.highest(
                  keymap.of([
                    { key: "Mod-Enter", run: () => { cmdsRef.current.run(); return true; } },
                    { key: "Mod-Shift-f", run: () => { cmdsRef.current.format(); return true; } },
                    { key: "Mod-i", run: () => { cmdsRef.current.format(); return true; } },
                    // ⌘S: save the query when focus is in the editor.
                    // Uses the same flow as File → Save Query — prompts
                    // for a name when the tab still has the default title.
                    { key: "Mod-s", run: () => { void cmdsRef.current.saveAsNamed(); return true; } },
                  ]),
                ),
              ),
            });
          }}
          extensions={[
            langExt,
            // Click anywhere in the editor body (including the empty
            // area below the last line) places the cursor at the end
            // of the document and focuses the editor. CodeMirror's
            // default only handles clicks on actual content rows —
            // empty space below the last line falls through and
            // nothing happens, which feels broken in an empty editor.
            EditorView.domEventHandlers({
              mousedown(event, view) {
                const target = event.target as HTMLElement;
                // Autocomplete tooltips have their own behavior — leave them.
                if (target.closest(".cm-tooltip")) return false;
                // Clicking a line number in the gutter should place the
                // cursor at the START of that line and focus the editor,
                // like every code editor — CodeMirror's default does
                // nothing on a bare gutter click. Resolve the line from
                // the click Y (posAtCoords is content-relative but the
                // gutter shares the row's vertical band).
                if (target.closest(".cm-gutter")) {
                  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
                  const line = view.state.doc.lineAt(pos);
                  view.dispatch({
                    selection: EditorSelection.cursor(line.from),
                    scrollIntoView: true,
                  });
                  view.focus();
                  return false;
                }
                // Any click inside the editor's scroll surface should
                // place the cursor at the doc end (when below the
                // last line) or at the clicked coordinate (when on
                // text). CodeMirror's built-in click handler only
                // fires on content lines, so clicks on the empty
                // canvas below the last line fell through and the
                // editor lost focus until the user clicked on a real
                // character. closest() also catches inner spans, not
                // just the bare .cm-content wrapper.
                if (!target.closest(".cm-scroller, .cm-content")) return false;
                // posAtCoords returns null when the click is below
                // the last line — falling back to doc.length puts the
                // cursor at the natural "keep typing here" spot.
                // bias: -1 prefers the position immediately to the
                // left of the click so clicking the gap between two
                // characters lands intuitively.
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
                  ?? view.state.doc.length;
                view.dispatch({
                  selection: EditorSelection.cursor(pos),
                  scrollIntoView: true,
                });
                view.focus();
                return false;
              },
            }),
          ]}
          onChange={(v) => updateTab(tab.id, { sql: v })}
          basicSetup={{
            lineNumbers: true,
            // Kill the full-row stripe — the gutter number highlight
            // (still on via `highlightActiveLineGutter` default) is
            // enough to mark the active line without painting across
            // the SQL body.
            highlightActiveLine: false,
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
        {/* Language toggle — only for SQL connections. Flips the tab between
            plain SQL and JS scripting mode (db.query + loops). Mongo/Redis
            connections have their own languages, so it's hidden there. */}
        {scriptingAvailable && (
          <label className="limit-picker" title="Editor language for this tab">
            <span className="muted">Lang</span>
            <select
              value={tab.lang ?? "sql"}
              onChange={(e) =>
                updateTab(tab.id, { lang: e.target.value as "sql" | "script" })
              }
            >
              <option value="sql">SQL</option>
              <option value="script">JavaScript</option>
            </select>
          </label>
        )}
        {/* Limit picker: when set, a LIMIT clause is appended to the
            executed SQL if the user's query doesn't already have one.
            "No limit" lets the user opt out per tab — defensive
            queries (DELETE etc.) keep their own semantics. Not shown in
            script mode: the LIMIT rewrite only makes sense for raw SQL. */}
        {!isScript && (
        <label className="limit-picker">
          <span className="muted">Limit</span>
          <select
            value={tab.limit ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              updateTab(tab.id, { limit: v > 0 ? v : undefined });
            }}
            title="Append a LIMIT clause to the query when none is present"
          >
            <option value={0}>No limit</option>
            <option value={100}>100</option>
            <option value={500}>500</option>
            <option value={1000}>1,000</option>
            <option value={5000}>5,000</option>
            <option value={10000}>10,000</option>
          </select>
        </label>
        )}
        {!isScript && (
        <button className="btn-pill" onClick={format} title="Format (⌘I)">
          <Sparkles size={12} /> Beautify <span className="kbd">⌘I</span>
        </button>
        )}
        <button className="btn-pill" onClick={saveAsNamed} title="Save query…">
          <Star size={12} /> Save
        </button>
        {tab.running ? (
          <button className="btn-pill danger" onClick={cancel}>
            <Square size={12} /> Cancel
          </button>
        ) : (
          <button className="btn-pill primary" onClick={run} title="Run (⌘↵)">
            <Play size={12} /> {isScript ? "Run Script" : "Run Current"} <span className="kbd">⌘↵</span>
          </button>
        )}
      </div>

      {panels.results && (
        <div
          className="editor-split"
          onMouseDown={onSplitDrag}
          onDoubleClick={() => setEditorPct(50)}
          title="Drag to resize · double-click to reset"
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      {panels.results && (
      <div className="result-shell" style={{ flex: `1 1 ${100 - editorPct}%` }}>
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
              {tab.error ? (
                <span className="err">{tab.error}</span>
              ) : isScript && (tab.logs?.length ?? 0) > 0 ? (
                // Script console output: one line per console.* call, tinted by
                // level. Monospace so aligned/tabular logs stay readable.
                <div className="script-log">
                  {tab.logs!.map((l, i) => (
                    <div key={i} className={`log-line log-${l.level}`}>
                      {l.text}
                    </div>
                  ))}
                </div>
              ) : (
                statusMsg || "—"
              )}
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
