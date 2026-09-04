import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { keymap, EditorView } from "@codemirror/view";
import { EditorSelection, Prec, StateEffect } from "@codemirror/state";
import { buildJsScriptExtension } from "@/editor/js-completion";
import { buildMongoExtension } from "@/editor/mongo-completion";
import { Play, Square, Sparkles, Star, PanelBottom } from "lucide-react";
import { buildSqlExtension } from "@/editor/sql-completion";
import { completionTabKeymap } from "@/editor/completion-tab";
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
/**
 * Heuristic: does this text look like a JavaScript script rather than SQL?
 * Used to catch a script typed into a SQL-mode tab (which would otherwise be
 * sent to Postgres and fail with a cryptic "syntax error at or near const").
 * Matches tokens that appear in the scripting API / JS syntax but never in
 * plain SQL. Scans the whole text so a leading comment can't hide the opener.
 */
export function looksLikeJavaScript(text: string): boolean {
  return (
    /\bdb\.query\s*\(/.test(text) ||       // the scripting API
    /\bconsole\.(log|warn|error)\s*\(/.test(text) ||
    /\bawait\b/.test(text) ||              // SQL has no await
    /=>/.test(text) ||                     // arrow functions
    /\$\{[^}]*\}/.test(text) ||            // template literals
    /\bfor\s*\(\s*(const|let|var)\b/.test(text) || // JS for-of/for-let
    /^\s*(const|let|var|function|async)\b/m.test(text) // JS declarations, any line
  );
}

/** A line as (absolute start offset, text) — the minimal shape the comment
 *  toggler needs, so the core logic is testable without a real EditorView. */
export interface CommentLine {
  from: number;
  text: string;
}

/**
 * Pure core of the comment toggle: given the selected lines and a token
 * (`--` / `//`), return the document changes. If every non-blank line is
 * already commented, uncomment; otherwise comment. Indentation is preserved
 * (the token goes after leading whitespace). No DOM / EditorView needed.
 */
export function computeCommentToggle(
  lines: CommentLine[],
  token: string,
): { from: number; to?: number; insert?: string }[] {
  const prefix = token + " ";
  const nonBlank = lines.filter((l) => l.text.trim().length > 0);
  const allCommented =
    nonBlank.length > 0 &&
    nonBlank.every((l) => l.text.trimStart().startsWith(token));
  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (const line of lines) {
    const indent = line.text.length - line.text.trimStart().length;
    if (allCommented) {
      const rest = line.text.slice(indent);
      if (rest.startsWith(token)) {
        const cut = rest.startsWith(prefix) ? prefix.length : token.length;
        changes.push({ from: line.from + indent, to: line.from + indent + cut });
      }
    } else if (line.text.trim().length > 0) {
      changes.push({ from: line.from + indent, insert: prefix });
    }
  }
  return changes;
}

/**
 * Toggle a line comment across the selected lines using the given token
 * (`--` for SQL, `//` for JavaScript). Written by hand (via
 * [`computeCommentToggle`]) rather than via `@codemirror/commands` to avoid a
 * monorepo dep-identity clash between the hoisted `@codemirror/state`/`view`
 * copies.
 */
export function toggleLineComment(view: EditorView, token: string): boolean {
  const { state } = view;
  const lineNums = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lineNums.add(n);
  }
  const lines: CommentLine[] = [...lineNums].map((n) => {
    const l = state.doc.line(n);
    return { from: l.from, text: l.text };
  });
  const changes = computeCommentToggle(lines, token);
  if (!changes.length) return false;
  view.dispatch(state.update({ changes }));
  return true;
}

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
  const { schemas, updateTab, appendBatch, activeTabId, editorTick, editorAction, panels, togglePanel } = useStore();
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
  // `tab.connId` is a SESSION id — resolve it to the underlying connection
  // (session → connectionId → connection). Looking it up directly against
  // `connections` never matched, so the language toggle silently never
  // appeared.
  const conn = (() => {
    const st = useStore.getState();
    const session = st.sessions.find((s) => s.id === tab.connId);
    const connectionId = session?.connectionId ?? tab.connId; // legacy tabs stored a conn id directly
    return st.connections.find((c) => c.id === connectionId);
  })();
  // Engines that support JS scripting mode. SQL engines run SQL inside
  // db.query(...); Mongo runs a mongo-shell command string (db.coll.find({…}))
  // through the same seam. Redis/others have no db.query facade.
  const scriptEngines = new Set(["postgres", "mysql", "sqlite", "mongo"]);
  const scriptingAvailable = scriptEngines.has(conn?.engine ?? "");
  const isMongo = conn?.engine === "mongo";

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
    try {
      const outcome = await api.runScript(tab.connId, source);
      const ms = Math.round(performance.now() - started);
      // Defensive: a malformed/empty IPC response would otherwise throw an
      // opaque "reading 'data' of undefined". Surface a clear message instead.
      if (!outcome || typeof outcome !== "object") {
        throw new Error(
          `run_script returned no result (${outcome === undefined ? "undefined" : JSON.stringify(outcome)})`,
        );
      }
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
      // The console is always visible in the strip below, so keep the top pane
      // on Data — it shows the result set when there is one, and the console
      // shows logs + return value regardless.
      setView("data");
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
    // Guard: JavaScript typed into a SQL tab would be sent to Postgres as SQL
    // and come back as a cryptic "syntax error at or near const". Detect the
    // constructs and point the user at the Lang → JavaScript toggle instead of
    // running it — a common mix-up when the tab defaults to SQL. We scan the
    // whole script (not just the first line) because a leading comment can hide
    // the `const`/`await` opener, and match the scripting-only tokens
    // (`db.query`, `console.log`, `=>`, `${…}` templates, JS `//` after code)
    // that would never appear in valid SQL.
    // Only for SQL engines: a mongo-shell command (db.coll.find({…})) shares
    // tokens with JS, so this JS-detection would false-positive in Mongo's
    // non-script mode. The "syntax error at or near const" mix-up is SQL-only.
    if (scriptingAvailable && !isMongo && looksLikeJavaScript(rawSql)) {
      updateTab(tab.id, {
        running: false,
        error:
          'This looks like JavaScript. Switch the "Lang" selector to JavaScript to run scripts (db.query, loops, console.log).',
      });
      setStatusMsg("Looks like JavaScript — switch Lang to JavaScript.");
      setView("message");
      return;
    }
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
    // Script mode has no per-query handle — cancel by connection, which
    // flips the engine's cancel flag. SQL mode cancels via the query handle.
    if (isScript) {
      try { await api.cancelScript(tab.connId); } catch (e) { console.error(e); }
      return;
    }
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

  // React to menu-driven editor actions, but only on the active tab. Comment
  // toggling is NOT handled here — it's bound to the ⌘/ keymap on the live
  // editor view (see onCreateEditor), which acts directly on the EditorView.
  // Keeping it out of this effect avoids reading the editor ref inside an
  // effect (which the lint flow-analysis forbids).
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
  // Keep the current language's comment token in a ref the ⌘/ keymap can read
  // without re-registering the keymap on every lang change. Updated in an
  // effect (never during render) so it's lint-safe.
  const commentTokenRef = useRef("--");
  useEffect(() => {
    // JS script and Mongo shell both use // comments; only SQL uses --.
    commentTokenRef.current = isScript || isMongo ? "//" : "--";
  }, [isScript, isMongo]);

  // Language extension: schema-aware completion, picked by (lang, engine):
  //  - script mode → JS + db/console API,
  //  - Mongo non-script → mongo-shell completion (db.<coll>.<method>()),
  //  - SQL engines non-script → Postgres dialect + schema completion.
  // A Mongo tab must NOT get SQL keyword completion, and vice-versa.
  const langExt = isScript
    ? buildJsScriptExtension(tree)
    : isMongo
      ? buildMongoExtension(tree)
      : buildSqlExtension(tree);
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
  // Console height — same model as the editor split above: a percentage of
  // the results shell, user-draggable and persisted, so a script with lots of
  // console.log output can be given room without the grid disappearing.
  const [consolePct, setConsolePct] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem("nembrix.console.pct") ?? "");
      if (Number.isFinite(v) && v >= 10 && v <= 90) return v;
    } catch { /* localStorage off */ }
    return 33;
  });
  useEffect(() => {
    try { localStorage.setItem("nembrix.console.pct", String(consolePct)); } catch { /* ignore: best-effort */ }
  }, [consolePct]);
  const shellRef = useRef<HTMLDivElement>(null);
  const resultShellRef = useRef<HTMLDivElement>(null);
  // Ref to the CodeMirror EditorView so the wrapper's click handler
  // can dispatch a selection + focus on the live editor — the
  // domEventHandlers extension only fires for events that originate
  // INSIDE the editor's own DOM, so clicks on the wrapper padding /
  // the editor-wrap container were silently ignored.
  const editorViewRef = useRef<EditorView | null>(null);
  // Console strip auto-scroll: keep the newest log line in view as output
  // streams in (terminal behavior).
  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab.logs]);
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
  // Drag the console taller/shorter. Measured from the shell's BOTTOM edge
  // because the console is the bottom pane — dragging up grows it.
  const onConsoleDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const shell = resultShellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const fromBottom = rect.bottom - ev.clientY;
      const pct = Math.max(10, Math.min(90, (fromBottom / rect.height) * 100));
      setConsolePct(pct);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
            // ⌘/Ctrl+Enter runs — captured on the editor's DOM in the CAPTURE
            // phase so it fires before CodeMirror's own keydown handling, and
            // preventDefault'd so it can never fall through to the default
            // Enter → insert-newline. The Prec.highest keymap below wasn't
            // reliably winning on macOS (⌘↵ still inserted a line), so this
            // DOM capture is the definitive guard. Registered here (a callback)
            // so reading cmdsRef stays lint-safe.
            view.dom.addEventListener(
              "keydown",
              (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  cmdsRef.current.run();
                }
              },
              true, // capture
            );
            // Register the ⌘-shortcut keymap on the live view rather than via
            // the declarative `extensions` prop. The commands read cmdsRef to
            // reach the freshest run/format/save closures; doing this inside
            // onCreateEditor keeps that ref access inside a callback.
            view.dispatch({
              effects: StateEffect.appendConfig.of(
                Prec.highest(
                  keymap.of([
                    // Returning true tells CodeMirror the key was handled, which
                    // preventDefaults it — so ⌘↵ runs WITHOUT also inserting a
                    // newline / moving the cursor. `preventDefault: true` makes
                    // that explicit and robust across CM versions.
                    { key: "Mod-Enter", preventDefault: true, run: () => { cmdsRef.current.run(); return true; } },
                    { key: "Shift-Mod-Enter", preventDefault: true, run: () => { cmdsRef.current.run(); return true; } },
                    { key: "Mod-Shift-f", run: () => { cmdsRef.current.format(); return true; } },
                    { key: "Mod-i", run: () => { cmdsRef.current.format(); return true; } },
                    // ⌘/ toggles a line comment using the token for THIS tab's
                    // language (`--` for SQL, `//` for JavaScript) — the same
                    // editor serves both, so the comment must follow the mode.
                    {
                      key: "Mod-/",
                      preventDefault: true,
                      run: (v) => { toggleLineComment(v, commentTokenRef.current); return true; },
                    },
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
            // Tab accepts the open completion (instead of indenting the text).
            // Must come before langExt so it takes precedence over the SQL/JS
            // indent keymap when the popup is showing.
            completionTabKeymap,
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
        {/* Language toggle — flips the tab between the engine's native query
            language and JS scripting mode (db.query + loops). The native option
            is labelled per engine: "SQL" for RDBMS, "MongoDB" (shell) for Mongo. */}
        {scriptingAvailable && (
          <label className="limit-picker" title="Editor language for this tab">
            <span className="muted">Lang</span>
            <select
              value={tab.lang ?? "sql"}
              onChange={(e) =>
                updateTab(tab.id, { lang: e.target.value as "sql" | "script" })
              }
            >
              <option value="sql">{isMongo ? "MongoDB" : "SQL"}</option>
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
        {/* Only rendered while the results pane is hidden. Toggling it off
            (⌘2, easy to hit by accident next to ⌘1) unmounts the grid, the
            console AND the drag handle, so without this button the pane is
            unreachable unless you already know the shortcut. */}
        {!panels.results && (
          <button
            className="btn-pill"
            onClick={() => togglePanel("results")}
            title="Show the results pane (⌘2)"
            data-testid="show-results"
          >
            <PanelBottom size={12} /> Show Results <span className="kbd">⌘2</span>
          </button>
        )}
        {tab.running ? (
          <button className="btn-pill danger btn-run" onClick={cancel}>
            <Square size={12} /> Cancel
          </button>
        ) : (
          <button
            className="btn-pill primary btn-run"
            onClick={run}
            title={isScript ? "Run script (⌘↵)" : "Run current (⌘↵)"}
          >
            <Play size={12} /> {isScript ? "Run Script" : "Run Current"}
          </button>
        )}
      </div>

      {panels.results && (
        <div
          className="pane-split is-horizontal"
          onMouseDown={onSplitDrag}
          onDoubleClick={() => setEditorPct(50)}
          title="Drag to resize · double-click to reset"
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      {panels.results && (
      <div className="result-shell" ref={resultShellRef} style={{ flex: `1 1 ${100 - editorPct}%` }}>
        <div className="result-segments">
          <div className="segmented" role="tablist">
            <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>Data</button>
            {/* Scripts show their console in the always-visible strip below, so
                the tabbed "Message" view is SQL-only. */}
            {!isScript && (
              <button className={view === "message" ? "active" : ""} onClick={() => setView("message")}>Message</button>
            )}
            <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>Chart</button>
            <button className={view === "analysis" ? "active" : ""} onClick={() => setView("analysis")}>Analysis</button>
          </div>
          <span className="meta">
            {/* Row count + timer moved to the footer below the grid (calmer
                than a ticking timer in the header). Filter count stays here. */}
            {filters.length > 0 && `${filters.length} filter${filters.length === 1 ? "" : "s"}`}
          </span>
          <div className="spacer" />
          <span className="muted">{statusMsg}</span>
        </div>

        <FilterBar filters={filters} onRemove={removeFilter} onClear={clearFilters} />

        {/* The JS scripting engine runs in Rust and only exists in the desktop
            app. In browser / sidecar dev there's nothing to execute scripts, so
            make that explicit instead of letting a script silently do nothing. */}
        {isScript && !api.isTauri && (
          <div className="script-unavailable-banner">
            JavaScript scripts run in the desktop app. In browser/sidecar dev
            they can't execute — launch <code>yarn tauri dev</code> to run them.
          </div>
        )}

        <div className="result-body">
          {view === "data" && (tab.error
            ? <div className="message-pane err">{tab.error}</div>
            : <DataGrid tab={tab} />)}
          {/* SQL keeps the tabbed "Message" view; scripts show their console in
              the always-visible strip below instead (rendered separately). */}
          {view === "message" && !isScript && (
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

        {/* Slim status footer under the grid — row count + query time, same as
            the table-data view. Kept out of the header so the 10Hz-ticking
            timer doesn't flicker in the busy control lane. Data view only. */}
        {view === "data" && (
          <div className="data-view-footer">
            <span className="muted data-view-meta">
              {rowCount > 0
                ? `${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"}`
                : tab.running ? "" : "0 rows"}
              <RunningTimer
                running={tab.running}
                startedAt={tab.queryStartedAt}
                elapsedMs={tab.elapsedMs}
                prefix="· "
              />
            </span>
          </div>
        )}

        {/* Script console strip: sits below the data grid and is always
            visible in script mode, so console.log output and the return-value
            echo show alongside the result set (no tab-switching). */}
        {isScript && (
          <div
            className="pane-split is-horizontal"
            data-testid="console-split"
            onMouseDown={onConsoleDrag}
            onDoubleClick={() => setConsolePct(33)}
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-orientation="horizontal"
          />
        )}
        {isScript && (
          <div className="script-console" style={{ flexBasis: `${consolePct}%` }}>
            <div className="script-console-head">
              <span className="muted">Console</span>
              {(tab.logs?.length ?? 0) > 0 && (
                <span className="script-console-count">
                  {tab.logs!.length} line{tab.logs!.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="script-log" ref={consoleRef}>
              {(tab.logs?.length ?? 0) > 0 ? (
                tab.logs!.map((l, i) => (
                  <div key={i} className={`log-line log-${l.level}`}>
                    {l.text}
                  </div>
                ))
              ) : (
                <div className="log-line log-muted">
                  {tab.running
                    ? "Running…"
                    : "No console output yet. Use console.log(...) in your script."}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
