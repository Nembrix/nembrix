/**
 * Dev sidecar — exposes a tiny HTTP/SSE API the browser-mode IPC layer can
 * use to talk to a *real* Postgres without needing the Tauri/Rust app.
 *
 *   node scripts/dev-sidecar.ts        # default port 1421
 *
 * The route shape mirrors the Tauri commands so `src/ipc/commands.ts` can
 * proxy with minimal transformation:
 *
 *   GET  /healthz                       → { ok: true }
 *   POST /test-connection               → { ms } | 4xx error
 *   POST /connect       { id, ... }     → 204
 *   POST /disconnect    { id }          → 204
 *   POST /introspect    { id }          → SchemaTree
 *   POST /execute       { id, sql }     → ExecSummary
 *   POST /stream        { id, sql }     → text/event-stream of RowBatch
 *   POST /cancel        { id, handle }  → 204
 *
 * Lives in /scripts (not /src) so it's never bundled into the frontend.
 * No production concerns — dev tool only.
 */

import express, { Request, Response } from "express";
import { Client, Pool, PoolClient, QueryResultRow, types as pgTypes } from "pg";
import { randomUUID } from "node:crypto";

/* ───────────────────────── types mirrored from Rust ───────────────────────── */
type CellValue =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "text"; value: string }
  | { kind: "raw"; value: string }
  | { kind: "document"; value: unknown }
  | { kind: "bytes"; value: number[] };

interface ColMeta { name: string; type_name: string; nullable: boolean }
interface RowBatch { columns: ColMeta[] | null; rows: CellValue[][]; done: boolean }

interface LiveConn {
  pool: Pool;
  /** running queries → { client, cancellable: backend pid } */
  running: Map<string, { client: PoolClient; pid: number | null }>;
}

/** Extract a string message from an unknown thrown value. */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

const conns = new Map<string, LiveConn>();
const PORT = parseInt(process.env.DBCLIENT_SIDECAR_PORT ?? "1421");

const STRING_TYPES = new Set([
  "text", "varchar", "bpchar", "name", "char", "citext",
]);
const INT_TYPES = new Set(["int2", "int4", "int8", "smallint", "integer", "bigint"]);
const FLOAT_TYPES = new Set(["float4", "float8", "real", "double precision"]);

/* Postgres returns bytea as Buffer; convert to byte array for the wire format. */
pgTypes.setTypeParser(17, (val) => (val == null ? null : Buffer.from(val.slice(2), "hex")));

function cellFromRaw(raw: unknown, typeName: string): CellValue {
  if (raw === null || raw === undefined) return { kind: "null" };
  if (typeof raw === "boolean") return { kind: "bool", value: raw };
  if (typeof raw === "number") {
    return Number.isInteger(raw) && INT_TYPES.has(typeName.toLowerCase())
      ? { kind: "int", value: raw }
      : { kind: "float", value: raw };
  }
  if (typeof raw === "bigint") return { kind: "int", value: Number(raw) };
  if (Buffer.isBuffer(raw)) return { kind: "bytes", value: Array.from(raw) };
  if (typeof raw === "object") return { kind: "document", value: raw };
  const s = String(raw);
  const t = typeName.toLowerCase();
  if (STRING_TYPES.has(t)) return { kind: "text", value: s };
  if (INT_TYPES.has(t)) return { kind: "int", value: Number(s) };
  if (FLOAT_TYPES.has(t)) return { kind: "float", value: Number(s) };
  // Numerics, dates, intervals — preserve original text losslessly.
  return { kind: "raw", value: s };
}

/* Map Postgres type OID → name via pg's built-in registry; fall back to "?". */
async function typeNamesForRow(client: PoolClient, dataTypeIDs: number[]) {
  // pg's `pg_type` lookup is fast and cached server-side after first call.
  if (!dataTypeIDs.length) return [] as string[];
  const { rows } = await client.query<{ oid: number; typname: string }>(
    "SELECT oid::int4, typname FROM pg_type WHERE oid = ANY($1)",
    [dataTypeIDs],
  );
  const m = new Map(rows.map((r) => [r.oid, r.typname]));
  return dataTypeIDs.map((id) => m.get(id) ?? "unknown");
}

