import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { ColumnNode } from "@/ipc/types";
import * as api from "@/ipc/commands";
import { useStore } from "@/store";

export type AlterField = "type" | "nullable" | "default" | "name";

interface Props {
  connId: string;
  schema: string;
  table: string;
  column: ColumnNode;
  field: AlterField;
  onClose: () => void;
}

/**
 * One dialog for any column-level ALTER. The exact SQL is derived from the
 * current value the user enters; on apply we run the statement and refresh
 * the schema. Postgres errors (permission denied, type-cast failure, etc.)
 * are surfaced in the dialog instead of failing silently.
 */
export default function ColumnAlterDialog({ connId, schema, table, column, field, onClose }: Props) {
  const initial: Record<AlterField, string> = {
    type: column.type_name,
    nullable: column.nullable ? "yes" : "no",
    default: column.default ?? "",
    name: column.name,
  };
  const [value, setValue] = useState<string>(initial[field]);
  const [using, setUsing] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => setValue(initial[field]), [column, field]);  // eslint-disable-line

  const sql = buildSql(schema, table, column, field, value, using);

  const onApply = async () => {
    setWorking(true);
    setErr(null);
    try {
      await api.execute(connId, sql);
      // Refresh schema so the Structure pane reflects the new state.
      try {
        const t = await api.introspect(connId);
        useStore.getState().setSchema(connId, t);
      } catch (e) { console.warn("[alter] introspect failed after apply:", e); }
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
          <span>{titleFor(field, column.name)}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>Column</label>
            <input type="text" disabled value={`${schema}.${table}.${column.name}`} />

            {field === "type" && (
              <>
                <label>New type</label>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="e.g. text, integer, jsonb, timestamptz"
                  autoFocus
                />
                <label>USING (optional)</label>
                <input
                  type="text"
                  value={using}
                  onChange={(e) => setUsing(e.target.value)}
                  placeholder="e.g. col::text — required for non-trivial casts"
                />
              </>
            )}

            {field === "name" && (
              <>
                <label>New name</label>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                />
              </>
            )}

            {field === "nullable" && (
              <>
                <label>Allow NULL</label>
                <select value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
                  <option value="yes">yes — DROP NOT NULL</option>
                  <option value="no">no — SET NOT NULL</option>
                </select>
                <div className="full muted">
                  Setting NOT NULL on a column that already contains NULLs will fail.
                </div>
              </>
            )}

            {field === "default" && (
              <>
                <label>Default</label>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="e.g. now(), 0, ''  — leave blank to DROP DEFAULT"
                  autoFocus
                />
              </>
            )}
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
            disabled={working || !value.trim() && field !== "default"}
            onClick={onApply}
          >
            {working ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function titleFor(field: AlterField, colName: string): string {
  switch (field) {
    case "type":     return `Change type of ${colName}`;
    case "nullable": return `Change nullability of ${colName}`;
    case "default":  return `Change default of ${colName}`;
    case "name":     return `Rename ${colName}`;
  }
}

function qi(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function buildSql(
  schema: string,
  table: string,
  column: ColumnNode,
  field: AlterField,
  value: string,
  using: string,
): string {
  const head = `ALTER TABLE ${qi(schema)}.${qi(table)} ALTER COLUMN ${qi(column.name)}`;
  switch (field) {
    case "type": {
      const usingClause = using.trim() ? ` USING ${using.trim()}` : "";
      return `${head} TYPE ${value}${usingClause};`;
    }
    case "nullable":
      return value === "yes" ? `${head} DROP NOT NULL;` : `${head} SET NOT NULL;`;
    case "default":
      return value.trim()
        ? `${head} SET DEFAULT ${value};`
        : `${head} DROP DEFAULT;`;
    case "name":
      return `ALTER TABLE ${qi(schema)}.${qi(table)} RENAME COLUMN ${qi(column.name)} TO ${qi(value)};`;
  }
}
