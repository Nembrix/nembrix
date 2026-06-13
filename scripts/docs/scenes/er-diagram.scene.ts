import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "er-diagram",
  description: "ER diagram showing users / orders / order_items relationship.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Open via Database → ER Diagram.
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "ER Diagram" }).click();
    // Wait for the diagram canvas + at least one node.
    await page.waitForSelector(".er-canvas .er-node", { timeout: 8000 });
    // Reset layout → re-runs relax with empty pinned positions, then
    // Fit so the nodes fill the canvas instead of clustering.
    await page.locator("button", { hasText: "Reset layout" }).click();
    await page.waitForTimeout(1500);
    await page.locator("button", { hasText: "Fit" }).click();
    await page.waitForTimeout(500);
    await shot();
  },
});
