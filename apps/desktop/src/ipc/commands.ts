import type {
  ConnectionInput,
  ConnectionRecord,
  ExecSummary,
  QueryHandle,
  RowBatch,
  SchemaTree,
  ScriptOutcome,
} from "./types";
import {
  probeSidecar,
  sidecarAvailable,
  sidecarConnect,
  sidecarDisconnect,
  sidecarIntrospect,
  sidecarExecute,
  sidecarCancel,
  sidecarStream,
  sidecarTestConnection,
} from "./sidecar";

// Kick off the probe immediately — best-effort, doesn't block import.
void probeSidecar();

/**
 * Feature-detect Tauri at runtime. Importing `@tauri-apps/api/core` outside a
 * Tauri webview blows up on the very first `invoke()` because `window.__TAURI_INTERNALS__`
 * is undefined. We lazy-load the real module only when we know we're inside Tauri,
 * and otherwise route every command to an in-memory mock so `npm run dev` works
 * in a plain browser for fast UI iteration.
 */
export const isTauri =
  typeof window !== "undefined" &&
  // Tauri 2 injects this object before the bundle runs.
  // @ts-expect-error injected at runtime
  (window.__TAURI_INTERNALS__ || window.__TAURI__) !== undefined;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ChannelLike<T> = { onmessage: (b: T) => void };

let realInvoke: Invoke | null = null;
let RealChannel: { new <T>(): ChannelLike<T> } | null = null;

async function getReal() {
  if (!realInvoke) {
    const core = await import("@tauri-apps/api/core");
    realInvoke = core.invoke as Invoke;
    RealChannel = core.Channel as never;
  }
  return { invoke: realInvoke!, Channel: RealChannel! };
}

/* ───────────────────────── browser mock ─────────────────────────
   Lets the UI run end-to-end in `npm run dev` without a Tauri host.
   State persists in localStorage so reloads keep your saved connections.
*/

const LS_KEY = "nembrix.mock.connections";

function loadMockConns(): ConnectionRecord[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
}
function saveMockConns(cs: ConnectionRecord[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(cs));
}

