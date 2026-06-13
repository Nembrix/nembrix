/**
 * Sidecar client tests. We stub `fetch` so the unit test never touches the
 * network — the goal is to verify (a) the probe correctly toggles
 * `sidecarAvailable`, (b) the SSE stream parser assembles batches from
 * fragmented frames, (c) error responses surface as Error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-import per test so the module-level cache resets.
async function freshImport() {
  vi.resetModules();
  return await import("./sidecar");
}

const okHealth = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("probeSidecar", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("returns true and toggles sidecarAvailable when /healthz responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okHealth()));
    const mod = await freshImport();
    expect(mod.sidecarAvailable()).toBe(false);
    expect(await mod.probeSidecar()).toBe(true);
    expect(mod.sidecarAvailable()).toBe(true);
  });

  it("returns false when fetch throws (sidecar not running)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const mod = await freshImport();
    expect(await mod.probeSidecar()).toBe(false);
    expect(mod.sidecarAvailable()).toBe(false);
  });
});

describe("sidecarTestConnection", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("returns the ms field on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ms: 42 }), { status: 200 }),
    ));
    const mod = await freshImport();
    const ms = await mod.sidecarTestConnection({
      id: null, name: "x", engine: "postgres",
      host: "h", port: 5432, username: "u",
      password: null, database: null, ssl_mode: "prefer",
      ssh: null, color: null,
    });
    expect(ms).toBe(42);
  });

  it("throws with the server's error body on 4xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "auth failed" }), { status: 400 }),
    ));
    const mod = await freshImport();
    await expect(mod.sidecarTestConnection({
      id: null, name: "x", engine: "postgres",
      host: "h", port: 5432, username: "u",
      password: null, database: null, ssl_mode: "prefer",
      ssh: null, color: null,
    })).rejects.toThrow(/auth failed/);
  });
});

describe("sidecarStream SSE parsing", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("dispatches the handle event and the batch event correctly", async () => {
    // Build a single SSE response body with two events split across chunks
    // so we exercise the buffer-assembly loop.
    const handle = "00000000-0000-0000-0000-000000000001";
    const batch = {
      columns: [{ name: "id", type_name: "int4", nullable: false }],
      rows: [[{ kind: "int", value: 1 }]],
      done: true,
    };
    const frame1 = `event: handle\ndata: ${JSON.stringify(handle)}\n\n`;
    const frame2 = `event: batch\ndata: ${JSON.stringify(batch)}\n\n`;
    // Split frame2 mid-data to test the assembly.
    const half = Math.floor(frame2.length / 2);
    const chunks = [frame1, frame2.slice(0, half), frame2.slice(half)];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ));

    const mod = await freshImport();
    const batches: unknown[] = [];
    const h = await mod.sidecarStream("conn-1", "SELECT 1", (b) => batches.push(b));
    // The handle resolves as soon as the first event arrives.
    expect(h).toBe(handle);
    // Give the background reader a tick to finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(batches).toHaveLength(1);
    expect((batches[0] as { rows: unknown[][] }).rows[0][0]).toEqual({ kind: "int", value: 1 });
  });
});
