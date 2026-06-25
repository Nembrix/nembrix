import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, FolderOpen, Upload, X,
} from "lucide-react";
import * as api from "@/ipc/commands";
import { useStore } from "@/store";
import { loadPrefs } from "@/features/preferences/prefs";
import { composeInsert } from "./insert";
import type { ConflictMode } from "./insert";
import {
  detectFormat, parseCsv, parseJson, parseJsonl, splitSql,
  type ImportFormat, type ParsedTable,
} from "./parse";

type Status = "pending" | "running" | "done" | "error";
interface JobRow { ix: number; status: Status; error?: string }

interface Props {
  connId: string;
  /** Defaults for the target picker. */
  schema?: string;
  onClose: () => void;
}

/**
 * Render a parsed cell as a short preview string. null/undefined become a
 * dimmed sentinel; long strings are truncated; objects show JSON.
 */
function formatPreview(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") {
    if (v.length === 0) return "''";
    return v.length > 24 ? v.slice(0, 23) + "…" : v;
  }
  if (typeof v === "object") {
    try { const s = JSON.stringify(v); return s.length > 24 ? s.slice(0, 23) + "…" : s; }
    catch { return String(v); }
  }
  const s = String(v);
  return s.length > 24 ? s.slice(0, 23) + "…" : s;
}

const CONFLICT_LABELS: Record<ConflictMode, string> = {
  stop:   "Stop on conflict",
  skip:   "Skip on conflict",
  update: "Update on conflict",
};