async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  // Tiny artificial delay so loading states show.
  await new Promise((r) => setTimeout(r, 80));

  switch (cmd) {
    case "list_connections":
      return loadMockConns() as unknown as T;

    case "save_connection": {
      const input = args.input as ConnectionInput;
      const cs = loadMockConns();
      const now = new Date().toISOString();
      const id = input.id ?? crypto.randomUUID();
      // In browser-dev mode we have no OS keychain, so the password lives
      // on the saved record itself. (The sidecar reads it via lookup()
      // before forwarding to Postgres.) This is fine for local dev where
      // localStorage is per-origin; it must NEVER ship outside dev.
      const existingRec = cs.find((c) => c.id === id);
      const rec: ConnectionRecord & { password?: string | null; sshPassword?: string | null; sshKeyPassphrase?: string | null } = {
        id,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        username: input.username,
        database: input.database,
        ssl_mode: input.ssl_mode,
        ssh: input.ssh ? {
          host: input.ssh.host,
          port: input.ssh.port,
          user: input.ssh.user,
          auth_kind: input.ssh.auth_kind,
          key_path: input.ssh.key_path,
          strict_host_key: input.ssh.strict_host_key,
        } : null,
        color: input.color,
        environment: input.environment,
        group: input.group ?? null,
        created_at: now,
        updated_at: now,
        // Preserve prior secret bits when input fields are omitted (the
        // manager dialog's "patch group" flow does this — it doesn't want
        // to wipe the password just to change a label).
        password: input.password ?? (existingRec as { password?: string | null })?.password ?? null,
        sshPassword: input.ssh?.password ?? (existingRec as { sshPassword?: string | null })?.sshPassword ?? null,
        sshKeyPassphrase: input.ssh?.key_passphrase ?? (existingRec as { sshKeyPassphrase?: string | null })?.sshKeyPassphrase ?? null,
      };
      const existing = cs.findIndex((c) => c.id === id);
      if (existing >= 0) cs[existing] = rec; else cs.push(rec);
      saveMockConns(cs);
      return rec as unknown as T;
    }

    case "delete_connection": {
      const id = args.id as string;
      saveMockConns(loadMockConns().filter((c) => c.id !== id));
      return undefined as unknown as T;
    }

    case "test_connection":
      return 42 as unknown as T; // pretend the round-trip took 42ms

    case "connect":
    case "disconnect":
    case "trust_ssh_host":
    case "update_menu_state":
      return undefined as unknown as T;

    case "introspect": {
      const sample: SchemaTree = {
        databases: [{
          name: "demo",
          schemas: [{
            name: "public",
            tables: [
              {
                name: "users",
                primary_key: ["id"],
                foreign_keys: [],
                indexes: [
                  { name: "users_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree",
                    definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" },
                  { name: "users_email_key", columns: ["email"], is_unique: true, is_primary: false, method: "btree",
                    definition: "CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)" },
                ],
                columns: [
                  { name: "id", type_name: "integer", nullable: false, default: "nextval('users_id_seq')" },
                  { name: "email", type_name: "text", nullable: false, default: null },
                  { name: "name", type_name: "text", nullable: false, default: null },
                  { name: "created_at", type_name: "timestamptz", nullable: true, default: "now()" },
                ],
              },
              {
                name: "orders",
                primary_key: ["id"],
                foreign_keys: [{
                  name: "orders_user_id_fkey",
                  columns: ["user_id"],
                  referenced_schema: "public",
                  referenced_table: "users",
                  referenced_columns: ["id"],
                }],
                indexes: [
                  { name: "orders_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree",
                    definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)" },
                  { name: "orders_user_id_idx", columns: ["user_id"], is_unique: false, is_primary: false, method: "btree",
                    definition: "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)" },
                  { name: "orders_payload_gin", columns: ["payload"], is_unique: false, is_primary: false, method: "gin",
                    definition: "CREATE INDEX orders_payload_gin ON public.orders USING gin (payload)" },
                ],
                columns: [
                  { name: "id", type_name: "integer", nullable: false, default: null },
                  { name: "user_id", type_name: "integer", nullable: true, default: null },
                  { name: "total_cents", type_name: "bigint", nullable: false, default: null },
                  { name: "payload", type_name: "jsonb", nullable: true, default: null },
                  { name: "placed_at", type_name: "timestamptz", nullable: true, default: "now()" },
                ],
              },
            ],
            views: [],
            functions: [],
          }],
        }],
      };
      return sample as unknown as T;
    }

    case "execute": {
      return { rows_affected: 1, last_insert_id: null, elapsed_ms: 12 } as unknown as T;
    }

    case "stream": {
      const sink = args.sink as ChannelLike<RowBatch>;
      const rawSql = String(args.sql ?? "");
      // Test hook (mock backend only, never reached under Tauri): resolve the
      // call but never emit a batch, reproducing a wedged connection so the
      // stall watchdog can be exercised end to end.
      if ((window as { __STALL_STREAM__?: boolean }).__STALL_STREAM__) {
        return "stalled-handle" as T;
      }
      const sql = rawSql.toLowerCase();
      // Record this Run in mock history.
      try {
        const all: Array<{ conn_id: string; sql: string; elapsed_ms: number; run_at: string }> =
          JSON.parse(localStorage.getItem("nembrix.mock.history") || "[]");
        all.unshift({
          conn_id: String(args.connId ?? ""),
          sql: rawSql,
          elapsed_ms: 12,
          run_at: new Date().toISOString(),
        });
        localStorage.setItem("nembrix.mock.history", JSON.stringify(all.slice(0, 500)));
      } catch { /* ignore: best-effort */ }
      // Roles tab queries (sql is already lowercase here).
      if (/has_database_privilege/i.test(sql)) {
        const txt = (v: string) => ({ kind: "text" as const, value: v });
        const batchRoleDbs: RowBatch = {
          columns: [
            { name: "role",     type_name: "TEXT", nullable: false },
            { name: "database", type_name: "TEXT", nullable: false },
          ],
          rows: ([
            ["postgres", "demo"], ["postgres", "analytics"], ["postgres", "postgres"],
            ["qa", "demo"], ["qa", "analytics"],
            ["readonly", "demo"],
            ["app_user", "demo"],
          ] as [string, string][]).map(([role, db]) => [txt(role), txt(db)]),
          done: true,
        };
        setTimeout(() => sink.onmessage(batchRoleDbs), 30);
        return crypto.randomUUID() as unknown as T;
      }
      if (/from\s+pg_roles/i.test(sql)) {
        const txt = (v: string) => ({ kind: "text" as const, value: v });
        const bool = (v: boolean) => ({ kind: "bool" as const, value: v });
        const int = (v: number) => ({ kind: "int" as const, value: v });
        const nul = { kind: "null" as const };
        const arrLit = (xs: string[]) => xs.length ? `{${xs.join(",")}}` : "{}";
        const batchRoles: RowBatch = {
          columns: [
            { name: "name",           type_name: "TEXT", nullable: false },
            { name: "is_super",       type_name: "BOOL", nullable: false },
            { name: "can_createdb",   type_name: "BOOL", nullable: false },
            { name: "can_createrole", type_name: "BOOL", nullable: false },
            { name: "can_login",      type_name: "BOOL", nullable: false },
            { name: "can_repl",       type_name: "BOOL", nullable: false },
            { name: "inherits",       type_name: "BOOL", nullable: false },
            { name: "conn_limit",     type_name: "INT4", nullable: false },
            { name: "valid_until",    type_name: "TEXT", nullable: true },
            { name: "memberof",       type_name: "_TEXT", nullable: true },
          ],
          rows: [
            [txt("postgres"),  bool(true),  bool(true),  bool(true),  bool(true), bool(true), bool(true),  int(-1), nul, txt(arrLit([]))],
            [txt("qa"),        bool(false), bool(false), bool(false), bool(true), bool(false), bool(true), int(-1), nul, txt(arrLit(["readonly"]))],
            [txt("readonly"),  bool(false), bool(false), bool(false), bool(false), bool(false), bool(true), int(-1), nul, txt(arrLit([]))],
            [txt("app_user"),  bool(false), bool(false), bool(false), bool(true), bool(false), bool(true), int(-1), nul, txt(arrLit([]))],
          ],
          done: true,
        };
        setTimeout(() => sink.onmessage(batchRoles), 30);
        return crypto.randomUUID() as unknown as T;
      }
      if (/has_table_privilege/i.test(sql)) {
        const txt = (v: string) => ({ kind: "text" as const, value: v });
        const bool = (v: boolean) => ({ kind: "bool" as const, value: v });
        // Parse role name out of the SQL so the mock can vary by role.
        const roleMatch = sql.match(/has_table_privilege\('([^']+)'/);
        const role = roleMatch?.[1] ?? "qa";
        const allBits = role === "postgres";
        const someBits = role === "qa";
        const batchPrivs: RowBatch = {
          columns: [
            { name: "name", type_name: "TEXT", nullable: false },
            { name: "kind", type_name: "TEXT", nullable: false },
            { name: "p_select",     type_name: "BOOL", nullable: false },
            { name: "p_insert",     type_name: "BOOL", nullable: false },
            { name: "p_update",     type_name: "BOOL", nullable: false },
            { name: "p_delete",     type_name: "BOOL", nullable: false },
            { name: "p_truncate",   type_name: "BOOL", nullable: false },
            { name: "p_references", type_name: "BOOL", nullable: false },
            { name: "p_trigger",    type_name: "BOOL", nullable: false },
          ],
          rows: [
            ["users", "r"], ["orders", "r"],
          ].map(([name, kind]) => [
            txt(name), txt(kind),
            bool(allBits || someBits),    // SELECT
            bool(allBits),                // INSERT
            bool(allBits),                // UPDATE
            bool(allBits),                // DELETE
            bool(allBits),                // TRUNCATE
            bool(allBits),                // REFERENCES
            bool(allBits),                // TRIGGER
          ]),
          done: true,
        };
        setTimeout(() => sink.onmessage(batchPrivs), 30);
        return crypto.randomUUID() as unknown as T;
      }

      // Activity tab queries — return plausible sessions / overview.
      let batch: RowBatch;
      if (/pg_stat_activity/.test(sql)) {
        batch = {
          columns: [
            { name: "pid", type_name: "INT4", nullable: false },
            { name: "datname", type_name: "TEXT", nullable: false },
            { name: "usename", type_name: "TEXT", nullable: false },
            { name: "application_name", type_name: "TEXT", nullable: false },
            { name: "client_addr", type_name: "TEXT", nullable: false },
            { name: "state", type_name: "TEXT", nullable: false },
            { name: "wait_event_type", type_name: "TEXT", nullable: true },
            { name: "wait_event", type_name: "TEXT", nullable: true },
            { name: "backend_start", type_name: "TEXT", nullable: false },
            { name: "xact_start", type_name: "TEXT", nullable: true },
            { name: "query_start", type_name: "TEXT", nullable: true },
            { name: "state_change", type_name: "TEXT", nullable: true },
            { name: "query", type_name: "TEXT", nullable: true },
          ],
          rows: [
            mockSession(8412, "demo", "alice", "psql", "10.0.0.42", "active", null, null, "SELECT * FROM orders WHERE total_cents > 1000"),
            mockSession(8417, "demo", "bob",   "dbclient", "10.0.0.51", "idle in transaction", "Client", "ClientRead", "BEGIN"),
            mockSession(8421, "demo", "carol", "pgbouncer", "10.0.0.7", "idle", "Client", "ClientRead", ""),
          ],
          done: true,
        };
        setTimeout(() => sink.onmessage(batch), 30);
        return crypto.randomUUID() as unknown as T;
      }
      if (/sessions\s*,\s*max_conn/.test(sql) || /max_connections/.test(sql)) {
        batch = {
          columns: [
            { name: "sessions", type_name: "INT8", nullable: false },
            { name: "max_conn", type_name: "INT4", nullable: false },
            { name: "server_version", type_name: "INT4", nullable: false },
            { name: "txns_total", type_name: "NUMERIC", nullable: false },
            { name: "cache_hit_pct", type_name: "NUMERIC", nullable: false },
            { name: "deadlocks", type_name: "NUMERIC", nullable: false },
          ],
          rows: [[
            { kind: "int", value: 3 },
            { kind: "int", value: 100 },
            { kind: "int", value: 160003 },
            { kind: "raw", value: "12847" },
            { kind: "raw", value: "98.42" },
            { kind: "raw", value: "0" },
          ]],
          done: true,
        };
        setTimeout(() => sink.onmessage(batch), 30);
        return crypto.randomUUID() as unknown as T;
      }
      batch = /\borders\b/.test(sql)
        ? {
            columns: [
              { name: "id", type_name: "INT4", nullable: false },
              { name: "user_id", type_name: "INT4", nullable: true },
              { name: "total_cents", type_name: "INT8", nullable: false },
              { name: "placed_at", type_name: "TIMESTAMPTZ", nullable: true },
            ],
            rows: [
              [{ kind: "int", value: 1 }, { kind: "int", value: 1 }, { kind: "int", value: 1299 }, { kind: "text", value: "2026-06-12 17:50:00+00" }],
              [{ kind: "int", value: 2 }, { kind: "int", value: 1 }, { kind: "int", value: 4999 }, { kind: "text", value: "2026-06-12 18:10:22+00" }],
              [{ kind: "int", value: 3 }, { kind: "int", value: 2 }, { kind: "int", value: 799 },  { kind: "text", value: "2026-06-12 19:30:11+00" }],
            ],
            done: true,
          }
        : {
            columns: [
              { name: "id", type_name: "INT4", nullable: false },
              { name: "email", type_name: "TEXT", nullable: false },
              { name: "name", type_name: "TEXT", nullable: false },
            ],
            rows: [
              [{ kind: "int", value: 1 }, { kind: "text", value: "alice@example.com" }, { kind: "text", value: "Alice" }],
              [{ kind: "int", value: 2 }, { kind: "text", value: "bob@example.com" },   { kind: "text", value: "Bob" }],
              [{ kind: "int", value: 3 }, { kind: "text", value: "carol@example.com" }, { kind: "text", value: "Carol" }],
            ],
            done: true,
          };
      setTimeout(() => sink.onmessage(batch), 30);
      return crypto.randomUUID() as unknown as T;
    }

    case "cancel":
      return undefined as unknown as T;

    /* object_ops — mock previews mirror the Rust output verbatim so the
       dialog renders real SQL even without a Rust backend. */
    case "preview_rename_database":
      return { sql: [`ALTER DATABASE "${args.from}" RENAME TO "${args.to}";`],
        warnings: ["Postgres can't rename the DB you're connected to — this runs against a sibling DB."] } as unknown as T;
    case "preview_duplicate_database":
      return { sql: [`CREATE DATABASE "${args.dest}" WITH TEMPLATE "${args.source}" OWNER CURRENT_USER;`],
        warnings: ["Source DB must have zero active sessions while this runs."] } as unknown as T;
    case "preview_drop_database":
      return { sql: [`DROP DATABASE "${args.name}" WITH (FORCE);`],
        warnings: ["DROP … WITH (FORCE) terminates active sessions on the target DB."] } as unknown as T;
    case "preview_rename_schema":
      return { sql: [`ALTER SCHEMA "${args.from}" RENAME TO "${args.to}";`], warnings: [] } as unknown as T;
    case "preview_rename_table":
      return { sql: [`ALTER TABLE "${args.schema}"."${args.from}" RENAME TO "${args.to}";`], warnings: [] } as unknown as T;
    case "preview_move_table":
      return { sql: [`ALTER TABLE "${args.schema}"."${args.name}" SET SCHEMA "${args.targetSchema}";`], warnings: [] } as unknown as T;
    case "preview_duplicate_table": {
      const sql = args.withData
        ? [`CREATE TABLE "${args.destSchema}"."${args.dest}" AS SELECT * FROM "${args.schema}"."${args.src}";`]
        : [`CREATE TABLE "${args.destSchema}"."${args.dest}" (LIKE "${args.schema}"."${args.src}" INCLUDING ALL);`];
      const warnings = args.withData
        ? ["CREATE TABLE AS does NOT copy indexes, constraints, or defaults."]
        : [];
      return { sql, warnings } as unknown as T;
    }
    case "preview_drop_table":
      return { sql: [`DROP TABLE "${args.schema}"."${args.name}"${args.cascade ? " CASCADE" : ""};`],
        warnings: args.cascade ? ["CASCADE will drop dependent views, foreign keys, etc."] : [] } as unknown as T;
    case "apply_database_op":
    case "apply_object_op":
      return undefined as unknown as T;

    /* history + saved queries persist in localStorage so they survive reloads */
    case "query_history": {
      const all: Array<{ conn_id: string; sql: string; elapsed_ms: number; run_at: string }> =
        JSON.parse(localStorage.getItem("nembrix.mock.history") || "[]");
      const list = all
        .filter((h) => h.conn_id === (args.connId as string))
        .slice(0, (args.limit as number) ?? 200)
        .map((h) => ({ sql: h.sql, elapsed_ms: h.elapsed_ms, run_at: h.run_at }));
      return list as unknown as T;
    }
    case "list_saved_queries": {
      const all: Array<{ id: string; conn_id: string | null; name: string; sql: string; created_at: string; updated_at: string }> =
        JSON.parse(localStorage.getItem("nembrix.mock.savedQueries") || "[]");
      const id = args.connId as string | null;
      const list = id == null
        ? all
        : all.filter((s) => s.conn_id == null || s.conn_id === id);
      return list as unknown as T;
    }
    case "save_query": {
      const list: Array<{ id: string; conn_id: string | null; name: string; sql: string; created_at: string; updated_at: string }> =
        JSON.parse(localStorage.getItem("nembrix.mock.savedQueries") || "[]");
      const now = new Date().toISOString();
      const id = (args.id as string) ?? crypto.randomUUID();
      const row = {
        id,
        conn_id: (args.conn_id as string) ?? null,
        name: args.name as string,
        sql: args.sql as string,
        created_at: now,
        updated_at: now,
      };
      const existing = list.findIndex((s) => s.id === id);
      if (existing >= 0) list[existing] = { ...list[existing], ...row, updated_at: now };
      else list.unshift(row);
      localStorage.setItem("nembrix.mock.savedQueries", JSON.stringify(list));
      return row as unknown as T;
    }
    case "delete_saved_query": {
      const list: Array<{ id: string }> =
        JSON.parse(localStorage.getItem("nembrix.mock.savedQueries") || "[]");
      localStorage.setItem(
        "nembrix.mock.savedQueries",
        JSON.stringify(list.filter((s) => s.id !== (args.id as string))),
      );
      return undefined as unknown as T;
    }

    case "format_sql": {
      // Tiny formatter: uppercase keywords. Real formatter runs in Rust.
      const sql = String(args.sql || "");
      const KW = /\b(select|from|where|and|or|insert|into|values|update|set|delete|create|table|drop|alter|grant|revoke|on|to|join|left|right|inner|outer|order|by|group|having|limit|offset|as|with|returning)\b/gi;
      return sql.replace(KW, (m) => m.toUpperCase()) as unknown as T;
    }

    case "run_script": {
      // Browser-dev stand-in for the JS scripting engine (which runs in Rust
      // via rquickjs). We can't execute the script here, so return a valid,
      // empty ScriptOutcome instead of undefined — otherwise the caller does
      // `outcome.data` on undefined and throws "reading 'data'". A note in the
      // console makes it clear scripting only really runs in the Tauri app.
      return {
        data: null,
        logs: [
          {
            level: "warn",
            text: "Scripting runs in the Tauri app, not browser-dev mode. Launch the desktop app to execute scripts.",
          },
        ],
        query_count: 0,
      } as unknown as T;
    }

    case "cancel_script":
      return undefined as unknown as T;

    default:
      console.warn(`[mock] unhandled command "${cmd}"`, args);
      return undefined as unknown as T;
  }
}

