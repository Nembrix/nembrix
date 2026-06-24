import { useMemo, useState } from "react";
import { CheckCircle2, Download, FolderOpen, X } from "lucide-react";
import type { ColMeta, CellValue, RowBatch } from "@/ipc/types";
import * as api from "@/ipc/commands";
import { isTauri } from "@/ipc/commands";
import {
  DEFAULT_CSV, DEFAULT_JSON, exportRows, suggestExt, mimeType,
  type ExportFormat, type CsvOptions, type JsonOptions,
} from "./format";
import { loadPrefs } from "@/features/preferences/prefs";

/** Persisted preference: when set, success dialog is skipped and we just close. */
const SKIP_SUCCESS_KEY = "nembrix.export.skipSuccess";
const skipSuccessDialog = () => {
  try { return localStorage.getItem(SKIP_SUCCESS_KEY) === "1"; }
  catch { return false; }
};
const setSkipSuccessDialog = () => {
  try { localStorage.setItem(SKIP_SUCCESS_KEY, "1"); }
  catch { /* ignore */ }
};

interface Props {
  /** When non-null, the dialog can re-query the full relation. */
  source?: { schema: string; table: string };
  connId: string;
  /** Rows already loaded in the data view — used as default & quick path. */
  columns: ColMeta[];
  rows: CellValue[][];
  onClose: () => void;
}

type RowMode = "loaded" | "all";

