import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "activity",
  description: "Activity tab listing pg_stat_activity sessions.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "Server Activity" }).click();
    await page.waitForSelector("text=Activity", { timeout: 5000 });
    // Let the pg_stat_activity poll cycle through at least once.
    await page.waitForTimeout(1500);
    await shot();
  },
});