/* Browser stand-in for Tauri's Channel. */
class MockChannel<T> {
  onmessage: (b: T) => void = () => {};
}

function mockSession(
  pid: number, db: string, user: string, app: string, addr: string,
  state: string, weType: string | null, we: string | null, q: string,
) {
  const now = new Date().toISOString();
  const txt = (s: string) => ({ kind: "text" as const, value: s });
  const nul = { kind: "null" as const };
  return [
    { kind: "int" as const, value: pid },
    txt(db), txt(user), txt(app), txt(addr), txt(state),
    weType ? txt(weType) : nul,
    we ? txt(we) : nul,
    txt(now), nul, txt(now), txt(now),
    txt(q),
  ];
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke: real } = await getReal();
    return real<T>(cmd, args);
  }
  // Browser dev: real Postgres via the sidecar if it's running; otherwise mock.
  // We await the probe (cached after first call) so early invocations don't
  // race past it and silently fall through to the mock backend.
  if (await probeSidecar() || sidecarAvailable()) {
    const sc = await sidecarRoute<T>(cmd, args);
    if (sc !== UNROUTED) return sc as T;
  }
  return mockInvoke<T>(cmd, args);
}

/* Sentinel so we can tell "the sidecar doesn't handle this command" from
   "the sidecar handled it and returned undefined". */
