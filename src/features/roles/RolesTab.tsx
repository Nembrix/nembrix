import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCcw, Trash2, AlertTriangle } from "lucide-react";
import type { Tab } from "@/store";
import * as api from "@/ipc/commands";
import type { CellValue, RowBatch } from "@/ipc/types";
import {
  ALL_TABLE_PRIVS, alterRoleSql, createRoleSql, dropRoleSql, grantSql,
  type PrivilegeEdit, type TablePriv,
  ROLES_QUERY, relationPrivsForRoleInSchema,
} from "./sql";

/* ───────────────────────── types ───────────────────────── */

interface Role {
  name: string;
  is_super: boolean;
  can_createdb: boolean;
  can_createrole: boolean;
  can_login: boolean;
  can_repl: boolean;
  inherits: boolean;
  conn_limit: number;
  valid_until: string | null;
  memberof: string[];
}

interface RelationPrivRow {
  name: string;
  kind: string;
  privs: Partial<Record<TablePriv, boolean>>;
}

/* ───────────────────────── component ───────────────────────── */

export default function RolesTab({ tab }: { tab: Tab }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState<string>("public");
  const [rels, setRels] = useState<RelationPrivRow[]>([]);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<PrivilegeEdit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const refreshRolesRef = useRef<() => void>(() => {});
  const refreshMatrixRef = useRef<() => void>(() => {});

  /* roles */
  refreshRolesRef.current = async () => {
    try {
      const rows = await fetchRows(tab.connId, ROLES_QUERY);
      const parsed = rows.map(rowToRole);
      setRoles(parsed);
      if (!selectedRole && parsed.length > 0) setSelectedRole(parsed[0].name);
      setErr(null);
    } catch (e) { setErr(String(e)); }
  };

  /* schemas (small list, populated once per connection) */
  useEffect(() => {
    let cancelled = false;
    api.introspect(tab.connId)
      .then((tree) => {
        if (cancelled) return;
        const list = tree.databases[0]?.schemas.map((s) => s.name) ?? [];
        setSchemas(list);
        if (!list.includes(schema) && list[0]) setSchema(list[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connId]);

  /* roles fetch on mount */
  useEffect(() => { refreshRolesRef.current(); }, [tab.connId]);

  /* relation grants for current (role, schema) */
  refreshMatrixRef.current = async () => {
    if (!selectedRole || !schema) { setRels([]); return; }
    try {
      const rows = await fetchRows(tab.connId, relationPrivsForRoleInSchema(selectedRole, schema));
      setRels(rows.map(rowToRelPriv));
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { refreshMatrixRef.current(); }, [tab.connId, selectedRole, schema]);

  const role = useMemo(() => roles.find((r) => r.name === selectedRole) ?? null, [roles, selectedRole]);

  const filteredRels = useMemo(() => {
    if (!filter) return rels;
    const f = filter.toLowerCase();
    return rels.filter((r) => r.name.toLowerCase().includes(f));
  }, [rels, filter]);

  const togglePriv = (relName: string, priv: TablePriv, currentlyGranted: boolean) => {
    if (!selectedRole) return;
    setPending((prev) => {
      // Compute the new pending state. If a pending edit already exists for this
      // (rel, priv) it means the user is re-clicking — toggling cancels it.
      const idx = prev.findIndex(
        (p) => p.scope === "table" && p.relation === relName && p.privilege === priv,
      );
      if (idx >= 0) {
        const next = [...prev];
        next.splice(idx, 1);
        return next;
      }
      return [...prev, { scope: "table", schema, relation: relName, privilege: priv, grant: !currentlyGranted }];
    });
    setRels((rs) => rs.map((r) =>
      r.name === relName ? { ...r, privs: { ...r.privs, [priv]: !currentlyGranted } } : r,
    ));
  };

  const clearPending = () => {
    setPending([]);
    refreshMatrixRef.current(); // resync to server state
  };

  const applyPending = async () => {
    if (!pending.length || !selectedRole) return;
    const transactional = ["BEGIN;", ...pending.map((p) => grantSql(selectedRole, p)), "COMMIT;"];
    try {
      for (const stmt of transactional) {
        await api.execute(tab.connId, stmt);
      }
      setPending([]);
      refreshMatrixRef.current();
    } catch (e) {
      // Roll back implicitly by leaving COMMIT off — but the pending list survives so the user can edit.
      setErr(String(e));
      try { await api.execute(tab.connId, "ROLLBACK;"); } catch {}
    }
  };

  const dropSelectedRole = async () => {
    if (!role) return;
    const ok = confirm(
      `Drop role "${role.name}"?\n\nThis will REASSIGN OWNED to "postgres" first, then DROP OWNED, then DROP ROLE.`,
    );
    if (!ok) return;
    try {
      const sql = dropRoleSql(role.name, "postgres");
      for (const stmt of sql.split("\n")) await api.execute(tab.connId, stmt);
      setSelectedRole(null);
      refreshRolesRef.current();
    } catch (e) { setErr(String(e)); }
  };

  const alterAttr = async (patch: Parameters<typeof alterRoleSql>[1]) => {
    if (!role) return;
    try {
      await api.execute(tab.connId, alterRoleSql(role.name, patch));
      refreshRolesRef.current();
    } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="roles-shell">
      <aside className="roles-sidebar">
        <div className="pane-toolbar">
          <strong>Roles</strong>
          <span className="muted">{roles.length}</span>
          <div className="spacer" />
          <button className="icon-btn" title="New role" onClick={() => setShowCreate(true)}>
            <Plus size={13} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => refreshRolesRef.current()}>
            <RefreshCcw size={13} />
          </button>
        </div>
        <div className="roles-list">
          {roles.length === 0 && <div className="muted placeholder" style={{ padding: 14 }}>Loading…</div>}
          {roles.map((r) => (
            <div
              key={r.name}
              className={`role-row ${selectedRole === r.name ? "selected" : ""}`}
              onClick={() => setSelectedRole(r.name)}
            >
              <span className="role-name">{r.name}</span>
              <span className="role-flags">
                {r.is_super && <span className="role-flag super">S</span>}
                {r.can_createdb && <span className="role-flag">DB</span>}
                {r.can_createrole && <span className="role-flag">RL</span>}
                {r.can_login || <span className="role-flag dim">NL</span>}
                {r.can_repl && <span className="role-flag">RPL</span>}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <main className="roles-main">
        {err && (
          <div className="message-pane err" style={{ padding: 8, display: "flex", gap: 8, alignItems: "center" }}>
            <AlertTriangle size={13} />
            <span style={{ flex: 1 }}>{err}</span>
            <button className="btn-pill" onClick={() => setErr(null)}>Dismiss</button>
          </div>
        )}

        {role ? (
          <>
            <div className="role-attrs">
              <div className="role-attrs-header">
                <span className="role-attrs-title">{role.name}</span>
                {role.memberof.length > 0 && (
                  <span className="muted">member of {role.memberof.join(", ")}</span>
                )}
                <div className="spacer" />
                <button className="btn-pill danger" onClick={dropSelectedRole}>
                  <Trash2 size={12} /> Drop role
                </button>
              </div>
              <div className="role-attr-grid">
                <AttrToggle label="LOGIN"      checked={role.can_login}      onChange={(v) => alterAttr({ canLogin: v })} />
                <AttrToggle label="SUPERUSER"  checked={role.is_super}       onChange={(v) => alterAttr({ isSuper: v })} />
                <AttrToggle label="CREATEDB"   checked={role.can_createdb}   onChange={(v) => alterAttr({ canCreatedb: v })} />
                <AttrToggle label="CREATEROLE" checked={role.can_createrole} onChange={(v) => alterAttr({ canCreaterole: v })} />
                <AttrToggle label="REPLICATION" checked={role.can_repl}      onChange={(v) => alterAttr({})} disabled />
                <AttrToggle label="INHERIT"    checked={role.inherits}       onChange={(v) => alterAttr({ inherits: v })} />
              </div>
            </div>

            <div className="grant-matrix-toolbar">
              <strong>Grant matrix</strong>
              <select value={schema} onChange={(e) => setSchema(e.target.value)}>
                {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input
                className="search-input"
                style={{ width: 200, paddingLeft: 8 }}
                placeholder="Filter relations…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="spacer" />
              {pending.length > 0 && (
                <>
                  <span className="muted">{pending.length} pending</span>
                  <button className="btn-pill" onClick={clearPending}>Cancel</button>
                  <button className="btn-pill primary" onClick={applyPending}>
                    Apply in transaction
                  </button>
                </>
              )}
            </div>

            <div className="grant-matrix">
              <table className="meta-table grant-matrix-table">
                <thead><tr>
                  <th>Relation</th>
                  {ALL_TABLE_PRIVS.map((p) => <th key={p}>{p}</th>)}
                </tr></thead>
                <tbody>
                  {filteredRels.length === 0 && (
                    <tr><td colSpan={ALL_TABLE_PRIVS.length + 1} className="muted" style={{ textAlign: "center", padding: 20 }}>
                      No relations in this schema.
                    </td></tr>
                  )}
                  {filteredRels.map((r) => (
                    <tr key={r.name}>
                      <td className="mono">
                        <span className="kbd" style={{ marginRight: 6 }}>{kindLabel(r.kind)}</span>
                        {r.name}
                      </td>
                      {ALL_TABLE_PRIVS.map((p) => {
                        const granted = !!r.privs[p];
                        const isPending = pending.some(
                          (pe) => pe.scope === "table" && pe.relation === r.name && pe.privilege === p,
                        );
                        return (
                          <td key={p} className="priv-cell" onClick={() => togglePriv(r.name, p, granted)}>
                            <span className={`priv-check ${granted ? "on" : ""} ${isPending ? "pending" : ""}`}>
                              {granted ? "✓" : ""}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pending.length > 0 && (
              <div className="pending-preview">
                <strong>SQL preview</strong>
                <pre className="sql-preview" style={{ margin: 0 }}>
                  {[
                    "BEGIN;",
                    ...pending.map((p) => grantSql(role.name, p)),
                    "COMMIT;",
                  ].join("\n")}
                </pre>
              </div>
            )}
          </>
        ) : (
          <div className="placeholder muted">Select a role to manage its grants.</div>
        )}
      </main>

      {showCreate && (
        <CreateRoleDialog
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            try {
              await api.execute(tab.connId, createRoleSql(input));
              setShowCreate(false);
              setSelectedRole(input.name);
              refreshRolesRef.current();
            } catch (e) { setErr(String(e)); }
          }}
        />
      )}
    </div>
  );
}

/* ──────────────────────── subcomponents ──────────────────────── */

function AttrToggle({ label, checked, onChange, disabled }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`attr-toggle ${checked ? "on" : ""} ${disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function CreateRoleDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (i: import("./sql").CreateRoleInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [canLogin, setCanLogin] = useState(true);
  const [isSuper, setIsSuper] = useState(false);
  const [canCreatedb, setCanCreatedb] = useState(false);
  const [canCreaterole, setCanCreaterole] = useState(false);
  const [inherits, setInherits] = useState(true);
  const preview = createRoleSql({
    name: name || "<name>",
    password: password || undefined,
    canLogin, isSuper, canCreatedb, canCreaterole, inherits,
  });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Create role</div>
        <div className="modal-body">
          <div className="form-grid">
            <label>Name</label>
            <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="leave blank for no password" />
            <label>LOGIN</label>
            <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} />
            <label>SUPERUSER</label>
            <input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} />
            <label>CREATEDB</label>
            <input type="checkbox" checked={canCreatedb} onChange={(e) => setCanCreatedb(e.target.checked)} />
            <label>CREATEROLE</label>
            <input type="checkbox" checked={canCreaterole} onChange={(e) => setCanCreaterole(e.target.checked)} />
            <label>INHERIT</label>
            <input type="checkbox" checked={inherits} onChange={(e) => setInherits(e.target.checked)} />
          </div>
          <div className="section-title">SQL preview</div>
          <pre className="sql-preview">{preview}</pre>
        </div>
        <div className="modal-footer">
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>Cancel</button>
          <button
            className="btn-pill primary"
            disabled={!name.trim()}
            onClick={() => onCreate({
              name, password: password || undefined,
              canLogin, isSuper, canCreatedb, canCreaterole, inherits,
            })}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────── helpers ──────────────────────── */

function kindLabel(k: string): string {
  switch (k) {
    case "r": return "TBL";
    case "v": return "VW";
    case "m": return "MV";
    case "f": return "FT";
    case "p": return "PT";
    default:  return k;
  }
}

async function fetchRows(connId: string, sql: string): Promise<Array<Record<string, string>>> {
  return await new Promise((resolve, reject) => {
    const accum: RowBatch[] = [];
    let columns: { name: string }[] = [];
    api.stream(connId, sql, (b) => {
      if (b.columns) columns = b.columns;
      accum.push(b);
      if (b.done) {
        const rows = accum.flatMap((bb) => bb.rows);
        resolve(rows.map((r) => {
          const o: Record<string, string> = {};
          columns.forEach((c, i) => { o[c.name] = cellToString(r[i]); });
          return o;
        }));
      }
    }).catch(reject);
  });
}

function cellToString(v: CellValue): string {
  switch (v.kind) {
    case "null": return "";
    case "bool": return v.value ? "true" : "false";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw": return v.value;
    case "document": return JSON.stringify(v.value);
    case "bytes": return `<${v.value.length}b>`;
  }
}

function rowToRole(r: Record<string, string>): Role {
  const memberStr = r.memberof || "";
  // pg array literal: {a,b} or {} or NULL
  const memberof = memberStr.startsWith("{") && memberStr.length > 2
    ? memberStr.slice(1, -1).split(",").map((s) => s.replace(/^"|"$/g, ""))
    : [];
  return {
    name: r.name,
    is_super: r.is_super === "true" || r.is_super === "t",
    can_createdb: r.can_createdb === "true" || r.can_createdb === "t",
    can_createrole: r.can_createrole === "true" || r.can_createrole === "t",
    can_login: r.can_login === "true" || r.can_login === "t",
    can_repl: r.can_repl === "true" || r.can_repl === "t",
    inherits: r.inherits === "true" || r.inherits === "t",
    conn_limit: parseInt(r.conn_limit ?? "-1"),
    valid_until: r.valid_until || null,
    memberof,
  };
}

function rowToRelPriv(r: Record<string, string>): RelationPrivRow {
  const privs: Partial<Record<TablePriv, boolean>> = {};
  for (const p of ALL_TABLE_PRIVS) {
    const v = r[`p_${p.toLowerCase()}`];
    privs[p] = v === "true" || v === "t";
  }
  return { name: r.name, kind: r.kind, privs };
}