export default function ExportDialog({ source, connId, columns, rows, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [rowMode, setRowMode] = useState<RowMode>("loaded");
  const [included, setIncluded] = useState<string[]>(() => columns.map((c) => c.name));
  // Seed CSV defaults from the user's global Preferences so an export
  // doesn't surprise them with comma-vs-tab or NULL-token mismatches
  // when they've already configured their preference once.
  const [csv, setCsv] = useState<CsvOptions>(() => {
    const p = loadPrefs().csv;
    return {
      ...DEFAULT_CSV,
      delimiter: p.delimiter,
      nullToken: p.nullToken,
      lineEnding: p.lineEnding,
    };
  });
  const [json, setJson] = useState<JsonOptions>(DEFAULT_JSON);
  const [batchSize, setBatchSize] = useState(100);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** "configure" → the form; "fetching" → showing a spinner with row
   *  count; "writing" → about to invoke the save dialog; "done" → the
   *  success panel (unless the user opted out). */
  const [phase, setPhase] = useState<"configure" | "fetching" | "writing" | "done">("configure");
  const [rowsCopied, setRowsCopied] = useState(0);
  const [rowsTotal, setRowsTotal] = useState<number | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const allChosen = included.length === columns.length;
  const filename = useMemo(() => {
    const base = source ? `${source.schema}.${source.table}` : "export";
    return `${base}.${suggestExt(format)}`;
  }, [source, format]);

  const toggle = (name: string) =>
    setIncluded((cur) => cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name]);
  const allOn = () => setIncluded(columns.map((c) => c.name));
  const allOff = () => setIncluded([]);

  const run = async () => {
    setErr(null);
    setWorking(true);
    setRowsCopied(0);
    setRowsTotal(null);
    setSavedPath(null);
    try {
      let exportColumns = columns;
      let exportRowsArr = rows;
      if (rowMode === "all" && source) {
        setPhase("fetching");
        // Re-query the whole relation. We use stream() and drain to a single
        // buffer, reporting progress to the dialog as rows arrive.
        const { cols, batches } = await fetchAll(connId, source, (n) => setRowsCopied(n));
        exportColumns = cols;
        exportRowsArr = batches.flatMap((b) => b.rows);
        setRowsTotal(exportRowsArr.length);
      } else {
        setRowsTotal(rows.length);
        setRowsCopied(rows.length);
      }
      setPhase("writing");
      const text = exportRows({
        format,
        columns: exportColumns,
        rows: exportRowsArr,
        includeColumns: allChosen ? null : included,
        csv,
        json,
        sql: source ? { qualifiedTarget: `"${source.schema}"."${source.table}"`, batchSize } : { batchSize },
      });
      const path = await saveToDisk(text, filename, format);
      // User cancelled the OS save dialog — no path, no success view.
      if (path === null) {
        setPhase("configure");
        return;
      }
      setSavedPath(path);
      // Skip the success panel when the user opted out previously.
      if (skipSuccessDialog()) {
        onClose();
        return;
      }
      setPhase("done");
    } catch (e) {
      setErr(String(e));
      setPhase("configure");
    } finally {
      setWorking(false);
    }
  };

  /** Reveal the saved file in the OS file manager. Tauri only. */
  const revealInFolder = async () => {
    if (!savedPath) return;
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      // Open the *containing* folder, not the file itself, so the user
      // doesn't accidentally double-launch their default app.
      const sep = savedPath.includes("\\") ? "\\" : "/";
      const dir = savedPath.slice(0, savedPath.lastIndexOf(sep));
      await open(dir || savedPath);
    } catch (e) {
      setErr(String(e));
    } finally {
      onClose();
    }
  };

  /* ─── Success view (phase === "done") ─── */
  if (phase === "done") {
    const filenameDisplay = savedPath
      ? savedPath.split(/[\\/]/).pop() ?? savedPath
      : filename;
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <CheckCircle2 size={14} style={{ color: "var(--ok)" }} />
            <span>Success</span>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <div className="modal-body export-success">
            <p style={{ margin: 0 }}>Export completed successfully.</p>
            <p className="muted mono" style={{ marginTop: 8, wordBreak: "break-all" }}>
              {filenameDisplay} — {rowsCopied.toLocaleString()} rows
            </p>
            {savedPath && savedPath !== filenameDisplay && (
              <p className="muted mono" style={{ marginTop: 4, fontSize: 11, wordBreak: "break-all" }}>
                {savedPath}
              </p>
            )}
            <div className="export-success-actions">
              <button
                className="btn-pill primary"
                onClick={revealInFolder}
                disabled={!isTauri || !savedPath}
                title={!isTauri ? "Folder reveal is only available in the desktop app" : "Reveal the saved file"}
              >
                <FolderOpen size={12} /> Open containing folder
              </button>
              <button className="btn-pill" onClick={onClose}>Close</button>
              <button
                className="btn-link"
                onClick={() => { setSkipSuccessDialog(); onClose(); }}
                title="Skip this dialog on future exports"
              >
                Don&apos;t show this again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ─── Progress view (phase === "fetching" | "writing") ─── */
  if (phase === "fetching" || phase === "writing") {
    const pctKnown = rowsTotal != null && rowsTotal > 0;
    const pct = pctKnown ? Math.min(100, (rowsCopied / rowsTotal!) * 100) : null;
    return (
      <div className="modal-backdrop">
        <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <Download size={14} />
            <span>Exporting…</span>
            <span style={{ flex: 1 }} />
          </div>
          <div className="modal-body">
            <p style={{ margin: "8px 0" }}>
              {phase === "fetching" ? "Fetching rows from the database…" : "Writing file…"}
            </p>
            <div className="export-progress-bar" aria-label="export progress">
              <div
                className={`export-progress-fill ${pct == null ? "indeterminate" : ""}`}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            <p className="muted mono" style={{ marginTop: 8, fontSize: 11 }}>
              {rowsCopied.toLocaleString()} row{rowsCopied === 1 ? "" : "s"} so far
              {pctKnown ? ` · ${pct!.toFixed(0)}%` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ─── Configure view (phase === "configure") ─── */
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Download size={14} />
          <span>Export {source ? `${source.schema}.${source.table}` : "result"}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>Format</label>
            <div className="segmented" style={{ width: "fit-content" }}>
              {(["csv", "json", "jsonl", "sql"] as ExportFormat[]).map((f) => (
                <button key={f} className={format === f ? "active" : ""} onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>

            <label>Rows</label>
            <div className="segmented" style={{ width: "fit-content" }}>
              <button
                className={rowMode === "loaded" ? "active" : ""}
                onClick={() => setRowMode("loaded")}
                title="Export only the rows currently loaded in the grid"
              >
                Current page ({rows.length})
              </button>
              <button
                className={rowMode === "all" ? "active" : ""}
                onClick={() => setRowMode("all")}
                disabled={!source}
                title={source ? "Re-query the table and export every row" : "All-rows export needs a table source"}
              >
                All rows
              </button>
            </div>

            {format === "csv" && (
              <>
                <div className="section-title">CSV</div>
                <label>Delimiter</label>
                <select value={csv.delimiter} onChange={(e) => setCsv({ ...csv, delimiter: e.target.value })}>
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                  <option value={"\t"}>Tab</option>
                  <option value="|">Pipe</option>
                </select>
                <label>Header row</label>
                <div>
                  <input type="checkbox" checked={csv.header} onChange={(e) => setCsv({ ...csv, header: e.target.checked })} />
                </div>
                <label>NULL token</label>
                <input
                  type="text"
                  value={csv.nullToken}
                  onChange={(e) => setCsv({ ...csv, nullToken: e.target.value })}
                  placeholder={`empty by default — try "\\N" for psql COPY`}
                />
                <label>Line ending</label>
                <select value={csv.lineEnding} onChange={(e) => setCsv({ ...csv, lineEnding: e.target.value as "\n" | "\r\n" })}>
                  <option value="\n">LF</option>
                  <option value="\r\n">CRLF</option>
                </select>
              </>
            )}

            {format === "json" && (
              <>
                <label>Indent</label>
                <select value={json.indent} onChange={(e) => setJson({ ...json, indent: parseInt(e.target.value) })}>
                  <option value={0}>None</option>
                  <option value={2}>2 spaces</option>
                  <option value={4}>4 spaces</option>
                </select>
              </>
            )}

            {format === "sql" && (
              <>
                <label>Rows per INSERT</label>
                <input
                  type="number"
                  value={batchSize}
                  min={1}
                  max={10000}
                  onChange={(e) => setBatchSize(parseInt(e.target.value || "100"))}
                />
                <div className="full muted">
                  Target: <code>"{source?.schema ?? "?"}"."{source?.table ?? "?"}"</code>
                </div>
              </>
            )}

            <div className="section-title">Columns ({included.length}/{columns.length})</div>
            <div className="full" style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <button className="btn-link" onClick={allOn}>Select all</button>
              <button className="btn-link" onClick={allOff}>None</button>
            </div>
            <div className="full export-columns">
              {columns.map((c) => (
                <label key={c.name} className="export-column">
                  <input
                    type="checkbox"
                    checked={included.includes(c.name)}
                    onChange={() => toggle(c.name)}
                  />
                  <span>{c.name}</span>
                  <span className="muted type">{c.type_name}</span>
                </label>
              ))}
            </div>
          </div>

          {err && <div className="message-pane err" style={{ padding: 8, marginTop: 8 }}>{err}</div>}
        </div>
        <div className="modal-footer">
          <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
            → {filename}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>Cancel</button>
          <button
            className="btn-pill primary"
            disabled={working || included.length === 0}
            onClick={run}
          >
            {working ? "Exporting…" : isTauri ? "Save to file…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── helpers ─────────────── */

async function fetchAll(
  connId: string,
  rel: { schema: string; table: string },
  onProgress?: (rowsSoFar: number) => void,
): Promise<{ cols: ColMeta[]; batches: RowBatch[] }> {
  return new Promise((resolve, reject) => {
    const batches: RowBatch[] = [];
    let cols: ColMeta[] = [];
    let total = 0;
    const sql = `SELECT * FROM "${rel.schema}"."${rel.table}"`;
    api.stream(connId, sql, (b) => {
      if (b.columns) cols = b.columns;
      batches.push(b);
      total += b.rows.length;
      onProgress?.(total);
      if (b.done) resolve({ cols, batches });
    }).catch(reject);
  });
}

/**
 * Save the exported text. Returns the path it landed at (Tauri) or a
 * synthetic "Downloads/<filename>" string (browser, where we don't get a
 * real path back from the download anchor). Returns null when the user
 * cancels the Tauri save dialog so the caller can stay on the form.
 */
async function saveToDisk(text: string, filename: string, format: ExportFormat): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename, filters: [{ name: format.toUpperCase(), extensions: [suggestExt(format)] }] });
    if (!path) return null;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, text);
    return path;
  }
  // Browser: trigger a download via an anchor + Blob URL.
  const blob = new Blob([text], { type: mimeType(format) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // We don't actually know the OS path the browser chose, so report a
  // best-effort "in your Downloads folder" so the success view says
  // something useful.
  return `Downloads/${filename}`;
}