const UNROUTED = Symbol("unrouted") as unknown;

async function sidecarRoute<T>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<T | typeof UNROUTED> {
  // Look up the saved record (passwords live there in browser-dev mode).
  const lookup = (id: string) => loadMockConns().find((c) => c.id === id);

  /**
   * Re-establish the pool on the sidecar for `connId`. Used as the
   * recovery step when the sidecar reports "not connected" (which
   * happens when the sidecar process restarts mid-session — common in
   * dev when you save and the watcher reboots it).
   */
  const reconnect = async (connId: string): Promise<boolean> => {
    const rec = lookup(connId);
    if (!rec) return false;
    const password = (rec as ConnectionRecord & { password?: string | null }).password ?? null;
    try { await sidecarConnect(rec, password); return true; }
    catch { return false; }
  };

  /** Retry a query-style call once after a transparent reconnect. */
  const withRetry = async <R>(connId: string, op: () => Promise<R>): Promise<R> => {
    try { return await op(); }
    catch (e) {
      if (!String(e).match(/not connected/i)) throw e;
      const ok = await reconnect(connId);
      if (!ok) throw e;
      return await op();
    }
  };

  switch (cmd) {
    case "test_connection": {
      const input = args.input as ConnectionInput;
      const ms = await sidecarTestConnection(input);
      return ms as unknown as T;
    }
    case "connect": {
      const id = args.id as string;
      const rec = lookup(id);
      if (!rec) throw new Error(`connection ${id} not found`);
      const password = (rec as ConnectionRecord & { password?: string | null }).password ?? null;
      await sidecarConnect(rec, password);
      return undefined as unknown as T;
    }
    case "disconnect": {
      await sidecarDisconnect(args.id as string);
      return undefined as unknown as T;
    }
    case "introspect": {
      const connId = args.connId as string;
      const tree = await withRetry(connId, () => sidecarIntrospect(connId));
      return tree as unknown as T;
    }
    case "execute": {
      const connId = args.connId as string;
      const out = await withRetry(connId, () => sidecarExecute(connId, args.sql as string));
      return out as unknown as T;
    }
    case "cancel": {
      await sidecarCancel(args.connId as string, args.handle as QueryHandle);
      return undefined as unknown as T;
    }
    case "stream": {
      const connId = args.connId as string;
      const sink = args.sink as ChannelLike<RowBatch>;
      const h = await withRetry(connId, () =>
        sidecarStream(connId, args.sql as string, (b) => sink.onmessage(b)),
      );
      return h as unknown as T;
    }
    default:
      return UNROUTED as never;
  }
}

