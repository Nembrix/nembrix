/**
 * Testcontainer Postgres lifecycle for docs media capture.
 *
 * Pinned to postgres:16-alpine so screenshots match what the Rust
 * integration tests in crates/db-postgres see. If you bump the image,
 * update docker/docker-compose.yml at the same time.
 *
 * Note: the Rust tests use `testcontainers_modules::postgres::Postgres`
 * which pins its own default image; this side and that side are
 * separate language ecosystems, so we keep them lockstep by convention
 * — the comment above and the docker-compose pin are the truth.
 */

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_SQL = join(__dirname, "seed.sql");

/**
 * On macOS, Docker Desktop / OrbStack / Colima all use non-default
 * socket paths. testcontainers-node defaults to `/var/run/docker.sock`
 * which doesn't exist there. We probe the active docker context and
 * set DOCKER_HOST programmatically before the testcontainers client
 * gets initialized, so the common case Just Works.
 */
/**
 * Tiny retry helper for the Postgres container start. Logs each attempt
 * to stderr so the dev can see what's happening — silently retrying
 * would look like a stuck script.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseDelayMs: number },
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= opts.attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (i < opts.attempts) {
        const delay = opts.baseDelayMs * i;
        console.error(`[db] attempt ${i}/${opts.attempts} failed: ${msg}. retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(`[db] all ${opts.attempts} attempts failed.`);
      }
    }
  }
  throw lastErr;
}

function autoConfigureDockerHost(): void {
  if (process.env.DOCKER_HOST) return; // respect explicit override
  try {
    const out = execSync("docker context inspect", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // `docker context inspect` returns a JSON array; the active context's
    // host lives at .Endpoints.docker.Host.
    const ctx = JSON.parse(out);
    const host = ctx?.[0]?.Endpoints?.docker?.Host;
    if (typeof host === "string" && host.length > 0) {
      process.env.DOCKER_HOST = host;
    }
  } catch {
    // No docker CLI / not running / not in PATH — testcontainers will
    // surface its own error, no need to double-fail here.
  }
}

export interface DbHandle {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Tear down the container. Idempotent. */
  stop: () => Promise<void>;
}

const POSTGRES_IMAGE = "postgres:16-alpine";

/**
 * Spin up Postgres, wait for ready, apply seed.sql, return host:port.
 * Caller MUST call stop() when done — the container won't reap itself.
 */
export async function startSeededPostgres(): Promise<DbHandle> {
  autoConfigureDockerHost();
  // Docker Desktop's API occasionally returns HTTP 500 on cold-start
  // even when the daemon is healthy — usually after the laptop wakes,
  // or when a previous container teardown left containerd in a sulky
  // state. Retry a couple of times with backoff before giving up.
  const container: StartedTestContainer = await withRetry(
    () => new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_USER: "docs",
        POSTGRES_PASSWORD: "docs",
        POSTGRES_DB: "shop",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      )
      .start(),
    { attempts: 3, baseDelayMs: 1500 },
  );

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  // Apply seed via a one-shot Client (rather than the pool the sidecar
  // will use), so we know the schema is in place before scenes start.
  const seed = readFileSync(SEED_SQL, "utf8");
  const client = new Client({ host, port, user: "docs", password: "docs", database: "shop" });
  await client.connect();
  try {
    await client.query(seed);
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }

  return {
    host,
    port,
    user: "docs",
    password: "docs",
    database: "shop",
    stop: async () => { await container.stop(); },
  };
}
