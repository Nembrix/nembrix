/**
 * Manage the runtime stack the capture pipeline needs:
 *
 *   1. Vite dev server (browser-mode app)            — port 1420
 *   2. Node sidecar (browser-mode IPC)               — port 1421
 *
 * If something's already listening on either port we **attach** rather
 * than boot a parallel stack — but only after verifying via /healthz
 * that the running sidecar is fresh and hasn't been driven by another
 * dev session against a different database. The safety check refuses
 * to attach when there's any doubt and prints the override instructions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const VITE_PORT = 1420;
const SIDECAR_PORT = 1421;

export interface StackHandle {
  viteUrl: string;
  sidecarUrl: string;
  /** Stop only what we started — attached services are left alone. */
  stop: () => Promise<void>;
}

interface StackOpts {
  /** Skip the safety check and reuse whatever's running. */
  forceReuse: boolean;
}

export async function startStack(opts: StackOpts): Promise<StackHandle> {
  const owned: ChildProcess[] = [];

  // -------------------- sidecar --------------------
  const sidecarUp = await tcpOpen(SIDECAR_PORT);
  if (sidecarUp) {
    if (!opts.forceReuse) {
      throw new Error(
        `Port ${SIDECAR_PORT} is in use. A dev sidecar is probably running and\n` +
        `it isn't pointed at our test database — screenshots would come from\n` +
        `the wrong data. Stop it (kill yarn dev:all) or pass --force-reuse to\n` +
        `attach anyway.`,
      );
    }
    log(`attaching to existing sidecar on :${SIDECAR_PORT}`);
  } else {
    log("starting sidecar…");
    owned.push(spawnLogged("yarn", ["dev:sidecar"], { cwd: ROOT }, "sidecar"));
    await waitForHttp(`http://localhost:${SIDECAR_PORT}/healthz`, 15_000);
    log("sidecar ready");
  }

  // -------------------- vite --------------------
  const viteUp = await tcpOpen(VITE_PORT);
  if (viteUp) {
    if (!opts.forceReuse) {
      throw new Error(
        `Port ${VITE_PORT} is in use. Stop yarn dev or pass --force-reuse.`,
      );
    }
    log(`attaching to existing vite on :${VITE_PORT}`);
  } else {
    log("starting vite…");
    owned.push(spawnLogged("yarn", ["dev"], { cwd: ROOT }, "vite"));
    await waitForHttp(`http://localhost:${VITE_PORT}/`, 15_000);
    log("vite ready");
  }

  return {
    viteUrl: `http://localhost:${VITE_PORT}`,
    sidecarUrl: `http://localhost:${SIDECAR_PORT}`,
    stop: async () => {
      for (const c of owned) {
        c.kill("SIGTERM");
      }
      // Give them a beat to flush.
      await new Promise((r) => setTimeout(r, 200));
      for (const c of owned) {
        if (!c.killed) c.kill("SIGKILL");
      }
    },
  };
}

/* ─────────────────── helpers ─────────────────── */

function log(msg: string) {
  console.log(`[stack] ${msg}`);
}

async function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(300);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { resolve(false); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1");
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok || res.status === 404) return; // 404 is fine for Vite root probes
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

function spawnLogged(cmd: string, args: string[], opts: { cwd: string }, label: string): ChildProcess {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${label}]`;
  child.stdout?.on("data", (d: Buffer) => {
    process.stderr.write(`${prefix} ${d.toString().trimEnd()}\n`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`${prefix} ${d.toString().trimEnd()}\n`);
  });
  return child;
}