async function makeChannel<T>(): Promise<ChannelLike<T>> {
  if (!isTauri) return new MockChannel<T>();
  const { Channel } = await getReal();
  return new Channel<T>();
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Session→connection resolver. Tabs and other UI surfaces hold a *session*
 * id (which is what the rail keys against), but the Rust backend only
 * knows about connection ids. The store wires this up at startup so the
 * commands module doesn't have to import the store directly (which would
 * be a circular dep on the IPC layer).
 *
 * Falls back to the id as-given when no resolver is registered, so tests
 * and any pre-session code still work.
 */
let sessionResolver: ((id: string) => string) = (id) => id;
export function registerSessionResolver(fn: (id: string) => string): void {
  sessionResolver = fn;
}
function resolveConnId(id: string): string {
  return sessionResolver(id);
}

export const listConnections = () => invoke<ConnectionRecord[]>("list_connections");
export const saveConnection = (input: ConnectionInput) =>
  invoke<ConnectionRecord>("save_connection", { input });
export const deleteConnection = (id: string) => invoke<void>("delete_connection", { id });
// connect/disconnect operate on the saved-connection id. Callers pass a
// *session* id (that's what the UI keys on), so resolve it — otherwise
// disconnect removes the wrong key from the backend's live-connection map
// (connect inserted under the connection id) and reconnecting breaks.
export const connect = (id: string) =>
  invoke<void>("connect", { id: resolveConnId(id) });
