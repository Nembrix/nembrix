/**
 * localStorage state injected into the app before each scene so scenes
 * start "already connected" without having to drive the connection form.
 *
 * We shape the payload to match exactly what the app's mock backend
 * writes (so the rail / inspector / connection manager all read it
 * naturally). The two keys we control:
 *
 *   - `nembrix.mock.connections` — array of ConnectionRecord-ish objects
 *     including a `password` field (mock-mode keeps secrets in
 *     localStorage; production Tauri uses the keychain).
 *   - `nembrix.tabs.v1` — persisted sessions + tabs + activeTabId.
 *
 * Keep this file in sync with `src/ipc/commands.ts:LS_KEY` and
 * `src/store/persist.ts:KEY` — if either changes, scenes break silently.
 */

import type { DbHandle } from "./db";

/** Deterministic IDs so screenshots stay reproducible across runs. */
export const SEED_CONN_ID = "00000000-0000-0000-0000-00000000c001";
export const SEED_SESSION_ID = "00000000-0000-0000-0000-00000000a001";

const CONN_LS_KEY = "nembrix.mock.connections";
const TABS_LS_KEY = "nembrix.tabs.v1";
const RECENT_LS_KEY = "nembrix.recent.connections.v1";

interface InjectOptions {
  /** Save a connection record but DON'T open a session — useful for
   *  scenes that want to demo the "have connections, none open" state
   *  (e.g. the recents landing page). */
  connectionOnly?: boolean;
}

/**
 * Build the JavaScript snippet that Playwright will inject as the page's
 * init script (runs before any app code on every navigation). Idempotent.
 */
export function seedScript(db: DbHandle, opts: InjectOptions = {}): string {
  const now = new Date().toISOString();
  const connection = {
    id: SEED_CONN_ID,
    name: "Shop (local)",
    engine: "postgres",
    host: db.host,
    port: db.port,
    username: db.user,
    database: db.database,
    ssl_mode: "disable",
    ssh: null,
    color: "#22c55e",
    environment: "development",
    group: "Local dev",
    created_at: now,
    updated_at: now,
    password: db.password,        // mock-mode keychain substitute
    sshPassword: null,
    sshKeyPassphrase: null,
  };

  const tabsPayload = opts.connectionOnly
    ? { tabs: [], activeTabId: null, selectedConnId: null, sessions: [] }
    : {
        tabs: [],
        activeTabId: null,
        selectedConnId: SEED_SESSION_ID,
        sessions: [{
          id: SEED_SESSION_ID,
          connectionId: SEED_CONN_ID,
          openedAt: now,
        }],
      };

  // The snippet runs before any app code. We can't use `await` here
  // (it's a synchronous init script) — the app will pick up our values
  // when it reads localStorage during boot.
  // Always seed the recents list with the connection id, so the empty
  // landing page renders its "recent connections" card stack instead
  // of the "No recent connections yet" empty state. Order matters —
  // most-recent first.
  const recentPayload = [SEED_CONN_ID];

  return `
    try {
      localStorage.setItem(${JSON.stringify(CONN_LS_KEY)}, ${JSON.stringify(JSON.stringify([connection]))});
      localStorage.setItem(${JSON.stringify(TABS_LS_KEY)}, ${JSON.stringify(JSON.stringify(tabsPayload))});
      localStorage.setItem(${JSON.stringify(RECENT_LS_KEY)}, ${JSON.stringify(JSON.stringify(recentPayload))});
    } catch (e) {
      console.warn("[docs-seed] localStorage write failed:", e);
    }
  `;
}
