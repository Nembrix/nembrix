import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "schema-diff-alter",
  description: "Schema diff tab with the Migration SQL section showing ALTER statements.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.evaluate(async () => {
      const tabs = JSON.parse(localStorage.getItem("nembrix.tabs.v1") || "{}");
      const connectionId = tabs.sessions?.[0]?.connectionId;
      if (!connectionId) return;
      const w = window as unknown as { fetch: typeof fetch };
      await w.fetch("http://localhost:1421/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connectionId,
          sql: `
            DROP SCHEMA IF EXISTS staging CASCADE;
            CREATE SCHEMA staging;
            CREATE TABLE staging.users (id integer PRIMARY KEY, name text);
            CREATE TABLE staging.orders (id integer PRIMARY KEY, user_id integer, total numeric, status text, created_at timestamptz, notes text);
            CREATE TABLE staging.audit_log (id serial PRIMARY KEY, actor text, action text, at timestamptz DEFAULT now());
          `,
        }),
      });
    });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+R" : "Control+R");
    await page.waitForTimeout(1000);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.waitForSelector(".menu-dropdown", { timeout: 3000 });
    await page.locator(".menu-dropdown .menu-item").filter({ hasText: "Schema Diff" }).first().click({ force: true });
    await page.waitForTimeout(2000);
    // Switch right side to staging.
    const stagingOption = page.locator("select option", { hasText: "staging" }).first();
    if (await stagingOption.count()) {
      const stagingSelect = stagingOption.locator("..").first();
      await stagingSelect.selectOption({ label: "staging" });
    }
    await page.waitForTimeout(800);
    // Scroll to the Migration SQL section.
    const migration = page.getByText("Migration SQL", { exact: false }).first();
    if (await migration.count()) await migration.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot();
  },
});