export const disconnect = (id: string) =>
  invoke<void>("disconnect", { id: resolveConnId(id) });
export const testConnection = (input: ConnectionInput) =>
  invoke<number>("test_connection", { input });
export const trustSshHost = (host: string, fingerprint: string) =>
  invoke<void>("trust_ssh_host", { host, fingerprint });

export const execute = (connId: string, sql: string) =>
  invoke<ExecSummary>("execute", { connId: resolveConnId(connId), sql });

export const stream = async (
  connId: string,
  sql: string,
  onBatch: (b: RowBatch) => void,
): Promise<QueryHandle> => {
  const sink = await makeChannel<RowBatch>();
  sink.onmessage = onBatch;
  return invoke<QueryHandle>("stream", { connId: resolveConnId(connId), sql, sink });
};

export const cancel = (connId: string, handle: QueryHandle) =>
  invoke<void>("cancel", { connId: resolveConnId(connId), handle });

/** Run a JS scripting-mode tab. Executes `source` in the sandbox against the
 *  connection, returning grid data + captured console output. Only valid for
 *  SQL connections — the backend rejects non-SQL drivers. */
export const runScript = (connId: string, source: string) =>
  invoke<ScriptOutcome>("run_script", { connId: resolveConnId(connId), source });
export const cancelScript = (connId: string) =>
  invoke<void>("cancel_script", { connId: resolveConnId(connId) });

