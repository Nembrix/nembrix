import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

/**
 * The doc references activity-locks.png separately from activity.png,
 * but we don't currently render a dedicated locks panel — pg_locks is
 * shown only inline with the session row. Until a real locks UI lands,
 * point this at the same Activity tab; the doc still has context.
 */
export default defineScene({
  name: "activity-locks",
  description: "Activity tab (locks panel placeholder until a dedicated UI lands).",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "Server Activity" }).click();
    await page.waitForSelector("text=Activity", { timeout: 5000 });
    await page.waitForTimeout(1500);
    await shot();
  },
});