export default function ImportDialog({ connId, schema: schemaProp, onClose }: Props) {
  const { schemas } = useStore();
  const tree = schemas[connId];

  /* ─── source ─── */
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
  const [format, setFormat] = useState<ImportFormat>("csv");
  const fileRef = useRef<HTMLInputElement>(null);

  /* ─── csv dialect ─── */
  // Seed from global Preferences so the user's NULL token / delimiter
  // choices match between Preferences, Export, and Import without them
  // having to retype it in every dialog.
  const [delimiter, setDelimiter] = useState(() => loadPrefs().csv.delimiter);
  const [hasHeader, setHasHeader] = useState(true);
  const [nullToken, setNullToken] = useState(() => loadPrefs().csv.nullToken);
  const [emptyIsNull, setEmptyIsNull] = useState(() => loadPrefs().csv.emptyIsNull);

  /* ─── target ─── */
  const [schema, setSchema] = useState(schemaProp ?? "public");
  const [table, setTable] = useState<string>("");

  /* ─── conflict resolution ─── */
  const [mode, setMode] = useState<ConflictMode>("stop");
  /** Names of columns making up the conflict key, in the target table's terms. */
  const [conflictKey, setConflictKey] = useState<string[]>([]);

  /* ─── column mapping ─── */
  /** source column index → target column name ("" = drop). */
  const [mapping, setMapping] = useState<Record<number, string>>({});
  /** Remembers the last non-empty target per source col so toggling include
   * off and back on restores the prior choice instead of nuking it. */
  const lastMappingRef = useRef<Record<number, string>>({});

  /* ─── run state ─── */
  const [parsed, setParsed] = useState<ParsedTable | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [topErr, setTopErr] = useState<string | null>(null);

  /* Derived: table list + column metadata for the selected target table. */
  const tables = useMemo(() => {
    const sc = tree?.databases[0]?.schemas.find((s) => s.name === schema);
    return [...(sc?.tables ?? []), ...(sc?.views ?? [])];
  }, [tree, schema]);
  const targetRel = useMemo(() => tables.find((t) => t.name === table), [tables, table]);

  // Default conflict key to the table's PK whenever the target table changes.
  useEffect(() => {
    if (targetRel) setConflictKey(targetRel.primary_key);
  }, [targetRel]);

  // Re-parse whenever text / format / dialect changes.
  useEffect(() => {
    if (!text) { setParsed(null); setParseErr(null); return; }
    try {
      let p: ParsedTable | null = null;
      if (format === "csv") {
        p = parseCsv(text, {
          delimiter, quote: '"', header: hasHeader,
          nullToken: nullToken === "" ? null : nullToken,
          emptyIsNull,
        });
      } else if (format === "json") {
        p = parseJson(text);
      } else if (format === "jsonl") {
        p = parseJsonl(text);
      } else {
        // SQL doesn't produce a row table; just count statements.
        p = { columns: [], rows: splitSql(text).map((s) => [s]) };
      }
      setParsed(p);
      setParseErr(null);
    } catch (e) {
      setParseErr(String(e));
      setParsed(null);
    }
  }, [text, format, delimiter, hasHeader, nullToken, emptyIsNull]);

  // Auto-map source columns by exact (case-insensitive) name match when the
  // mapping is empty or the schema/parsed columns have changed.
  useEffect(() => {
    if (format === "sql" || !parsed) return;
    const tgt = targetRel?.columns.map((c) => c.name) ?? [];
    const auto: Record<number, string> = {};
    parsed.columns.forEach((srcName, i) => {
      const hit = tgt.find((t) => t.toLowerCase() === srcName.toLowerCase());
      auto[i] = hit ?? "";
    });
    setMapping(auto);
  }, [parsed, targetRel, format]);

  /* ─── file load ─── */

  const onPickFile = () => fileRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const t = await f.text();
    setFilename(f.name);
    setText(t);
    setFormat(detectFormat(f.name, t.slice(0, 4096)));
  };

  /* ─── run ─── */

  const start = async () => {
    if (!parsed) return;
    setWorking(true);
    setTopErr(null);
    try {
      if (format === "sql") {
        await runSql(parsed.rows.map((r) => r[0] as string));
      } else {
        if (!table) throw new Error("Pick a target table");
        await runRows(parsed);
      }
    } catch (e) {
      setTopErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  const runSql = async (statements: string[]) => {
    const initial: JobRow[] = statements.map((_, ix) => ({ ix, status: "pending" }));
    setJobs(initial);
    await api.execute(connId, "BEGIN;");
    let failed = false;
    for (let i = 0; i < statements.length; i++) {
      setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "running" } : j));
      try {
        await api.execute(connId, statements[i]);
        setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "done" } : j));
      } catch (e) {
        setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "error", error: String(e) } : j));
        failed = true;
        break;
      }
    }
    await api.execute(connId, failed ? "ROLLBACK;" : "COMMIT;");
  };

  const runRows = async (p: ParsedTable) => {
    const qt = `"${schema}"."${table}"`;
    // Build mapped column list + value transform.
    const targetCols: string[] = [];
    const srcIdx: number[] = [];
    p.columns.forEach((_src, i) => {
      const t = mapping[i];
      if (t) { targetCols.push(t); srcIdx.push(i); }
    });
    if (targetCols.length === 0) throw new Error("No columns mapped");

    const initial: JobRow[] = p.rows.map((_, ix) => ({ ix, status: "pending" }));
    setJobs(initial);

    await api.execute(connId, "BEGIN;");
    let failed = false;
    for (let i = 0; i < p.rows.length; i++) {
      setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "running" } : j));
      const row = srcIdx.map((s) => p.rows[i][s]);
      const sql = composeInsert(
        { qualifiedTarget: qt, columns: targetCols, conflictKey, mode },
        row,
      );
      try {
        await api.execute(connId, sql);
        setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "done" } : j));
      } catch (e) {
        setJobs((cur) => cur.map((j) => j.ix === i ? { ...j, status: "error", error: String(e) } : j));
        if (mode === "stop") { failed = true; break; }
      }
    }
    await api.execute(connId, failed ? "ROLLBACK;" : "COMMIT;");
    // Refresh schema after a successful import (target table stats etc).
    if (!failed) {
      try { useStore.getState().setSchema(connId, await api.introspect(connId)); } catch { /* ignore: best-effort */ }
    }
  };

  /* ─── derived totals for the progress strip ─── */
  const doneCount  = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;
  const rowCount   = parsed?.rows.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 880 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Upload size={14} />
          <span>Import</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>File</label>
            <div className="row-flex">
              <input
                type="text"
                value={filename || "No file selected"}
                disabled
                style={{ flex: 1 }}
              />
              <button className="btn-pill" onClick={onPickFile}>
                <FolderOpen size={12} /> Browse…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.json,.jsonl,.ndjson,.sql,text/*"
                style={{ display: "none" }}
                onChange={onFileChange}
                data-testid="import-file"
              />
            </div>

            <label>Format</label>
            <div className="segmented" style={{ width: "fit-content" }}>
              {(["csv", "json", "jsonl", "sql"] as ImportFormat[]).map((f) => (
                <button key={f} className={format === f ? "active" : ""} onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>

            {format === "csv" && (
              <>
                <div className="section-title">CSV options</div>
                <label>Delimiter</label>
                <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                  <option value={"\t"}>Tab</option>
                  <option value="|">Pipe</option>
                </select>
                <label>Header row</label>
                <div><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /></div>
                <label>NULL token</label>
                <input
                  type="text"
                  value={nullToken}
                  onChange={(e) => setNullToken(e.target.value)}
                  placeholder={`"NULL" (default), "\\N" for psql COPY, or blank to disable`}
                  title="Unquoted cells matching this text are parsed as NULL"
                />
                <label>Empty cell = NULL</label>
                <div>
                  <input
                    type="checkbox"
                    checked={emptyIsNull}
                    onChange={(e) => setEmptyIsNull(e.target.checked)}
                  />
                  <span className="muted" style={{ marginLeft: 6 }}>
                    Off (default): empty stays as empty string. Useful for nullable text columns where "" and NULL mean different things.
                  </span>
                </div>
              </>
            )}

            {format !== "sql" && (
              <>
                <div className="section-title">Target</div>
                <label>Schema</label>
                <select value={schema} onChange={(e) => setSchema(e.target.value)}>
                  {(tree?.databases[0]?.schemas ?? []).map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
                <label>Table</label>
                <select value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">— pick a table —</option>
                  {tables.map((t) => (
                    <option key={t.name} value={t.name}>{t.name}</option>
                  ))}
                </select>

                <div className="section-title">On conflict</div>
                <label>Strategy</label>
                <select value={mode} onChange={(e) => setMode(e.target.value as ConflictMode)}>
                  {(["stop", "skip", "update"] as ConflictMode[]).map((m) => (
                    <option key={m} value={m}>{CONFLICT_LABELS[m]}</option>
                  ))}
                </select>
                {mode !== "stop" && (
                  <>
                    <label>Conflict key</label>
                    <select
                      value={conflictKey.join(",")}
                      onChange={(e) => setConflictKey(e.target.value ? e.target.value.split(",") : [])}
                      data-testid="conflict-key"
                    >
                      <option value="">(none)</option>
                      {targetRel?.primary_key.length ? (
                        <option value={targetRel.primary_key.join(",")}>
                          PK: {targetRel.primary_key.join(", ")}
                        </option>
                      ) : null}
                      {(targetRel?.columns ?? []).map((c) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </>
                )}

                {parsed && targetRel && (
                  <>
                    <div className="section-title">
                      Column mapping &amp; preview
                      <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                        — uncheck to skip a column
                      </span>
                    </div>
                    <div className="full">
                      <table className="meta-table import-mapping">
                        <thead><tr>
                          <th style={{ width: 28 }}></th>
                          <th>Source</th>
                          <th></th>
                          <th>Target</th>
                          <th>Sample values</th>
                        </tr></thead>
                        <tbody>
                          {parsed.columns.map((src, i) => {
                            const included = (mapping[i] ?? "") !== "";
                            const sample = parsed.rows.slice(0, 3)
                              .map((r) => formatPreview(r[i]));
                            return (
                              <tr key={`${src}-${i}`} className={included ? "" : "row-skipped"}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={included}
                                    data-testid={`include-${i}`}
                                    onChange={(e) => setMapping((m) => {
                                      const next = { ...m };
                                      if (e.target.checked) {
                                        // Re-include: prefer prior mapping, else name-match, else first free col.
                                        const lastTgt = lastMappingRef.current[i];
                                        const named = targetRel.columns.find(
                                          (c) => c.name.toLowerCase() === src.toLowerCase(),
                                        )?.name;
                                        next[i] = lastTgt || named || targetRel.columns[0]?.name || "";
                                      } else {
                                        lastMappingRef.current[i] = next[i] ?? "";
                                        next[i] = "";
                                      }
                                      return next;
                                    })}
                                  />
                                </td>
                                <td className="mono">{src}</td>
                                <td><ArrowRight size={11} className="muted" /></td>
                                <td>
                                  <select
                                    value={mapping[i] ?? ""}
                                    disabled={!included}
                                    onChange={(e) => setMapping((m) => ({ ...m, [i]: e.target.value }))}
                                    data-testid={`map-${i}`}
                                  >
                                    <option value="">— skip —</option>
                                    {targetRel.columns.map((c) => (
                                      <option key={c.name} value={c.name}>{c.name}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="mono sample-cell">
                                  {sample.map((v, k) => (
                                    <div key={k} className="sample-line">{v}</div>
                                  ))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}

            {jobs.length > 0 && (
              <>
                <div className="section-title">Progress</div>
                <div className="full">
                  <div className="import-progress">
                    <span><CheckCircle2 size={11} /> {doneCount} done</span>
                    {errorCount > 0 && <span className="err"><AlertTriangle size={11} /> {errorCount} failed</span>}
                    <span className="muted">· {rowCount} rows total</span>
                  </div>
                  {/* Show the first 5 errors inline so users can fix sources quickly. */}
                  {jobs.filter((j) => j.status === "error").slice(0, 5).map((j) => (
                    <div key={j.ix} className="row-err-body" style={{ marginTop: 4 }}>
                      <span>row {j.ix + 1}: {j.error?.slice(0, 200)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {parseErr && <div className="message-pane err" style={{ padding: 8, marginTop: 8 }}>{parseErr}</div>}
          {topErr   && <div className="message-pane err" style={{ padding: 8, marginTop: 8 }}>{topErr}</div>}
        </div>
        <div className="modal-footer">
          {parsed && <span className="muted">{parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} parsed</span>}
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>Close</button>
          <button
            className="btn-pill primary"
            disabled={working || !parsed || parsed.rows.length === 0 || (format !== "sql" && !table)}
            onClick={start}
          >
            {working ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
