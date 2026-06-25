/**
 * Dev sidecar client.
 *
 * When `npm run dev:sidecar` (or `npm run dev:all`) is running, the
 * browser-mode IPC layer routes real Postgres commands here instead of
 * returning canned mock data. The sidecar exposes the same shape of
 * commands the Tauri side does, so callers can treat it as a third
 * backend behind the same `invoke()` facade.
 *
 * Probe is a single GET /healthz at module load. If it fails, we stay
 * in mock-only mode for the rest of the session — the user can refresh
 * after starting the sidecar to pick it up.
 */

import type {
  ConnectionInput,
  ConnectionRecord,
  ExecSummary,
  QueryHandle,
  RowBatch,
  SchemaTree,
} from "./types";

const SIDECAR_URL = (() => {
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_SIDECAR_URL;
  return fromEnv || "http://localhost:1421";
})();

let available = false;
let inflight: Promise<boolean> | null = null;

export function sidecarAvailable(): boolean {
  return available;
}

/**
 * Probe the sidecar's /healthz. Caches the in-flight promise so concurrent
 * callers share one network round-trip. Once the probe SUCCEEDS we stop
 * probing — but we DO retry after a failed probe so the user can start the
 * sidecar after the page has already loaded without needing a reload.
 */
export async function probeSidecar(): Promise<boolean> {
  if (available) return true;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${SIDECAR_URL}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      available = res.ok;
    } catch {
      available = false;
    }
    if (available) console.info(`[sidecar] connected to ${SIDECAR_URL} — real Postgres available`);
    inflight = null;
    return available;
  })();
  return inflight;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error ?? ""; } catch { /* ignore: best-effort */ }
    throw new Error(detail || `${path}: HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

/* ───────────────────────── helpers ───────────────────────── */

function connectBody(rec: ConnectionRecord & { password?: string | null }, password: string | null) {
  return {
    id: rec.id,
    host: rec.host,
    port: rec.port,
    user: rec.username,
    password,
    database: rec.database,
    sslMode: rec.ssl_mode,
  };
}

/* ───────────────────────── command handlers ───────────────────────── */

export async function sidecarTestConnection(input: ConnectionInput): Promise<number> {
  const { ms } = await post<{ ms: number }>("/test-connection", {
    id: "test",
    host: input.host,
    port: input.port,
    user: input.username,
    password: input.password,
    database: input.database,
    sslMode: input.ssl_mode,
  });
  return ms;
}

export async function sidecarConnect(rec: ConnectionRecord, password: string | null): Promise<void> {
  await post<void>("/connect", connectBody(rec, password));
}

export async function sidecarDisconnect(id: string): Promise<void> {
  await post<void>("/disconnect", { id });
}

export async function sidecarIntrospect(id: string): Promise<SchemaTree> {
  return await post<SchemaTree>("/introspect", { id });
}

export async function sidecarExecute(id: string, sql: string): Promise<ExecSummary> {
  return await post<ExecSummary>("/execute", { id, sql });
}

export async function sidecarCancel(id: string, handle: QueryHandle): Promise<void> {
  await post<void>("/cancel", { id, handle });
}

/**
 * Stream a query via Server-Sent Events. We POST to /stream and let fetch
 * give us a streaming Response; chunks come back as `event:` / `data:` lines.
 * Returns the QueryHandle the sidecar minted (so cancel works).
 */
export async function sidecarStream(
  id: string,
  sql: string,
  onBatch: (b: RowBatch) => void,
): Promise<QueryHandle> {
  const res = await fetch(`${SIDECAR_URL}/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, sql }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error ?? ""; } catch { /* ignore: best-effort */ }
    throw new Error(detail || `/stream: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("/stream: no body");

  let handle: QueryHandle = "" as QueryHandle;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // SSE parse loop — assemble events from CRLF-separated frames.
  // Runs in the background; we resolve the promise as soon as we see
  // the `handle` event so the caller gets the QueryHandle promptly.
  let resolveHandle: (h: QueryHandle) => void = () => {};
  const handlePromise = new Promise<QueryHandle>((r) => { resolveHandle = r; });

  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "handle") {
          handle = JSON.parse(data);
          resolveHandle(handle);
        } else if (event === "batch") {
          try {
            onBatch(JSON.parse(data) as RowBatch);
          } catch (err) {
            console.error("[sidecar] failed to parse batch data:", err, data.slice(0, 200));
          }
        }
      }
    }
    // If the stream finished without ever emitting a `handle` event,
    // resolve with empty so the caller isn't stuck.
    resolveHandle(handle);
  })().catch((e) => console.warn("[sidecar] stream error:", e));

  return await handlePromise;
}
