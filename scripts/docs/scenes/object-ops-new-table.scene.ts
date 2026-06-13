import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "object-ops-new-table",
  description: "New Table dialog with SQL preview after clicking Preview.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Open via Table → New Table.
    await page.locator(".menu-bar-item", { hasText: "Table" }).click();
    await page.locator(".menu-item", { hasText: "New Table" }).click();
    await page.waitForSelector("text=Create table", { timeout: 5000 });
    // Fill in a name + click Preview to surface the SQL.
    await page.locator("input[type='text']").first().fill("products");
    await page.locator("button", { hasText: "Preview" }).click();
    await page.waitForSelector("text=/CREATE TABLE/", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