/* ───────────────────────── introspection ───────────────────────── */

async function introspect(pool: Pool) {
  const client = await pool.connect();
  try {
    const dbName = (await client.query("SELECT current_database() AS name")).rows[0].name;

    const schemas = (await client.query(
      `SELECT n.nspname AS name FROM pg_namespace n
       WHERE n.nspname NOT LIKE 'pg_temp_%'
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname <> 'information_schema'
       ORDER BY (n.nspname = 'public') DESC, n.nspname`,
    )).rows;

    const rels = (await client.query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m')
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND n.nspname <> 'information_schema'
       ORDER BY n.nspname, c.relname`,
    )).rows;

    const cols = (await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable,
              column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT LIKE 'pg_%'
         AND table_schema <> 'information_schema'
       ORDER BY table_schema, table_name, ordinal_position`,
    )).rows;

    const pks = (await client.query(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
        AND kcu.table_name = tc.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
       ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
    )).rows;

    const fks = (await client.query(
      `WITH fks AS (
         SELECT c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey,
                ns.nspname AS schema, cl.relname AS table_name,
                rns.nspname AS ref_schema, rcl.relname AS ref_table
         FROM pg_constraint c
         JOIN pg_class      cl  ON cl.oid  = c.conrelid
         JOIN pg_namespace  ns  ON ns.oid  = cl.relnamespace
         JOIN pg_class      rcl ON rcl.oid = c.confrelid
         JOIN pg_namespace  rns ON rns.oid = rcl.relnamespace
         WHERE c.contype = 'f'
           AND ns.nspname NOT LIKE 'pg_%'
           AND ns.nspname <> 'information_schema')
       SELECT fks.conname AS name, fks.schema, fks.table_name,
              fks.ref_schema, fks.ref_table,
              (SELECT array_agg(a.attname ORDER BY ord)
                 FROM unnest(fks.conkey)  WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = fks.conrelid AND a.attnum = u.attnum)
                AS columns,
              (SELECT array_agg(a.attname ORDER BY ord)
                 FROM unnest(fks.confkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = fks.confrelid AND a.attnum = u.attnum)
                AS ref_columns
       FROM fks ORDER BY fks.schema, fks.table_name, fks.conname`,
    )).rows;

    const idxs = (await client.query(
      `SELECT n.nspname AS schema, t.relname AS table_name, i.relname AS name,
              ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              am.amname AS method, pg_get_indexdef(ix.indexrelid) AS definition,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns
       FROM pg_index ix
       JOIN pg_class t      ON t.oid = ix.indrelid
       JOIN pg_class i      ON i.oid = ix.indexrelid
       JOIN pg_namespace n  ON n.oid = t.relnamespace
       JOIN pg_am am        ON am.oid = i.relam
       WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
       ORDER BY n.nspname, t.relname, i.relname`,
    )).rows;

    // Only surface USER-DEFINED functions, not the thousands of built-ins
    // and extension-supplied routines:
    //   - prokind = 'f' filters to plain functions (drops aggregates,
    //     window fns, and procedures — those can be added later under
    //     separate folders if useful).
    //   - The pg_depend NOT EXISTS clause excludes anything owned by an
    //     extension (deptype = 'e'), e.g. postgis, pgcrypto, hstore.
    //     Built-ins also have system dependencies; combined with the
    //     namespace filter below, only what the user (or their app) ran
    //     CREATE FUNCTION on remains.
    const funcs = (await client.query(
      `SELECT n.nspname AS schema, p.proname AS name,
              pg_get_function_result(p.oid) AS return_type,
              pg_get_function_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT LIKE 'pg_%'
         AND n.nspname <> 'information_schema'
         AND p.prokind = 'f'
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
            WHERE d.objid = p.oid AND d.deptype = 'e'
         )
       ORDER BY n.nspname, p.proname`,
    )).rows;

    /* Index everything by (schema, table). */
    const key = (sc: string, t: string) => `${sc}.${t}`;
    const colMap = new Map<string, Record<string, unknown>[]>();
    for (const r of cols) {
      const k = key(r.table_schema, r.table_name);
      (colMap.get(k) ?? colMap.set(k, []).get(k)!).push({
        name: r.column_name,
        type_name: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
      });
    }
    const pkMap = new Map<string, string[]>();
    for (const r of pks) {
      const k = key(r.table_schema, r.table_name);
      (pkMap.get(k) ?? pkMap.set(k, []).get(k)!).push(r.column_name);
    }
    const fkMap = new Map<string, Record<string, unknown>[]>();
    for (const r of fks) {
      const k = key(r.schema, r.table_name);
      (fkMap.get(k) ?? fkMap.set(k, []).get(k)!).push({
        name: r.name,
        columns: r.columns ?? [],
        referenced_schema: r.ref_schema,
        referenced_table: r.ref_table,
        referenced_columns: r.ref_columns ?? [],
      });
    }
    const idxMap = new Map<string, Record<string, unknown>[]>();
    for (const r of idxs) {
      const k = key(r.schema, r.table_name);
      (idxMap.get(k) ?? idxMap.set(k, []).get(k)!).push({
        name: r.name,
        columns: r.columns ?? [],
        is_unique: r.is_unique,
        is_primary: r.is_primary,
        method: r.method,
        definition: r.definition,
      });
    }
    const funcMap = new Map<string, Record<string, unknown>[]>();
    for (const r of funcs) {
      (funcMap.get(r.schema) ?? funcMap.set(r.schema, []).get(r.schema)!).push({
        name: r.name,
        return_type: r.return_type ?? "",
        argument_types: (r.args ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      });
    }

    const schemaNodes = schemas.map((s: { name: string }) => {
      const tables: Record<string, unknown>[] = [];
      const views: Record<string, unknown>[] = [];
      for (const r of rels) {
        if (r.schema !== s.name) continue;
        const node = {
          name: r.name,
          columns: colMap.get(key(s.name, r.name)) ?? [],
          primary_key: pkMap.get(key(s.name, r.name)) ?? [],
          foreign_keys: fkMap.get(key(s.name, r.name)) ?? [],
          indexes: idxMap.get(key(s.name, r.name)) ?? [],
        };
        if (r.kind === "r") tables.push(node);
        else views.push(node);
      }
      return {
        name: s.name,
        tables,
        views,
        functions: funcMap.get(s.name) ?? [],
      };
    });

    return { databases: [{ name: dbName, schemas: schemaNodes }] };
  } finally {
    client.release();
  }
}

