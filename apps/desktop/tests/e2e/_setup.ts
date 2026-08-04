import { expect, type Page } from "@playwright/test";

/**
 * Seed a saved connection AND an open session, then reload so the app
 * hydrates both from localStorage. The connection rail renders *sessions*
 * (not bare saved connections), so seeding only `nembrix.mock.connections`
 * leaves the rail in its "No live sessions" empty state and `.rail-avatar`
 * never appears. We seed `nembrix.tabs.v1` (the persisted-session key) too.
 *
 * After hydration this clicks the rail avatar and the connect button so the
 * session is live and introspected — the state most specs assume in their
 * `beforeEach`.
 */
export async function seedConnectedSession(
  page: Page,
  opts: { connId?: string; name?: string; database?: string; connect?: boolean } = {},
) {
  const connId = opts.connId ?? crypto.randomUUID();
  const name = opts.name ?? "Demo";
  const database = opts.database ?? "d";
  const connect = opts.connect ?? true;
  // Unique per call so leaked store/localStorage state from a prior test in
  // the same worker can't collide (the old fixed 333/444 ids meant a stale
  // session with the same id could linger and break the next test's grid).
  const sessionId = crypto.randomUUID();

  // Seed localStorage BEFORE the app ever loads, via an init script that
  // runs on every navigation in this page. This is hermetic: the very first
  // render already sees the seeded session, with no goto→clear→reload race
  // (the old approach loaded the app once with empty storage, then seeded +
  // reloaded, which was order-dependent and flaked when run in isolation).
  await page.addInitScript(
    ({ connId, name, database, sessionId }) => {
      // Seed ONCE, on the first load. This init script runs on every
      // navigation (incl. a test's own page.reload()), so guard on a
      // sentinel — otherwise we'd wipe state a test deliberately reloads to
      // verify persistence (e.g. column-resize reloads to check the width
      // survived). The clear only happens on that first seed.
      if (localStorage.getItem("__seeded__")) return;
      localStorage.clear();
      localStorage.setItem("__seeded__", "1");
      const now = new Date(0).toISOString(); // fixed — Date.now varies per run
      const rec = {
        id: connId,
        name,
        engine: "postgres",
        host: "h",
        port: 5432,
        username: "u",
        database,
        ssl_mode: "prefer",
        ssh: null,
        color: null,
        created_at: now,
        updated_at: now,
      };
      localStorage.setItem("nembrix.mock.connections", JSON.stringify([rec]));
      localStorage.setItem(
        "nembrix.tabs.v1",
        JSON.stringify({
          tabs: [],
          activeTabId: null,
          selectedConnId: sessionId,
          sessions: [{ id: sessionId, connectionId: connId, openedAt: now }],
        }),
      );
    },
    { connId, name, database, sessionId },
  );
  await page.goto("/");
  // The rail renders the session's avatar once React mounts. With the seed
  // present from first load (above) it always appears; wait for it before
  // interacting.
  const avatar = page.locator(".rail-avatar").first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  if (connect) {
    const connectBtn = page.locator("[data-testid='connect-btn']");
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();
    // Wait for the session to actually reach "connected" — the connect +
    // introspect round-trip is async, and tests that immediately click a
    // table need the schema loaded first. Without this the table click
    // (and the grid that follows) races the introspect and intermittently
    // finds an empty schema → "grid never rendered". The connect button
    // carries the live status in data-state.
    await expect(connectBtn).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
  }
}

/**
 * Open a table's data view from the empty-tab landing card and wait for the
 * grid to actually render. Waits for the card to be present before clicking
 * (the click was racing the card's render) and gives the grid generous time
 * to stream its first batch under load. Use this instead of clicking
 * `.empty-tab-card` directly so the open-a-table flow is consistent + robust.
 */
export async function openTable(page: Page, name: string) {
  const card = page.locator(".empty-tab-card", { hasText: name });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.locator(".grid-scroll table.grid-header")).toBeVisible({ timeout: 15_000 });
}

/** Start with a clean slate — no connections, no sessions. */
export async function seedEmpty(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // `reload()` resolves on the load event, before React has mounted the app
  // shell and registered the menu accelerators. Wait for the menu bar so tests
  // that fire keyboard shortcuts (e.g. ⌘N) don't race the listener attaching.
  await expect(page.locator(".menu-bar-item").first()).toBeVisible();
}

export { expect };
