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
 * Add a column to a (SQL) table. Replaces the old `window.prompt()`-based flow,
 * which was a silent no-op inside the Tauri WebView (prompt returns null there),
 * making the "+ Add column" button look dead. This is an inline dialog like
 * ColumnAlterDialog: name + type inputs, a live SQL preview, and errors shown
 * in-dialog instead of a stubbed `alert()`.
 */
export default function AddColumnDialog({ connId, schema, table, onClose }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [nullable, setNullable] = useState(true);
  const [dflt, setDflt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const sql = buildAddColumnSql(schema, table, name, type, nullable, dflt);

  const onApply = async () => {
    if (!name.trim() || !type.trim()) return;
    setWorking(true);
    setErr(null);
    try {
      await api.execute(connId, sql);
      try {
        const t = await api.introspect(connId);
        useStore.getState().setSchema(connId, t);
      } catch (e) { console.warn("[add-column] introspect failed after apply:", e); }
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
          <span>Add column to {schema}.{table}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label htmlFor="ac-name">Name</label>
            <input
              id="ac-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="column_name"
              autoFocus
            />
            <label htmlFor="ac-type">Type</label>
            <input
              id="ac-type"
              type="text"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="e.g. text, integer, jsonb, timestamptz"
            />
            <label htmlFor="ac-null">Allow NULL</label>
            <select id="ac-null" value={nullable ? "yes" : "no"}
              onChange={(e) => setNullable(e.target.value === "yes")}>
              <option value="yes">yes</option>
              <option value="no">no — NOT NULL</option>
            </select>
            <label htmlFor="ac-default">Default (optional)</label>
            <input
              id="ac-default"
              type="text"
              value={dflt}
              onChange={(e) => setDflt(e.target.value)}
              placeholder="e.g. now(), 0, '' — blank for none"
            />
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
            disabled={working || !name.trim() || !type.trim()}
            onClick={onApply}
          >
            {working ? "Adding…" : "Add column"}
          </button>
        </div>
      </div>
    </div>
  );
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildAddColumnSql(
  schema: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  dflt: string,
): string {
  let sql = `ALTER TABLE ${qi(schema)}.${qi(table)} ADD COLUMN ${qi(name)} ${type}`;
  if (dflt.trim()) sql += ` DEFAULT ${dflt.trim()}`;
  if (!nullable) sql += " NOT NULL";
  return sql + ";";
}