/* ───────────────────────── HTTP server ───────────────────────── */

const app = express();
app.use(express.json({ limit: "1mb" }));

/* Open CORS for the Vite dev origin. */
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
// Express 5 / path-to-regexp 8 requires a named splat; bare "*" throws.
app.options("/*splat", (_req, res) => res.sendStatus(204));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

interface ConnectBody {
  id: string;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  database?: string | null;
  sslMode?: "disable" | "prefer" | "require";
}

function poolConfig(b: ConnectBody) {
  return {
    host: b.host,
    port: b.port,
    user: b.user,
    password: b.password ?? undefined,
    database: b.database ?? undefined,
    ssl: b.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
    application_name: "nembrix-sidecar",
    max: 8,
  };
}

app.post("/test-connection", async (req: Request, res: Response) => {
  const body = req.body as ConnectBody;
  const t0 = Date.now();
  const c = new Client(poolConfig(body));
  try {
    await c.connect();
    await c.query("SELECT 1");
    res.json({ ms: Date.now() - t0 });
  } catch (e: unknown) {
    res.status(400).json({ error: errMessage(e) });
  } finally {
    await c.end().catch(() => {});
  }
});

app.post("/connect", async (req: Request, res: Response) => {
  const body = req.body as ConnectBody;
  try {
    if (conns.has(body.id)) await conns.get(body.id)!.pool.end().catch(() => {});
    const pool = new Pool(poolConfig(body));
    // Eagerly validate by pinging once so the user sees errors immediately.
    const c = await pool.connect();
    await c.query("SELECT 1");
    c.release();
    conns.set(body.id, { pool, running: new Map() });
    res.sendStatus(204);
  } catch (e: unknown) {
    res.status(400).json({ error: errMessage(e) });
  }
});

