import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "filters-empty",
  description: "Filter builder expanded with one empty row on the orders table.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    await page.click("button:has-text('Add filter')");
    await page.waitForTimeout(200);
    await shot();
  },
});
