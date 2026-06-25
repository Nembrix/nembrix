import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Copy as CopyIcon, Database, X,
} from "lucide-react";
import * as api from "@/ipc/commands";
import { useStore } from "@/store";
import type { CellValue, ConnectionRecord, RelationNode } from "@/ipc/types";
import { composeInsertBatch, type ConflictMode } from "@/features/import/insert";
import {
  cellToInsertValue, emitCreateSchema, emitCreateTable,
  emitForeignKeys, emitIndexes, emitSequenceResets, topoSortByFks,
} from "./util";
import { ENV_LABEL } from "@/features/connections/environment";

type What = "structure" | "data" | "both";
type Phase = "pending" | "ddl" | "copying" | "done" | "error";
interface TableJob {
  schema: string;
  table: string;
  rowsCopied: number;
  rowsTotal?: number;
  phase: Phase;
  error?: string;
}

interface Props {
  /** Default mode the dialog opens in. */
  mode: "table" | "database";
  /** Optional preselected source (e.g. from a context menu).
   *  `targetConnId` is the session id the user explicitly chose
   *  (right-click "Copy to <session>") — we resolve it to a
   *  connection id below so the picker doesn't fall back to
   *  the first live conn. */
  source: {
    connId: string;
    schema?: string;
    table?: string;
    targetConnId?: string;
  } | null;
  onClose: () => void;
}

const BATCH_SIZE = 200;

const CONFLICT_LABELS: Record<ConflictMode, string> = {
  stop:   "Stop on conflict",
  skip:   "Skip on conflict",
  update: "Update on conflict",
};

