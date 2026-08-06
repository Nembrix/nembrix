import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import * as api from "@/ipc/commands";
import { useStore } from "@/store";

interface Props {
  connId: string;
  schema: string;
  table: string;
  onClose: () => void;
}

/**
 * Add an index to a (SQL) table. Replaces the old `window.prompt()` flow, which
 * was a silent no-op in the Tauri WebView (prompt returns null there). Inline
 * dialog: comma-separated columns + a UNIQUE toggle, live SQL preview, errors
 * shown in-dialog instead of a stubbed `alert()`.
 */
export default function AddIndexDialog({ connId, schema, table, onClose }: Props) {
  const [cols, setCols] = useState("");
  const [unique, setUnique] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const columns = cols.split(",").map((s) => s.trim()).filter(Boolean);
  const sql = buildCreateIndexSql(schema, table, columns, unique);

  const onApply = async () => {
    if (!columns.length) return;
    setWorking(true);
    setErr(null);
    try {
      await api.execute(connId, sql);
      try {
        const t = await api.introspect(connId);
        useStore.getState().setSchema(connId, t);
      } catch (e) { console.warn("[add-index] introspect failed after apply:", e); }
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Add index on {schema}.{table}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label htmlFor="ai-cols">Columns</label>
            <input
              id="ai-cols"
              type="text"
              value={cols}
              onChange={(e) => setCols(e.target.value)}
              placeholder="comma-separated, e.g. user_id, created_at"
              autoFocus
            />
            <label htmlFor="ai-unique">Unique</label>
            <label className="check-row" htmlFor="ai-unique" style={{ margin: 0 }}>
              <input id="ai-unique" type="checkbox" checked={unique}
                onChange={(e) => setUnique(e.target.checked)} />
              Enforce uniqueness across the indexed columns
            </label>
          </div>

          <div className="section-title">SQL preview</div>
          <pre className="sql-preview">{sql}</pre>

          {err && (
            <div className="warnings">
              <div className="warn-row err">
                <AlertTriangle size={13} />
                <span>{err}</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>Cancel</button>
          <button
            className="btn-pill primary"
            disabled={working || !columns.length}
            onClick={onApply}
          >
            {working ? "Creating…" : "Create index"}
          </button>
        </div>
      </div>
    </div>
  );
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildCreateIndexSql(
  schema: string,
  table: string,
  columns: string[],
  unique: boolean,
): string {
  const name = `${table}_${columns.join("_")}_idx`;
  const cols = columns.map(qi).join(", ");
  const kind = unique ? "UNIQUE INDEX" : "INDEX";
  return `CREATE ${kind} ${qi(name)} ON ${qi(schema)}.${qi(table)} (${cols});`;
}
