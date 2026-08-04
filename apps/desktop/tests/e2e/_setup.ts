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
  const connId = opts.connId ?? "00000000-0000-0000-0000-000000000333";
  const name = opts.name ?? "Demo";
  const database = opts.database ?? "d";
  const connect = opts.connect ?? true;
  const sessionId = "00000000-0000-0000-0000-000000000444";

  await page.goto("/");
  await page.evaluate(
    ({ connId, name, database, sessionId }) => {
      localStorage.clear();
      const now = new Date().toISOString();
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
  await page.reload();
  // `reload()` resolves on the load event — BEFORE React mounts and renders
  // the rail. Clicking `.rail-avatar` immediately races the mount and
  // intermittently times out ("element not found"), which then cascades
  // into "the grid never rendered" failures downstream. Wait for the
  // avatar to actually be present first. (seedEmpty has the same guard.)
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
