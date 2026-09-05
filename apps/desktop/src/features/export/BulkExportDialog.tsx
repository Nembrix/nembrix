import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { CellValue, ColMeta, RelationNode } from "@/ipc/types";
import * as api from "@/ipc/commands";
import { isTauri } from "@/ipc/commands";
import {
  exportRows, suggestExt, fileBase, type ExportFormat,
} from "./format";

type Status = "pending" | "running" | "done" | "error";
interface JobRow {
  schema: string;
  name: string;
  status: Status;
  rows?: number;
  bytes?: number;
  error?: string;
}

interface Props {
  connId: string;
  /** Optional schema preselected from the inspector. */
  preselectSchema?: string;
  onClose: () => void;
}

/**
 * Export many tables into a folder (Tauri) or a single concatenated text
 * file (browser fallback). The actual write strategy depends on the host:
 *
 *   Tauri:   pick a folder, one file per table written via plugin-fs.
 *   Browser: pick nothing, write one concatenated download with
 *            `-- TABLE schema.name` separators. Lossless when format ∈
 *            {csv, sql, jsonl}; for plain JSON we wrap each block in
 *            comments so the user can split manually.
 */
export default function BulkExportDialog({ connId, preselectSchema, onClose }: Props) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState<string>(preselectSchema ?? "public");
  const [relations, setRelations] = useState<RelationNode[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [folder, setFolder] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Load schemas + relations.
  useEffect(() => {
    let cancelled = false;
    api.introspect(connId)
      .then((tree) => {
        if (cancelled) return;
        const list = tree.databases[0]?.schemas ?? [];
        setSchemas(list.map((s) => s.name));
        if (preselectSchema && !list.find((s) => s.name === preselectSchema) && list[0]) {
          setSchema(list[0].name);
        }
      })
      .catch((e) => setErr(String(e)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  useEffect(() => {
    let cancelled = false;
    api.introspect(connId).then((tree) => {
      if (cancelled) return;
      const sc = tree.databases[0]?.schemas.find((s) => s.name === schema);
      const rels = [...(sc?.tables ?? []), ...(sc?.views ?? [])];
      setRelations(rels);
      setIncluded(new Set(rels.map((r) => r.name)));
    });
    return () => { cancelled = true; };
  }, [connId, schema]);

  const filtered = useMemo(() => {
    if (!filter) return relations;
    const f = filter.toLowerCase();
    return relations.filter((r) => r.name.toLowerCase().includes(f));
  }, [relations, filter]);

  const toggle = (name: string) =>
    setIncluded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  const allOn = () => setIncluded(new Set(relations.map((r) => r.name)));
  const allOff = () => setIncluded(new Set());

  /** Opens the directory picker. Returns the chosen path (and stores it), or
   *  null if the user cancelled. The return value matters: `start` needs the
   *  path in the same tick, and `setFolder` won't have applied by then. */
  const pickFolder = async (): Promise<string | null> => {
    if (!isTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, multiple: false });
    if (typeof result === "string") {
      setFolder(result);
      return result;
    }
    return null;
  };

  // Set when a run finishes with every table exported. Drives a short
  // success beat before the dialog closes itself, so the outcome is visible
  // rather than the window just vanishing.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => onClose(), 900);
    return () => clearTimeout(t);
  }, [done, onClose]);

  const start = async () => {
    setErr(null);
    // No destination yet? Ask for one now rather than refusing the click. A
    // cancelled picker aborts quietly — the user chose not to proceed, so a
    // warning would be noise.
    let dest = folder;
    if (isTauri && !dest) {
      dest = await pickFolder();
      if (!dest) return;
    }
    setRunning(true);
    const targets = relations.filter((r) => included.has(r.name));
    const initial: JobRow[] = targets.map((r) => ({ schema, name: r.name, status: "pending" }));
    setJobs(initial);
    try {
      if (isTauri && dest) {
        for (let i = 0; i < targets.length; i++) {
          setJobs((cur) => cur.map((j, ix) => ix === i ? { ...j, status: "running" } : j));
          try {
            const { cols, rows } = await fetchAll(connId, schema, targets[i].name);
            const text = exportRows({
              format, columns: cols, rows,
              sql: { qualifiedTarget: `"${schema}"."${targets[i].name}"`, batchSize: 100 },
            });
            const { writeTextFile } = await import("@tauri-apps/plugin-fs");
            const path = `${dest}/${fileBase(schema, targets[i].name)}.${suggestExt(format)}`;
            await writeTextFile(path, text);
            setJobs((cur) => cur.map((j, ix) => ix === i
              ? { ...j, status: "done", rows: rows.length, bytes: text.length } : j));
          } catch (e) {
            setJobs((cur) => cur.map((j, ix) => ix === i
              ? { ...j, status: "error", error: String(e) } : j));
          }
        }
      } else {
        // Browser: one concatenated download.
        const parts: string[] = [];
        for (let i = 0; i < targets.length; i++) {
          setJobs((cur) => cur.map((j, ix) => ix === i ? { ...j, status: "running" } : j));
          try {
            const { cols, rows } = await fetchAll(connId, schema, targets[i].name);
            const text = exportRows({
              format, columns: cols, rows,
              sql: { qualifiedTarget: `"${schema}"."${targets[i].name}"`, batchSize: 100 },
            });
            parts.push(`-- ════════════════════════════════════════
-- ${schema}.${targets[i].name}  (${rows.length} rows)
-- ════════════════════════════════════════
${text}`);
            setJobs((cur) => cur.map((j, ix) => ix === i
              ? { ...j, status: "done", rows: rows.length, bytes: text.length } : j));
          } catch (e) {
            setJobs((cur) => cur.map((j, ix) => ix === i
              ? { ...j, status: "error", error: String(e) } : j));
          }
        }
        const combined = parts.join("\n\n");
        const blob = new Blob([combined], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${schema}-bulk-export.${suggestExt(format)}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }

    // Close on a clean run — the dialog has nothing left to say, and leaving
    // it up means an extra click every time. Any failure keeps it open so the
    // per-table errors stay readable.
    setJobs((cur) => {
      if (cur.length > 0 && cur.every((j) => j.status === "done")) {
        setDone(true);
      }
      return cur;
    });
  };

  // A missing destination folder does NOT disable Export — clicking opens the
  // folder picker and then runs, so the common path is one click instead of
  // "notice the disabled button, find Browse, come back". Only a genuinely
  // unsatisfiable state (no tables selected) disables it.
  const settledCount = jobs.filter((j) => j.status === "done" || j.status === "error").length;
  const failedCount = jobs.filter((j) => j.status === "error").length;
  const blockedReason = running || included.size > 0 ? null : "Select at least one table.";
  const canStart = !running && included.size > 0;

  return (
    // While a run is in flight the dialog is locked: a backdrop click or ✕
    // would unmount the component mid-loop, leaving the remaining writes to
    // finish against a dead tree with no way to see what happened.
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Download size={14} />
          <span>Bulk export</span>
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={running}
            title={running ? "Export in progress…" : "Close"}
          >
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>Schema</label>
            <select value={schema} onChange={(e) => setSchema(e.target.value)}>
              {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>

            <label>Format</label>
            <div className="segmented" style={{ width: "fit-content" }}>
              {(["csv", "json", "jsonl", "sql"] as ExportFormat[]).map((f) => (
                <button key={f} className={format === f ? "active" : ""} onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>

            {isTauri && (
              <>
                <label>Folder</label>
                <div className="row-flex">
                  <input
                    type="text"
                    value={folder ?? ""}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Pick a folder… (or just hit Export)"
                    style={{ flex: 1 }}
                  />
                  <button className="btn-pill" onClick={pickFolder}>
                    <FolderOpen size={12} /> Browse
                  </button>
                </div>
              </>
            )}

            <div className="section-title">Tables ({included.size}/{relations.length})</div>
            <div className="full" style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input
                className="search-input"
                style={{ flex: 1, paddingLeft: 8 }}
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button className="btn-link" onClick={allOn}>Select all</button>
              <button className="btn-link" onClick={allOff}>None</button>
            </div>
            {/* maxHeight is a whole number of rows (7 x 30px + padding) so the
                scroll edge lands between rows instead of slicing one in half,
                which read as a rendering glitch. */}
            <div className="full export-columns" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", maxHeight: 232 }}>
              {filtered.map((r) => (
                <label key={r.name} className="export-column">
                  <input
                    type="checkbox"
                    checked={included.has(r.name)}
                    onChange={() => toggle(r.name)}
                  />
                  <span>{r.name}</span>
                </label>
              ))}
              {filtered.length === 0 && (
                <span className="muted">No relations match.</span>
              )}
            </div>

            {jobs.length > 0 && (
              <>
                <div className="section-title">Progress</div>
                {/* Aggregate bar: with 40 tables the per-row list alone doesn't
                    answer "how far along is this?" without scrolling. */}
                <div className="full bulk-progress">
                  <div className="bulk-progress-track">
                    <div
                      className={`bulk-progress-fill ${failedCount > 0 ? "has-error" : ""}`}
                      style={{ width: `${jobs.length ? (settledCount / jobs.length) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="bulk-progress-label mono">
                    {settledCount}/{jobs.length}
                    {failedCount > 0 && ` · ${failedCount} failed`}
                    {done && " · done"}
                  </span>
                </div>
                <div className="full bulk-jobs">
                  {jobs.map((j) => (
                    <div key={`${j.schema}.${j.name}`} className={`bulk-job status-${j.status}`}>
                      {/* Matches the filename the export actually writes, so
                          the row and the file on disk read the same. */}
                      <span className="bulk-job-name mono">{fileBase(j.schema, j.name)}</span>
                      <span className="bulk-job-status">
                        {j.status === "pending"  && "queued"}
                        {j.status === "running"  && "exporting…"}
                        {j.status === "done"     && (
                          <><CheckCircle2 size={11} /> {j.rows} rows · {fmtBytes(j.bytes ?? 0)}</>
                        )}
                        {j.status === "error"    && (
                          <><AlertTriangle size={11} /> {j.error?.slice(0, 60)}</>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {err && <div className="message-pane err" style={{ padding: 8, marginTop: 8 }}>{err}</div>}
        </div>
        <div className="modal-footer">
          {isTauri && folder && (
            <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
              → {folder}
            </span>
          )}
          {!isTauri && (
            <span className="muted" style={{ fontSize: 11 }}>
              Browser mode: one combined download (run <code>cargo tauri dev</code> for one file per table).
            </span>
          )}
          {blockedReason && <span className="muted export-blocked">{blockedReason}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose} disabled={running}>Close</button>
          <button
            className="btn-pill primary"
            disabled={!canStart}
            onClick={start}
            title={blockedReason ?? "Start the export"}
          >
            {running ? "Exporting…" : `Export ${included.size} ${included.size === 1 ? "table" : "tables"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

async function fetchAll(connId: string, schema: string, table: string):
  Promise<{ cols: ColMeta[]; rows: CellValue[][] }> {
  return new Promise((resolve, reject) => {
    let cols: ColMeta[] = [];
    const rows: CellValue[][] = [];
    api.stream(connId, `SELECT * FROM "${schema}"."${table}"`, (b) => {
      if (b.columns) cols = b.columns;
      rows.push(...b.rows);
      if (b.done) resolve({ cols, rows });
    }).catch(reject);
  });
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
