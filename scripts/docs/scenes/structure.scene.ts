import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "structure",
  description: "Structure tab on orders showing the column list with inline edit affordances.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("button:has-text('Structure')", { timeout: 8000 });
    await page.click("button:has-text('Structure')");
    await page.waitForSelector(".meta-table.editable td.editable-cell", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