export const formatSql = (sql: string) =>
  invoke<string>("format_sql", { sql, cfg: null });

export const introspect = (connId: string) =>
  invoke<SchemaTree>("introspect", { connId: resolveConnId(connId) });

export const updateMenuState = (disabledIds: string[], checkedIds: string[]) =>
  invoke<void>("update_menu_state", { disabledIds, checkedIds });

/* ─────────────────── history + saved queries ─────────────────── */

import type { HistoryEntry, SavedQuery } from "./types";

export const queryHistory = (connId: string, limit = 200) =>
  invoke<HistoryEntry[]>("query_history", { connId, limit });

export const listSavedQueries = (connId: string | null) =>
  invoke<SavedQuery[]>("list_saved_queries", { connId });

export const saveSavedQuery = (input: {
  id: string | null;
  conn_id: string | null;
  name: string;
  sql: string;
}) => invoke<SavedQuery>("save_query", input);

export const deleteSavedQuery = (id: string) =>
  invoke<void>("delete_saved_query", { id });

/* ───────────────────────── object ops ───────────────────────── */

export interface OpPreviewWire {
  sql: string[];
  warnings: string[];
}

export const previewRenameDatabase = (from: string, to: string) =>
  invoke<OpPreviewWire>("preview_rename_database", { from, to });
