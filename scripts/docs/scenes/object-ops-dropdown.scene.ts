import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "object-ops-dropdown",
  description: "Inspector \"+\" dropdown showing New Table / View / Materialized View / Function / Schema.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // The "+" next to the schema picker has aria-label="New object…".
    await page.getByRole("button", { name: "New object…" }).click();
    await page.waitForSelector(".context-menu", { timeout: 5000 });
    await page.waitForTimeout(200);
    await shot();
  },
});