app.post("/disconnect", async (req: Request, res: Response) => {
  const { id } = req.body as { id: string };
  const live = conns.get(id);
  if (live) {
    await live.pool.end().catch(() => {});
    conns.delete(id);
  }
  res.sendStatus(204);
});

app.post("/introspect", async (req: Request, res: Response) => {
  const { id } = req.body as { id: string };
  const live = conns.get(id);
  if (!live) return res.status(400).json({ error: "not connected" });
  try {
    res.json(await introspect(live.pool));
  } catch (e: unknown) {
    res.status(500).json({ error: errMessage(e) });
  }
});

app.post("/execute", async (req: Request, res: Response) => {
  const { id, sql } = req.body as { id: string; sql: string };
  const live = conns.get(id);
  if (!live) return res.status(400).json({ error: "not connected" });
  const t0 = Date.now();
  try {
    const out = await live.pool.query(sql);
    res.json({
      rows_affected: out.rowCount ?? 0,
      last_insert_id: null,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e: unknown) {
    res.status(400).json({ error: errMessage(e) });
  }
});

app.post("/stream", async (req: Request, res: Response) => {
  const { id, sql } = req.body as { id: string; sql: string };
  const live = conns.get(id);
  if (!live) {
    console.warn(`[sidecar] /stream: no live connection for id=${id} (known: ${[...conns.keys()].join(", ") || "none"})`);
    res.status(400).json({ error: "not connected" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const handle = randomUUID();
  let client: PoolClient | null = null;
  let pid: number | null;
  try {
    client = await live.pool.connect();
    try {
      const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pid = r.rows[0].pid;
      live.running.set(handle, { client, pid });
      send("handle", handle);
    } catch { /* non-fatal */ }

    const result = await client.query(sql);
    const fields = result.fields ?? [];
    const typeNames = await typeNamesForRow(client, fields.map((f) => f.dataTypeID));
    const columns: ColMeta[] = fields.map((f, i) => ({
      name: f.name,
      type_name: typeNames[i],
      nullable: true,
    }));
    const rows: CellValue[][] = (result.rows as QueryResultRow[]).map((r) =>
      fields.map((f, i) => cellFromRaw(r[f.name], typeNames[i])),
    );
    const batch: RowBatch = { columns, rows, done: true };
    send("batch", batch);
    res.end();
  } catch (e: unknown) {
    const msg = errMessage(e);
    console.error(`[sidecar] /stream error:`, msg);
    send("batch", { columns: null, rows: [[{ kind: "text", value: msg }]], done: true });
    res.end();
  } finally {
    live.running.delete(handle);
    if (client) client.release();
  }
});

app.post("/cancel", async (req: Request, res: Response) => {
  const { id, handle } = req.body as { id: string; handle: string };
  const live = conns.get(id);
  const running = live?.running.get(handle);
  if (!live || !running || running.pid == null) {
    res.sendStatus(204);
    return;
  }
  try {
    const c = await live.pool.connect();
    try { await c.query("SELECT pg_cancel_backend($1)", [running.pid]); }
    finally { c.release(); }
  } catch { /* best-effort */ }
  res.sendStatus(204);
});

app.listen(PORT, () => {
  console.log(`[nembrix sidecar] listening on http://localhost:${PORT}`);
  console.log("[nembrix sidecar] the browser dev mode will use this for real Postgres connections");
});

process.on("SIGINT", async () => {
  console.log("\n[nembrix sidecar] shutting down");
  for (const live of conns.values()) await live.pool.end().catch(() => {});
  process.exit(0);
});
