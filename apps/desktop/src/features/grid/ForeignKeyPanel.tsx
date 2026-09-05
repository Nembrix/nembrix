import { useAsyncResource } from "@/lib/useAsyncResource";
import { ArrowRight, ExternalLink, X } from "lucide-react";
import type { CellValue, ColMeta, ForeignKey } from "@/ipc/types";
import * as api from "@/ipc/commands";
import { useStore } from "@/store";

interface Props {
  connId: string;
  fk: ForeignKey;
  /** The value of the source column in the row the user clicked. */
  cellValue: CellValue;
  onClose: () => void;
}

export default function ForeignKeyPanel({ connId, fk, cellValue, onClose }: Props) {
  // Accumulate the streamed batches inside the loader and resolve once, so the
  // component holds a single async resource rather than four setState cells
  // written to from an effect body.
  const { data, error: err, loading } = useAsyncResource<{
    rows: CellValue[][];
    cols: ColMeta[];
  }>(
    async (isCancelled) => {
      const where = fk.referenced_columns
        .map((c, i) => `${quoteIdent(c)} = ${quoteValue(cellValue, i)}`)
        .join(" AND ");
      const sql = `SELECT * FROM ${quoteIdent(fk.referenced_schema)}.${quoteIdent(fk.referenced_table)} WHERE ${where} LIMIT 5;`;

      const rows: CellValue[][] = [];
      let cols: ColMeta[] = [];
      await new Promise<void>((resolve, reject) => {
        api.stream(connId, sql, (b) => {
          if (isCancelled()) return;
          if (b.columns) cols = b.columns;
          rows.push(...b.rows);
          if (b.done) resolve();
        }).catch(reject);
      });
      return { rows, cols };
    },
    [connId, fk, cellValue],
  );
  const rows = data?.rows ?? [];
  const cols = data?.cols ?? [];

  const openInTab = () => {
    const where = fk.referenced_columns
      .map((c, i) => `${quoteIdent(c)} = ${quoteValue(cellValue, i)}`)
      .join(" AND ");
    const sql = `SELECT * FROM ${quoteIdent(fk.referenced_schema)}.${quoteIdent(fk.referenced_table)} WHERE ${where};`;
    useStore.getState().addTab({
      id: crypto.randomUUID(),
      connId,
      kind: "query",
      title: `${fk.referenced_table} ↦`,
      sql,
      sourceRelation: { schema: fk.referenced_schema, table: fk.referenced_table },
    });
    onClose();
  };

  return (
    <aside className="fk-panel">
      <div className="fk-panel-header">
        <span className="muted">Referenced row</span>
        <ArrowRight size={12} />
        <strong>{fk.referenced_schema}.{fk.referenced_table}</strong>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={openInTab} title="Open in tab"><ExternalLink size={13} /></button>
        <button className="icon-btn" onClick={onClose} title="Close"><X size={13} /></button>
      </div>
      <div className="fk-panel-body">
        {loading && rows.length === 0 && <div className="muted">Loading…</div>}
        {err && <div className="message-pane err">{err}</div>}
        {!err && rows.length === 0 && !loading && (
          <div className="muted">No matching row.</div>
        )}
        {rows.length > 0 && (
          <div className="kv">
            {cols.map((c, i) => (
              <RowPair key={c.name} col={c} cell={rows[0][i]} />
            ))}
          </div>
        )}
        {rows.length > 1 && (
          <div className="muted" style={{ marginTop: 8 }}>
            +{rows.length - 1} more matching row{rows.length - 1 === 1 ? "" : "s"} — open in tab.
          </div>
        )}
      </div>
    </aside>
  );
}

function RowPair({ col, cell }: { col: ColMeta; cell: CellValue }) {
  const text = renderCell(cell);
  return (
    <>
      <span title={col.type_name}>{col.name}</span>
      <span className={cell.kind === "null" ? "muted" : ""}>{text}</span>
    </>
  );
}

function renderCell(v: CellValue): string {
  switch (v.kind) {
    case "null": return "NULL";
    case "bool": return v.value ? "true" : "false";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw": return v.value;
    case "document": return JSON.stringify(v.value, null, 2);
    case "bytes": return `<${v.value.length} bytes>`;
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteValue(v: CellValue, _i: number): string {
  switch (v.kind) {
    case "null": return "NULL";
    case "bool": return v.value ? "TRUE" : "FALSE";
    case "int": case "float": return String(v.value);
    case "text": case "raw": return `'${v.value.replace(/'/g, "''")}'`;
    case "document": return `'${JSON.stringify(v.value).replace(/'/g, "''")}'::jsonb`;
    case "bytes": return `decode('${Array.from(v.value).map((b) => b.toString(16).padStart(2, "0")).join("")}', 'hex')`;
  }
}