export const previewDuplicateDatabase = (source: string, dest: string) =>
  invoke<OpPreviewWire>("preview_duplicate_database", { source, dest });
export const previewDropDatabase = (name: string) =>
  invoke<OpPreviewWire>("preview_drop_database", { name });
export const applyDatabaseOp = (connId: string, preview: OpPreviewWire, forbiddenTarget: string | null) =>
  invoke<void>("apply_database_op", { connId, preview, forbiddenTarget });

export const previewRenameSchema = (from: string, to: string) =>
  invoke<OpPreviewWire>("preview_rename_schema", { from, to });

export const previewRenameTable = (schema: string, from: string, to: string) =>
  invoke<OpPreviewWire>("preview_rename_table", { schema, from, to });
export const previewMoveTable = (schema: string, name: string, targetSchema: string) =>
  invoke<OpPreviewWire>("preview_move_table", { schema, name, targetSchema });
export const previewDuplicateTable = (
  schema: string, src: string, destSchema: string, dest: string, withData: boolean,
) =>
  invoke<OpPreviewWire>("preview_duplicate_table", { schema, src, destSchema, dest, withData });
export const previewDropTable = (schema: string, name: string, cascade: boolean) =>
  invoke<OpPreviewWire>("preview_drop_table", { schema, name, cascade });
export const applyObjectOp = (connId: string, preview: OpPreviewWire) =>
  invoke<void>("apply_object_op", { connId, preview });
