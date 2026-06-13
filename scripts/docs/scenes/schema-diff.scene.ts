import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "schema-diff",
  description: "Schema diff tab comparing public against a second schema with intentional drift.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Create a "staging" schema that's almost the same as public but
    // missing a column on users and adds a new table. This produces
    // both an "added" and "altered" diff row.
    await page.evaluate(async () => {
      const sql = `
        DROP SCHEMA IF EXISTS staging CASCADE;
        CREATE SCHEMA staging;
        CREATE TABLE staging.users (
          id integer PRIMARY KEY,
          name text NOT NULL
        );
        CREATE TABLE staging.orders (
          id integer PRIMARY KEY,
          user_id integer,
          total numeric,
          status text,
          created_at timestamptz,
          notes text
        );
        CREATE TABLE staging.audit_log (
          id serial PRIMARY KEY,
          actor text,
          action text,
          at timestamptz DEFAULT now()
        );
      `;
      const w = window as unknown as { fetch: typeof fetch };
      // The sidecar speaks to the connection via the live session id.
      const tabs = JSON.parse(localStorage.getItem("nembrix.tabs.v1") || "{}");
      const sessionId = tabs.sessions?.[0]?.id;
      if (!sessionId) return;
      const connectionId = tabs.sessions[0].connectionId;
      await w.fetch("http://localhost:1421/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connectionId, sql }),
      });
      void sessionId;
    });
    // Refresh schema so the diff tab sees the new schema.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+R" : "Control+R");
    await page.waitForTimeout(1000);
    // Open Schema Diff via Database menu.
    // Open via menubar click → menu-dropdown item click.
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.waitForSelector(".menu-dropdown", { timeout: 3000 });
    const diffItem = page.locator(".menu-dropdown .menu-item").filter({ hasText: "Schema Diff" });
    await diffItem.first().click({ force: true });
    // Tab title in the tab bar is "Schema diff". Wait for the .tab-bar
    // entry instead of digging into the tab's content (which races
    // with introspection).
    await page.waitForTimeout(2000);
    // The diff tab defaults both sides to public. Switch the right side
    // to the staging schema we just created.
    await page.waitForTimeout(800);
    const stagingOption = page.locator("select option", { hasText: "staging" }).first();
    if (await stagingOption.count()) {
      const stagingSelect = stagingOption.locator("..").first();
      await stagingSelect.selectOption({ label: "staging" });
    }
    await page.waitForTimeout(800);
    await shot();
  },
});
