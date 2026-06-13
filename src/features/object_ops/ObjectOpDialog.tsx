import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useStore, type ObjectOpRequest } from "@/store";
import * as api from "@/ipc/commands";

type Preview = { sql: string[]; warnings: string[] };

export default function ObjectOpDialog() {
  const { objectOp, closeObjectOp, selectedConnId, activeSchema, schemas } = useStore();
  if (!objectOp) return null;
  return <Inner request={objectOp} close={closeObjectOp}
    connId={selectedConnId}
    schemaName={selectedConnId ? activeSchema[selectedConnId] ?? schemas[selectedConnId]?.databases[0]?.schemas[0]?.name ?? "public" : "public"}
  />;
}

function Inner({ request, close, connId, schemaName }: {
  request: ObjectOpRequest;
  close: () => void;
  connId: string | null;
  schemaName: string;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [withData, setWithData] = useState(true);
  const [cascade, setCascade] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Seed defaults from the request
  useEffect(() => {
    const defaults: Record<string, string> = {};
    if ("schema" in request) defaults.fromSchema = request.schema;
    if ("name" in request) {
      defaults.fromName = request.name;
      defaults.toName = request.name + "_copy";
      defaults.toSchema = request.schema;
    }
    setArgs(defaults);
    setPreview(null);
  }, [request]);

  const title = useMemo(() => titleFor(request), [request]);

  const buildPreview = async (): Promise<Preview> => {
    switch (request.kind) {
      case "db_rename":
        return await api.previewRenameDatabase(args.fromName!, args.toName!);
      case "db_duplicate":
        return await api.previewDuplicateDatabase(args.source!, args.dest!);
      case "db_drop":
        return await api.previewDropDatabase(args.target!);
      case "table_rename":
        return await api.previewRenameTable(request.schema, request.name, args.toName!);
      case "table_duplicate":
        return await api.previewDuplicateTable(
          request.schema, request.name, args.toSchema ?? request.schema, args.toName!, withData);
      case "table_move":
        return await api.previewMoveTable(request.schema, request.name, args.toSchema!);
      case "table_drop":
        return await api.previewDropTable(request.schema, request.name, cascade);
      case "db_new":
        return { sql: [`CREATE DATABASE ${qi(args.name ?? "")};`], warnings: [] };
      case "table_new":
        return {
          sql: [`CREATE TABLE ${qi(schemaName)}.${qi(args.name ?? "")} (\n  id serial PRIMARY KEY\n);`],
          warnings: ["Edit the SQL below to add your columns before applying."],
        };
      case "view_new":
        return {
          sql: [`CREATE VIEW ${qi(schemaName)}.${qi(args.name ?? "")} AS\n  SELECT 1 AS placeholder;`],
          warnings: ["Replace the SELECT with the query your view should expose."],
        };
      case "mview_new":
        return {
          sql: [`CREATE MATERIALIZED VIEW ${qi(schemaName)}.${qi(args.name ?? "")} AS\n  SELECT 1 AS placeholder\nWITH ${args.withData === "false" ? "NO DATA" : "DATA"};`],
          warnings: [
            "Replace the SELECT with your query.",
            "Materialized views aren't refreshed automatically — schedule REFRESH MATERIALIZED VIEW.",
          ],
        };
      case "function_new": {
        const name = args.name ?? "";
        const returns = args.returns?.trim() || "trigger";
        const language = args.language?.trim() || "plpgsql";
        // Trigger functions return TRIGGER; everything else gets a body
        // that returns NULL to keep the placeholder syntactically valid.
        const body = returns.toLowerCase() === "trigger"
          ? "BEGIN\n  RETURN NEW;\nEND;"
          : `BEGIN\n  -- TODO: implement\n  RETURN NULL::${returns};\nEND;`;
        return {
          sql: [
            `CREATE FUNCTION ${qi(schemaName)}.${qi(name)}()\n` +
            `RETURNS ${returns} LANGUAGE ${language} AS $$\n${body}\n$$;`,
          ],
          warnings: [
            "Edit arguments, return type, and body to match your needs.",
            "Use Schema → Activity if you need to debug a slow function.",
          ],
        };
      }
      case "schema_new":
        return {
          sql: [`CREATE SCHEMA ${qi(args.name ?? "")}${args.ifNotExists === "true" ? " IF NOT EXISTS" : ""};`],
          warnings: [],
        };
    }
  };

  const onPreview = async () => {
    setErr(null);
    try { setPreview(await buildPreview()); }
    catch (e) { setErr(String(e)); }
  };

  const onApply = async () => {
    if (!connId || !preview) return;
    setWorking(true);
    setErr(null);
    try {
      if (request.kind.startsWith("db_") && request.kind !== "db_new") {
        const forbidden = (request.kind === "db_drop"
          ? args.target
          : request.kind === "db_rename"
          ? args.fromName
          : request.kind === "db_duplicate"
          ? args.source
          : undefined);
        await api.applyDatabaseOp(connId, preview, forbidden ?? null);
      } else {
        await api.applyObjectOp(connId, preview);
      }
      // Refresh schema cache after a successful mutation.
      try { useStore.getState().setSchema(connId, await api.introspect(connId)); } catch {}
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={close}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <Form request={request} args={args} setArgs={setArgs}
            withData={withData} setWithData={setWithData}
            cascade={cascade} setCascade={setCascade}
            currentSchema={schemaName} />

          {preview && (
            <>
              <div className="section-title">SQL preview</div>
              <pre className="sql-preview">{preview.sql.join("\n")}</pre>
              {preview.warnings.length > 0 && (
                <div className="warnings">
                  {preview.warnings.map((w, i) => (
                    <div className="warn-row" key={i}>
                      <AlertTriangle size={13} /> <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {err && <pre className="sql-preview err">{err}</pre>}
        </div>
        <div className="modal-footer">
          <button className="btn-pill" onClick={onPreview}>Preview SQL</button>
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={close}>Cancel</button>
          <button
            className={`btn-pill ${request.kind.endsWith("_drop") ? "danger" : "primary"}`}
            disabled={!preview || working}
            onClick={onApply}
          >
            {working ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Form(p: {
  request: ObjectOpRequest;
  args: Record<string, string>;
  setArgs: (a: Record<string, string>) => void;
  withData: boolean; setWithData: (b: boolean) => void;
  cascade: boolean; setCascade: (b: boolean) => void;
  currentSchema: string;
}) {
  const set = (k: string, v: string) => p.setArgs({ ...p.args, [k]: v });
  switch (p.request.kind) {
    case "db_new":
      return field("Name", "name", p.args, set);
    case "db_rename":
      return (<div className="form-grid">
        {field("From", "fromName", p.args, set)}
        {field("To",   "toName",   p.args, set)}
      </div>);
    case "db_duplicate":
      return (<div className="form-grid">
        {field("Source", "source", p.args, set)}
        {field("Destination", "dest", p.args, set)}
      </div>);
    case "db_drop":
      return field("Database", "target", p.args, set);

    case "table_new":
      return (<>
        <div className="muted" style={{ marginBottom: 6 }}>Creating table in <code>{p.currentSchema}</code></div>
        {field("Name", "name", p.args, set)}
      </>);
    case "table_rename":
      return (<div className="form-grid">
        <label>From</label><input disabled value={`${p.request.schema}.${p.request.name}`} />
        {field("To", "toName", p.args, set)}
      </div>);
    case "table_duplicate":
      return (<div className="form-grid">
        <label>From</label><input disabled value={`${p.request.schema}.${p.request.name}`} />
        {field("To schema", "toSchema", p.args, set)}
        {field("To name", "toName", p.args, set)}
        <label>With data</label>
        <div>
          <input type="checkbox" checked={p.withData} onChange={(e) => p.setWithData(e.target.checked)} />
          <span className="muted" style={{ marginLeft: 6 }}>
            {p.withData ? "CREATE TABLE AS SELECT (rows copied; no constraints/indexes)"
              : "CREATE TABLE (LIKE … INCLUDING ALL) (no rows; constraints + indexes copied)"}
          </span>
        </div>
      </div>);
    case "table_move":
      return (<div className="form-grid">
        <label>Table</label><input disabled value={`${p.request.schema}.${p.request.name}`} />
        {field("Target schema", "toSchema", p.args, set)}
      </div>);
    case "table_drop":
      return (<div className="form-grid">
        <label>Table</label><input disabled value={`${p.request.schema}.${p.request.name}`} />
        <label>Cascade</label>
        <div>
          <input type="checkbox" checked={p.cascade} onChange={(e) => p.setCascade(e.target.checked)} />
          <span className="muted" style={{ marginLeft: 6 }}>
            Cascade drops dependent views, foreign keys, etc.
          </span>
        </div>
      </div>);

    case "view_new":
      return (<>
        <div className="muted" style={{ marginBottom: 6 }}>
          Creating view in <code>{p.currentSchema}</code>
        </div>
        {field("Name", "name", p.args, set)}
      </>);

    case "mview_new":
      return (<>
        <div className="muted" style={{ marginBottom: 6 }}>
          Creating materialized view in <code>{p.currentSchema}</code>
        </div>
        <div className="form-grid">
          {field("Name", "name", p.args, set)}
          <label>Populate with data now</label>
          <div>
            <input
              type="checkbox"
              checked={p.args.withData !== "false"}
              onChange={(e) => set("withData", e.target.checked ? "true" : "false")}
            />
            <span className="muted" style={{ marginLeft: 6 }}>
              When off, the view is created empty (WITH NO DATA).
            </span>
          </div>
        </div>
      </>);

    case "function_new":
      return (<>
        <div className="muted" style={{ marginBottom: 6 }}>
          Creating function in <code>{p.currentSchema}</code>
        </div>
        <div className="form-grid">
          {field("Name", "name", p.args, set)}
          {field("Return type", "returns", p.args, set)}
          {field("Language", "language", p.args, set)}
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Defaults: <code>RETURNS trigger LANGUAGE plpgsql</code>. The
          generated body is a stub you can edit in the SQL preview before
          applying.
        </p>
      </>);

    case "schema_new":
      return (<div className="form-grid">
        {field("Name", "name", p.args, set)}
        <label>IF NOT EXISTS</label>
        <div>
          <input
            type="checkbox"
            checked={p.args.ifNotExists === "true"}
            onChange={(e) => set("ifNotExists", e.target.checked ? "true" : "")}
          />
          <span className="muted" style={{ marginLeft: 6 }}>
            Skip the create when a schema by this name already exists.
          </span>
        </div>
      </div>);
  }
}

function field(label: string, key: string, args: Record<string, string>, set: (k: string, v: string) => void) {
  return (<>
    <label>{label}</label>
    <input type="text" value={args[key] ?? ""} onChange={(e) => set(key, e.target.value)} autoFocus />
  </>);
}

function titleFor(r: ObjectOpRequest): string {
  switch (r.kind) {
    case "db_new":       return "Create database";
    case "db_rename":    return "Rename database";
    case "db_duplicate": return "Duplicate database";
    case "db_drop":      return "Drop database";
    case "table_new":    return "Create table";
    case "table_rename": return `Rename ${r.schema}.${r.name}`;
    case "table_duplicate": return `Duplicate ${r.schema}.${r.name}`;
    case "table_move":   return `Move ${r.schema}.${r.name} to another schema`;
    case "table_drop":   return `Drop ${r.schema}.${r.name}`;
    case "view_new":     return "Create view";
    case "mview_new":    return "Create materialized view";
    case "function_new": return "Create function";
    case "schema_new":   return "Create schema";
  }
}

function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
