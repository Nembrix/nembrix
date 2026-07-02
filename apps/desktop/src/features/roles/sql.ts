/**
 * SQL builders + catalog queries for the roles & permissions UI.
 *
 * Everything is plain template strings — no `pg` driver here. The strings
 * are fed through the existing `api.stream`/`api.execute` paths so the
 * mock/sidecar/Tauri layers all work unchanged.
 */

const TABLE_PRIVS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
] as const;
export type TablePriv = typeof TABLE_PRIVS[number];
export const ALL_TABLE_PRIVS = TABLE_PRIVS;

/* ─────────────────────────── catalog queries ─────────────────────────── */

/**
 * All roles in the cluster + membership list. We expose a single result
 * with a `memberof[]` text column so the React side doesn't have to do a
 * second round-trip.
 */
export const ROLES_QUERY = `
SELECT
  r.rolname        AS name,
  r.rolsuper       AS is_super,
  r.rolcreatedb    AS can_createdb,
  r.rolcreaterole  AS can_createrole,
  r.rolcanlogin    AS can_login,
  r.rolreplication AS can_repl,
  r.rolinherit     AS inherits,
  r.rolconnlimit   AS conn_limit,
  to_char(r.rolvaliduntil, 'YYYY-MM-DD HH24:MI:SSOF') AS valid_until,
  (SELECT array_agg(parent.rolname ORDER BY parent.rolname)
     FROM pg_auth_members m
     JOIN pg_roles parent ON parent.oid = m.roleid
     WHERE m.member = r.oid) AS memberof
FROM pg_roles r
ORDER BY r.rolname;
`.trim();

/**
 * Databases each role can CONNECT to. One row per (role, database) pair, so
 * the UI can group them into a per-role list and offer a "filter by database"
 * control. We test CONNECT rather than reading ACLs directly so that implicit
 * access (superusers, PUBLIC grants, role membership) is reflected correctly.
 */
export const ROLE_DATABASES_QUERY = `
SELECT
  r.rolname AS role,
  d.datname AS database
FROM pg_roles r
CROSS JOIN pg_database d
WHERE d.datallowconn
  AND has_database_privilege(r.oid, d.oid, 'CONNECT')
ORDER BY r.rolname, d.datname;
`.trim();

/**
 * Relations in a schema with the per-privilege bits the chosen role holds.
 * One column per privilege so the UI can render checkboxes directly.
 * has_table_privilege() works for tables, views and matviews alike.
 */
export function relationPrivsForRoleInSchema(role: string, schema: string): string {
  const checks = TABLE_PRIVS
    .map((p) => `has_table_privilege(${q(role)}, c.oid, ${q(p)}) AS p_${p.toLowerCase()}`)
    .join(",\n  ");
  return `
SELECT
  c.relname AS name,
  c.relkind AS kind,
  ${checks}
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${q(schema)}
  AND c.relkind IN ('r','v','m','f','p')
ORDER BY c.relname;
`.trim();
}

/* ─────────────────────────── DDL generators ─────────────────────────── */

export interface CreateRoleInput {
  name: string;
  password?: string;
  canLogin: boolean;
  isSuper: boolean;
  canCreatedb: boolean;
  canCreaterole: boolean;
  inherits: boolean;
  connLimit?: number;
  validUntil?: string; // ISO date
}

export function createRoleSql(i: CreateRoleInput): string {
  const opts: string[] = [];
  opts.push(i.canLogin ? "LOGIN" : "NOLOGIN");
  if (i.isSuper) opts.push("SUPERUSER"); else opts.push("NOSUPERUSER");
  if (i.canCreatedb) opts.push("CREATEDB"); else opts.push("NOCREATEDB");
  if (i.canCreaterole) opts.push("CREATEROLE"); else opts.push("NOCREATEROLE");
  opts.push(i.inherits ? "INHERIT" : "NOINHERIT");
  if (i.password) opts.push(`PASSWORD ${q(i.password)}`);
  if (i.connLimit != null) opts.push(`CONNECTION LIMIT ${i.connLimit}`);
  if (i.validUntil) opts.push(`VALID UNTIL ${q(i.validUntil)}`);
  return `CREATE ROLE ${qi(i.name)} WITH ${opts.join(" ")};`;
}

/** Three-statement drop that reassigns and drops owned objects first. */
export function dropRoleSql(name: string, reassignTo: string): string {
  return [
    `REASSIGN OWNED BY ${qi(name)} TO ${qi(reassignTo)};`,
    `DROP OWNED BY ${qi(name)};`,
    `DROP ROLE ${qi(name)};`,
  ].join("\n");
}

export interface RoleAttributes {
  isSuper?: boolean;
  canCreatedb?: boolean;
  canCreaterole?: boolean;
  canLogin?: boolean;
  inherits?: boolean;
  connLimit?: number;
  validUntil?: string;
  password?: string;
}

export function alterRoleSql(name: string, a: RoleAttributes): string {
  const opts: string[] = [];
  if (a.isSuper != null) opts.push(a.isSuper ? "SUPERUSER" : "NOSUPERUSER");
  if (a.canCreatedb != null) opts.push(a.canCreatedb ? "CREATEDB" : "NOCREATEDB");
  if (a.canCreaterole != null) opts.push(a.canCreaterole ? "CREATEROLE" : "NOCREATEROLE");
  if (a.canLogin != null) opts.push(a.canLogin ? "LOGIN" : "NOLOGIN");
  if (a.inherits != null) opts.push(a.inherits ? "INHERIT" : "NOINHERIT");
  if (a.password) opts.push(`PASSWORD ${q(a.password)}`);
  if (a.connLimit != null) opts.push(`CONNECTION LIMIT ${a.connLimit}`);
  if (a.validUntil) opts.push(`VALID UNTIL ${q(a.validUntil)}`);
  return `ALTER ROLE ${qi(name)} WITH ${opts.join(" ")};`;
}

/* ───────────────────────── grant / revoke ───────────────────────── */

export interface PrivilegeEdit {
  /** Either "table" (incl. view/matview) or "schema" for schema-level USAGE. */
  scope: "table" | "schema" | "database";
  schema?: string;
  relation?: string;
  database?: string;
  privilege: TablePriv | "USAGE" | "CONNECT" | "TEMPORARY";
  /** true = GRANT, false = REVOKE. */
  grant: boolean;
}

export function grantSql(role: string, edit: PrivilegeEdit): string {
  const verb = edit.grant ? "GRANT" : "REVOKE";
  const direction = edit.grant ? "TO" : "FROM";
  switch (edit.scope) {
    case "database":
      return `${verb} ${edit.privilege} ON DATABASE ${qi(edit.database!)} ${direction} ${qi(role)};`;
    case "schema":
      return `${verb} ${edit.privilege} ON SCHEMA ${qi(edit.schema!)} ${direction} ${qi(role)};`;
    case "table":
      return `${verb} ${edit.privilege} ON ${qi(edit.schema!)}.${qi(edit.relation!)} ${direction} ${qi(role)};`;
  }
}

/* ───────────────────────── tiny escape helpers ───────────────────────── */

export function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
function q(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`;
}
