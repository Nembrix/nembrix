import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "inspector-table-pick",
  description: "Inspector with the orders row hovered, ready to double-click.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Hover the orders row so the hover styling is captured.
    await page.locator(".item-row", { hasText: "orders" }).first().hover();
    await page.waitForTimeout(300);
    await shot();
  },
});
