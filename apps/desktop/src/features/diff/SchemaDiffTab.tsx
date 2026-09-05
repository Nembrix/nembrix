import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Play, RefreshCcw } from "lucide-react";
import type { Tab } from "@/store";
import { useStore } from "@/store";
import type { ConnectionRecord, SchemaTree } from "@/ipc/types";
import * as api from "@/ipc/commands";
import { diffSchemas, type DiffOp } from "./engine";
import { generateMigration } from "./migrate";

/**
 * Pick (left connection, left schema) and (right connection, right schema),
 * run introspect on both, render the diff. Each op can be toggled — the
 * generated migration script reflects only the selected ops.
 */
export default function SchemaDiffTab({ tab }: { tab: Tab }) {
  const { connections, status, schemas, setSchema } = useStore();

  // The left connection defaults to the tab's owning connection; the right
  // can be the same (compare two schemas in one DB) or a different one.
  const [leftConnId, setLeftConnId]   = useState<string>(tab.connId);
  const [rightConnId, setRightConnId] = useState<string>(tab.connId);
  const [leftSchema, setLeftSchema]   = useState<string>(tab.sourceRelation?.schema ?? "public");
  const [rightSchema, setRightSchema] = useState<string>(tab.sourceRelation?.schema ?? "public");

  const [error, setError]    = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  // useCallback so the effects below can depend on it with a stable
  // reference instead of re-running every render.
  const ensureTree = useCallback(async (connId: string) => {
    if (!connId) return;
    if (schemas[connId]) return;
    if (status[connId] !== "connected") return;
    try {
      setSchema(connId, await api.introspect(connId));
    } catch (e) {
      setError(String(e));
    }
  }, [schemas, status, setSchema]);

  // Fetch on connect if we haven't already.
  //
  // `ensureTree` writes the fetched schema into the Zustand store, i.e. it
  // updates an external system from an effect — the case the rule's docs
  // explicitly allow. The setState it trips on is the store's, not local state
  // this component could derive.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void ensureTree(leftConnId); }, [leftConnId, ensureTree]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void ensureTree(rightConnId); }, [rightConnId, ensureTree]);

  const leftTree  = schemas[leftConnId];
  const rightTree = schemas[rightConnId];
  const leftSchemaNode  = useMemo(() => findSchema(leftTree, leftSchema),   [leftTree, leftSchema]);
  const rightSchemaNode = useMemo(() => findSchema(rightTree, rightSchema), [rightTree, rightSchema]);

  const diff = useMemo(() => {
    if (!leftSchemaNode || !rightSchemaNode) return null;
    return diffSchemas(leftSchemaNode, rightSchemaNode);
  }, [leftSchemaNode, rightSchemaNode]);

  // Track which ops the user wants in the migration. Reset to "all selected"
  // when the diff changes.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Re-selecting everything is a response to the diff being recomputed, not
  // state derivable during render: the user's subsequent tick/untick edits live
  // in this same cell, so it can't be a useMemo over `diff`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!diff) { setSelectedKeys(new Set()); return; }
    setSelectedKeys(new Set(diff.ops.map(opKey)));
  }, [diff]);

  const selectedOps = useMemo<DiffOp[]>(() => {
    if (!diff) return [];
    return diff.ops.filter((op) => selectedKeys.has(opKey(op)));
  }, [diff, selectedKeys]);

  const migrationSql = useMemo(() => generateMigration(selectedOps), [selectedOps]);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const [l, r] = await Promise.all([
        api.introspect(leftConnId),
        leftConnId === rightConnId ? Promise.resolve<SchemaTree | null>(null) : api.introspect(rightConnId),
      ]);
      setSchema(leftConnId, l);
      if (r) setSchema(rightConnId, r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (selectedOps.length === 0) return;
    const conn = connections.find((c) => c.id === leftConnId);
    const env = conn?.environment;
    const protectedEnv = env === "production" || env === "staging";
    const confirmMsg = protectedEnv
      ? `Apply ${selectedOps.length} migration step(s) to ${env?.toUpperCase()} "${conn?.name}"?\n\nThis runs in a single transaction. Type the connection name to confirm:`
      : `Apply ${selectedOps.length} migration step(s) to "${conn?.name}"?`;
    if (protectedEnv) {
      const typed = prompt(confirmMsg);
      if (typed !== conn?.name) return;
    } else if (!confirm(confirmMsg)) return;

    setApplying(true); setError(null);
    try {
      // generateMigration already wraps in BEGIN/COMMIT. Send each line as
      // one execute so a fail surfaces precisely.
      const lines = migrationSql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
      for (const stmt of lines) {
        await api.execute(leftConnId, stmt);
      }
      await refresh();
    } catch (e) {
      setError(`${e}\n(transaction rolled back)`);
      try { await api.execute(leftConnId, "ROLLBACK;"); } catch { /* ignore: best-effort */ }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="editor-shell">
      <div className="data-view-toolbar diff-toolbar">
        <strong>Schema diff</strong>
        <div className="spacer" />
        <SidePicker
          label="Left"
          connections={connections}
          status={status}
          schemas={schemas}
          connId={leftConnId} setConnId={setLeftConnId}
          schemaName={leftSchema} setSchemaName={setLeftSchema}
        />
        <ArrowRight size={14} className="muted" />
        <SidePicker
          label="Right"
          connections={connections}
          status={status}
          schemas={schemas}
          connId={rightConnId} setConnId={setRightConnId}
          schemaName={rightSchema} setSchemaName={setRightSchema}
        />
        <button className="btn-pill" onClick={refresh} disabled={loading}>
          <RefreshCcw size={12} /> {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          className="btn-pill primary"
          disabled={applying || selectedOps.length === 0}
          onClick={apply}
        >
          <Play size={12} /> {applying ? "Applying…" : `Apply ${selectedOps.length}`}
        </button>
      </div>

      {error && (
        <div className="message-pane err" style={{ padding: 8 }}>{error}</div>
      )}

      <div className="diff-shell">
        <div className="diff-tree">
          {!diff ? (
            <div className="placeholder muted">
              {leftTree && rightTree
                ? "Pick a schema on each side."
                : "Connect both sides and pick a schema."}
            </div>
          ) : diff.ops.length === 0 ? (
            <div className="placeholder muted">Schemas are identical 🎉</div>
          ) : (
            <DiffList
              ops={diff.ops}
              selected={selectedKeys}
              onToggle={(k) => setSelectedKeys((cur) => {
                const next = new Set(cur);
                if (next.has(k)) next.delete(k); else next.add(k);
                return next;
              })}
              onSelectAll={() => setSelectedKeys(new Set(diff.ops.map(opKey)))}
              onSelectNone={() => setSelectedKeys(new Set())}
            />
          )}
        </div>

        <div className="diff-sql">
          <div className="pane-toolbar">
            <strong>Migration SQL</strong>
            <span className="muted">{selectedOps.length} ops selected</span>
          </div>
          <pre className="sql-preview" data-testid="migration-sql">{migrationSql}</pre>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── subcomponents ───────────────────────── */

function SidePicker({
  label, connections, status, schemas, connId, setConnId, schemaName, setSchemaName,
}: {
  label: string;
  connections: ConnectionRecord[];
  status: Record<string, "disconnected" | "connecting" | "connected" | "error">;
  schemas: Record<string, SchemaTree | undefined>;
  connId: string; setConnId: (id: string) => void;
  schemaName: string; setSchemaName: (s: string) => void;
}) {
  const tree = schemas[connId];
  const schemaList = tree?.databases[0]?.schemas.map((s) => s.name) ?? [];
  return (
    <div className="diff-side-picker">
      <span className="muted">{label}</span>
      <select value={connId} onChange={(e) => setConnId(e.target.value)}>
        {connections.map((c) => (
          <option key={c.id} value={c.id} disabled={status[c.id] !== "connected"}>
            {c.name}{status[c.id] !== "connected" ? " (disconnected)" : ""}
          </option>
        ))}
      </select>
      <select value={schemaName} onChange={(e) => setSchemaName(e.target.value)}>
        {schemaList.length === 0 ? (
          <option value="">— no schemas —</option>
        ) : (
          schemaList.map((s) => <option key={s} value={s}>{s}</option>)
        )}
      </select>
    </div>
  );
}

function DiffList({
  ops, selected, onToggle, onSelectAll, onSelectNone,
}: {
  ops: DiffOp[];
  selected: Set<string>;
  onToggle: (k: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  // Group by table for the tree-style display.
  const groups = useMemo(() => {
    const g = new Map<string, DiffOp[]>();
    for (const op of ops) {
      const k = `${op.schema}.${op.table}`;
      const arr = g.get(k) ?? [];
      arr.push(op);
      g.set(k, arr);
    }
    return g;
  }, [ops]);

  return (
    <>
      <div className="pane-toolbar">
        <strong>Differences</strong>
        <span className="muted">{ops.length}</span>
        <div className="spacer" />
        <button className="btn-link" onClick={onSelectAll}>All</button>
        <button className="btn-link" onClick={onSelectNone}>None</button>
      </div>
      {[...groups.entries()].map(([qname, list]) => (
        <div key={qname} className="diff-group">
          <div className="diff-group-name">{qname}</div>
          {list.map((op) => {
            const key = opKey(op);
            const symbol = op.summary.startsWith("+") ? "add"
                         : op.summary.startsWith("-") ? "drop"
                         : "change";
            return (
              <label key={key} className={`diff-op diff-${symbol}`}>
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => onToggle(key)}
                />
                <span className="diff-op-summary">{op.summary}</span>
              </label>
            );
          })}
        </div>
      ))}
    </>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function findSchema(tree: SchemaTree | undefined, name: string) {
  return tree?.databases[0]?.schemas.find((s) => s.name === name);
}

function opKey(op: DiffOp): string {
  return `${op.kind}|${op.schema}.${op.table}|${op.column ?? ""}|${op.summary}`;
}