export default function CopyDialog({ mode: initialMode, source: initialSource, onClose }: Props) {
  const { connections, sessions, status, schemas } = useStore();
  const [mode, setMode] = useState<"table" | "database">(initialMode);
  const [what, setWhat] = useState<What>("both");
  const [conflict, setConflict] = useState<ConflictMode>("skip");
  const [recreate, setRecreate] = useState(false);

  /* ─── Live connection list ───
   * The dialog only operates on currently-connected connections. We derive
   * that set from the sessions table and gate the source/target pickers on
   * it. If there are fewer than 2 live conns, we show a no-op state.
   */
  const liveConnIds = useMemo(() => {
    const set = new Set<string>();
    for (const sess of sessions) {
      if (status[sess.id] === "connected") set.add(sess.connectionId);
    }
    return set;
  }, [sessions, status]);
  const liveConns = useMemo(
    () => connections.filter((c) => liveConnIds.has(c.id)),
    [connections, liveConnIds],
  );

  /* ─── Pickers ─── */
  const [srcConnId, setSrcConnId] = useState<string>(
    initialSource?.connId ?? liveConns[0]?.id ?? "",
  );
  const [tgtConnId, setTgtConnId] = useState<string>(() => {
    // If the caller pre-selected a target session (right-click "Copy
    // to <session>"), resolve the session to its underlying connection
    // id and use that. Otherwise fall back to the first live conn
    // that isn't the source.
    if (initialSource?.targetConnId) {
      const sess = sessions.find((s) => s.id === initialSource.targetConnId);
      if (sess) return sess.connectionId;
    }
    return liveConns.find((c) => c.id !== (initialSource?.connId ?? liveConns[0]?.id))?.id ?? "";
  });
  const [srcSchema, setSrcSchema] = useState<string>(initialSource?.schema ?? "public");
  const [srcTable,  setSrcTable]  = useState<string>(initialSource?.table  ?? "");
  const [tgtSchema, setTgtSchema] = useState<string>(initialSource?.schema ?? "public");
  /** For database mode: which schemas the user picked. */
  const [pickedSchemas, setPickedSchemas] = useState<string[]>(["public"]);

  /* ─── Source schema introspection ───
   * Schemas are stored under the session id (because the rail introspects
   * per-session). Pick any connected session for the chosen connection. */
  const schemaForConn = (connId: string) => {
    const sess = sessions.find(
      (s) => s.connectionId === connId && status[s.id] === "connected",
    );
    return sess ? schemas[sess.id] : undefined;
  };
  const srcTree = schemaForConn(srcConnId);
  const srcSchemaNames = useMemo(
    () => srcTree?.databases[0]?.schemas.map((s) => s.name) ?? [],
    [srcTree],
  );
  const srcTables = useMemo(() => {
    const sc = srcTree?.databases[0]?.schemas.find((s) => s.name === srcSchema);
    return sc?.tables ?? [];
  }, [srcTree, srcSchema]);
  const tgtTree = schemaForConn(tgtConnId);
  const tgtSchemaNames = useMemo(
    () => tgtTree?.databases[0]?.schemas.map((s) => s.name) ?? [],
    [tgtTree],
  );

  // Default target schema to the source schema when target changes.
  useEffect(() => {
    if (!tgtSchemaNames.includes(tgtSchema) && tgtSchemaNames.length > 0) {
      setTgtSchema(tgtSchemaNames.includes(srcSchema) ? srcSchema : tgtSchemaNames[0]);
    }
  }, [tgtConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Run state ─── */
  const [working, setWorking] = useState(false);
  const [jobs, setJobs] = useState<TableJob[]>([]);
  const [topErr, setTopErr] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const updateJob = (key: string, patch: Partial<TableJob>) => {
    setJobs((cur) => cur.map((j) =>
      `${j.schema}.${j.table}` === key ? { ...j, ...patch } : j,
    ));
  };

  /* ─── Core copy routine for one table ─── */
  const copyOneTable = async (
    rel: RelationNode,
    fromSchema: string,
    toSchema: string,
  ): Promise<void> => {
    const key = `${fromSchema}.${rel.name}`;
    const qtSrc = `"${fromSchema}"."${rel.name}"`;
    const qtTgt = `"${toSchema}"."${rel.name}"`;

    /* DDL phase ─ create the target table */
    if (what !== "data") {
      updateJob(key, { phase: "ddl" });
      const ddl: string[] = [];
      if (recreate) ddl.push(`DROP TABLE IF EXISTS ${qtTgt} CASCADE;`);
      ddl.push(emitCreateTable(qtTgt, rel, { ifNotExists: !recreate }));
      for (const stmt of ddl) {
        await api.execute(tgtConnId, stmt);
      }
    }

    /* DATA phase ─ stream src → batched INSERTs into target */
    if (what !== "structure") {
      updateJob(key, { phase: "copying", rowsCopied: 0 });
      // Get a row count for the progress label. Best-effort — if it fails
      // we just show "n rows copied" with no total.
      try {
        const handle = `__copy_count_${Date.now()}`;
        void handle;
        let count: number | undefined;
        await new Promise<void>((res, rej) => {
          api.stream(srcConnId, `SELECT COUNT(*) AS n FROM ${qtSrc};`, (b) => {
            if (b.rows.length > 0) {
              const v = b.rows[0][0];
              if (v.kind === "int") count = v.value;
              else if (v.kind === "text") count = parseInt(v.value, 10);
            }
            if (b.done) res();
          }).catch(rej);
        });
        if (count !== undefined) updateJob(key, { rowsTotal: count });
      } catch { /* non-fatal */ }

      // Now stream the rows. We accumulate into batches of BATCH_SIZE then
      // flush. The streamer might call onBatch with rows from many query
      // batches before done; we don't care — we just keep the buffer.
      const buffer: CellValue[][] = [];
      let columns: string[] = [];
      let copied = 0;

      const flush = async () => {
        if (buffer.length === 0) return;
        const rows = buffer.map((row) => row.map(cellToInsertValue));
        const sql = composeInsertBatch(
          {
            qualifiedTarget: qtTgt,
            columns,
            conflictKey: rel.primary_key,
            mode: conflict,
          },
          rows,
        );
        await api.execute(tgtConnId, sql);
        copied += buffer.length;
        buffer.length = 0;
        updateJob(key, { rowsCopied: copied });
      };

      await new Promise<void>((res, rej) => {
        let chainErr: unknown = null;
        api.stream(srcConnId, `SELECT * FROM ${qtSrc};`, (b) => {
          if (chainErr) return;
          if (cancelRef.current) return;
          if (b.columns) columns = b.columns.map((c) => c.name);
          for (const row of b.rows) {
            buffer.push(row);
            if (buffer.length >= BATCH_SIZE) {
              // Flush eagerly — but await must happen inside the callback
              // sequencing. We chain promises so order is preserved.
              const rowsToSend = buffer.slice();
              buffer.length = 0;
              void flush.call(null).catch((e) => { chainErr = e; });
              void rowsToSend;
            }
          }
          if (b.done) {
            flush().then(() => res()).catch((e) => rej(e));
          }
        }).catch((e) => rej(e));
      });
    }

    /* Sequence reset — bump any serial/identity sequences to MAX(col) so
     * subsequent inserts on the target don't reuse a copied id. Only runs
     * when we copied data, since on a structure-only copy there's nothing
     * to bump past. Non-fatal: a setval failure shouldn't fail the table. */
    if (what !== "structure") {
      for (const stmt of emitSequenceResets(qtTgt, rel)) {
        try { await api.execute(tgtConnId, stmt); }
        catch (e) { setTopErr((prev) => prev ?? `Sequence warning: ${String(e)}`); }
      }
    }

    updateJob(key, { phase: "done" });
  };

  /* ─── Run the copy ─── */
  const start = async () => {
    setTopErr(null);
    cancelRef.current = false;
    if (!srcConnId || !tgtConnId) { setTopErr("Pick source and target."); return; }
    if (srcConnId === tgtConnId) { setTopErr("Source and target must be different connections."); return; }

    /* Build job list. */
    let rels: { rel: RelationNode; schema: string }[] = [];
    if (mode === "table") {
      const rel = srcTables.find((t) => t.name === srcTable);
      if (!rel) { setTopErr("Pick a source table."); return; }
      rels = [{ rel, schema: srcSchema }];
    } else {
      const db = srcTree?.databases[0];
      if (!db) { setTopErr("Source schema not loaded."); return; }
      for (const sc of db.schemas) {
        if (!pickedSchemas.includes(sc.name)) continue;
        for (const rel of sc.tables) rels.push({ rel, schema: sc.name });
      }
      if (rels.length === 0) { setTopErr("No tables in the selected schemas."); return; }
      // Topo-sort within each schema so FK deps land first.
      const sorted = topoSortByFks(rels.map((r) => r.rel));
      rels = sorted.map((rel) => ({
        rel,
        schema: rels.find((x) => x.rel.name === rel.name)!.schema,
      }));
    }

    /* Initialize job rows. */
    setJobs(rels.map(({ rel, schema }) => ({
      schema, table: rel.name, rowsCopied: 0, phase: "pending",
    })));

    setWorking(true);
    try {
      /* Database mode: ensure schemas exist on target. */
      if (mode === "database") {
        const targetSchemas = new Set(rels.map((r) => r.schema));
        for (const s of targetSchemas) {
          await api.execute(tgtConnId, emitCreateSchema(s));
        }
      }

      /* Pass 1 — DDL + data. */
      for (const { rel, schema } of rels) {
        if (cancelRef.current) break;
        const toSchema = mode === "table" ? tgtSchema : schema;
        try {
          await copyOneTable(rel, schema, toSchema);
        } catch (e) {
          updateJob(`${schema}.${rel.name}`, { phase: "error", error: String(e) });
          if (conflict === "stop") throw e;
        }
      }

      /* Pass 2 — indexes + foreign keys. Indexes run for both table and
       * database mode (when structure is included) so the target ends up
       * with a fully-equivalent schema. FKs only make sense in database
       * mode where referenced tables also got copied. */
      if (what !== "data") {
        for (const { rel, schema } of rels) {
          if (cancelRef.current) break;
          const toSchema = mode === "table" ? tgtSchema : schema;
          const qt = `"${toSchema}"."${rel.name}"`;
          for (const stmt of emitIndexes(rel, schema, toSchema)) {
            try { await api.execute(tgtConnId, stmt); }
            catch (e) {
              setTopErr((prev) => prev ?? `Index warning: ${String(e)}`);
            }
          }
          if (mode === "database") {
            for (const stmt of emitForeignKeys(qt, rel)) {
              try { await api.execute(tgtConnId, stmt); }
              catch (e) {
                // FKs often fail when the referenced data isn't there yet
                // (cycles, missing tables). Non-fatal.
                setTopErr((prev) => prev ?? `FK warning: ${String(e)}`);
              }
            }
          }
        }
      }

      /* Refresh target schema. Store under each connected session id for
       * this target connection so all open sessions see the new tables. */
      try {
        const tree = await api.introspect(tgtConnId);
        const targetSessions = useStore.getState().sessions.filter(
          (s) => s.connectionId === tgtConnId && useStore.getState().status[s.id] === "connected",
        );
        for (const ts of targetSessions) {
          useStore.getState().setSchema(ts.id, tree);
        }
      } catch { /* non-fatal */ }
    } catch (e) {
      setTopErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  const cancel = () => { cancelRef.current = true; };

  /* ─── Render ─── */
  if (liveConns.length < 2) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <CopyIcon size={14} />
            <span>Copy {initialMode === "database" ? "database" : "table"}</span>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={onClose}><X size={14} /></button>
          </div>
          <div className="modal-body">
            <div className="placeholder muted" style={{ padding: 24 }}>
              <AlertTriangle size={20} />
              <p style={{ marginTop: 8 }}>
                You need <strong>at least two connected sessions</strong> to copy
                between connections. Open the connection manager and connect to
                both your source and target.
              </p>
            </div>
          </div>
          <div className="modal-footer">
            <span style={{ flex: 1 }} />
            <button className="btn-pill" onClick={onClose}>Close</button>
            <button
              className="btn-pill primary"
              onClick={() => { onClose(); useStore.getState().openConnectionManager(); }}
            >
              Manage connections…
            </button>
          </div>
        </div>
      </div>
    );
  }

  const renderConn = (c: ConnectionRecord) => {
    const env = c.environment ? ` · ${ENV_LABEL[c.environment]}` : "";
    return `${c.name}${env} (${c.host}${c.database ? "/" + c.database : ""})`;
  };

  const doneCount = jobs.filter((j) => j.phase === "done").length;
  const errCount  = jobs.filter((j) => j.phase === "error").length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <CopyIcon size={14} />
          <span>Copy {mode === "database" ? "database" : "table"} between connections</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="section-title">Mode</div>
            <div className="segmented" style={{ width: "fit-content" }}>
              <button className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>Single table</button>
              <button className={mode === "database" ? "active" : ""} onClick={() => setMode("database")}>Whole database</button>
            </div>

            <div className="section-title">Source &amp; target</div>
            <label>Source connection</label>
            <select
              value={srcConnId}
              onChange={(e) => setSrcConnId(e.target.value)}
              data-testid="copy-src-conn"
            >
              {liveConns.map((c) => (
                <option key={c.id} value={c.id}>{renderConn(c)}</option>
              ))}
            </select>

            <label>Target connection</label>
            <select
              value={tgtConnId}
              onChange={(e) => setTgtConnId(e.target.value)}
              data-testid="copy-tgt-conn"
            >
              <option value="">— pick target —</option>
              {liveConns
                .filter((c) => c.id !== srcConnId)
                .map((c) => {
                  const isProd = c.environment === "production";
                  return (
                    <option key={c.id} value={c.id}>
                      {renderConn(c)}{isProd ? "  ⚠" : ""}
                    </option>
                  );
                })}
            </select>

            {mode === "table" ? (
              <>
                <label>Source schema</label>
                <select value={srcSchema} onChange={(e) => setSrcSchema(e.target.value)}>
                  {srcSchemaNames.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
                <label>Source table</label>
                <select
                  value={srcTable}
                  onChange={(e) => setSrcTable(e.target.value)}
                  data-testid="copy-src-table"
                >
                  <option value="">— pick a table —</option>
                  {srcTables.map((t) => (<option key={t.name} value={t.name}>{t.name}</option>))}
                </select>
                <label>Target schema</label>
                <select value={tgtSchema} onChange={(e) => setTgtSchema(e.target.value)}>
                  {tgtSchemaNames.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </>
            ) : (
              <>
                <label>Schemas to copy</label>
                <div className="copy-schema-grid">
                  {srcSchemaNames.map((s) => (
                    <label key={s} className="copy-schema-chip">
                      <input
                        type="checkbox"
                        checked={pickedSchemas.includes(s)}
                        onChange={(e) => {
                          setPickedSchemas((cur) =>
                            e.target.checked
                              ? [...cur, s]
                              : cur.filter((x) => x !== s),
                          );
                        }}
                      />
                      <span>{s}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="section-title">What to copy</div>
            <label>Contents</label>
            <div className="segmented" style={{ width: "fit-content" }}>
              <button className={what === "structure" ? "active" : ""} onClick={() => setWhat("structure")}>Structure only</button>
              <button className={what === "data" ? "active" : ""} onClick={() => setWhat("data")}>Data only</button>
              <button className={what === "both" ? "active" : ""} onClick={() => setWhat("both")}>Structure + data</button>
            </div>

            {what !== "data" && (
              <>
                <label>On existing target</label>
                <div>
                  <input
                    id="copy-recreate"
                    type="checkbox"
                    checked={recreate}
                    onChange={(e) => setRecreate(e.target.checked)}
                  />
                  <label htmlFor="copy-recreate" style={{ marginLeft: 6 }}>
                    Drop &amp; recreate (DROP TABLE CASCADE — destructive!)
                  </label>
                </div>
              </>
            )}

            {what !== "structure" && (
              <>
                <label>On conflict</label>
                <select value={conflict} onChange={(e) => setConflict(e.target.value as ConflictMode)}>
                  {(["stop", "skip", "update"] as ConflictMode[]).map((m) => (
                    <option key={m} value={m}>{CONFLICT_LABELS[m]}</option>
                  ))}
                </select>
              </>
            )}

            {jobs.length > 0 && (
              <>
                <div className="section-title">Progress</div>
                <div className="full">
                  <div className="import-progress">
                    <span><CheckCircle2 size={11} /> {doneCount} done</span>
                    {errCount > 0 && <span className="err"><AlertTriangle size={11} /> {errCount} failed</span>}
                    <span className="muted">· {jobs.length} table{jobs.length === 1 ? "" : "s"} total</span>
                  </div>
                  <div className="copy-jobs">
                    {jobs.map((j) => (
                      <div key={`${j.schema}.${j.table}`} className={`copy-job phase-${j.phase}`}>
                        <Database size={11} />
                        <span className="mono">{j.schema}.{j.table}</span>
                        <ArrowRight size={10} className="muted" />
                        <span className="mono muted">{mode === "table" ? tgtSchema : j.schema}.{j.table}</span>
                        <span className="spacer" />
                        <span className="copy-job-meta">
                          {j.phase === "pending" && "pending"}
                          {j.phase === "ddl" && "creating…"}
                          {j.phase === "copying" && (
                            j.rowsTotal !== undefined
                              ? `${j.rowsCopied} / ${j.rowsTotal} rows`
                              : `${j.rowsCopied} rows`
                          )}
                          {j.phase === "done" && (
                            <><CheckCircle2 size={10} /> {j.rowsCopied}{j.rowsTotal ? `/${j.rowsTotal}` : ""}</>
                          )}
                          {j.phase === "error" && (
                            <span className="err" title={j.error}>
                              <AlertTriangle size={10} /> failed
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {topErr && <div className="message-pane err" style={{ padding: 8, marginTop: 8 }}>{topErr}</div>}
        </div>
        <div className="modal-footer">
          {(() => {
            const tgt = liveConns.find((c) => c.id === tgtConnId);
            if (tgt?.environment === "production") {
              return (
                <span className="err" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <AlertTriangle size={11} /> Target is <strong>PRODUCTION</strong>
                </span>
              );
            }
            return null;
          })()}
          <span style={{ flex: 1 }} />
          {working ? (
            <button className="btn-pill danger" onClick={cancel}>Cancel</button>
          ) : (
            <button className="btn-pill" onClick={onClose}>Close</button>
          )}
          <button
            className="btn-pill primary"
            disabled={working || !tgtConnId || srcConnId === tgtConnId ||
              (mode === "table" ? !srcTable : pickedSchemas.length === 0)}
            onClick={start}
            data-testid="copy-start"
          >
            {working ? "Copying…" : "Start copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
