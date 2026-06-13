import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "edit-cell-context-menu",
  description: "Right-click cell context menu with Copy / Edit / Set NULL.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    // Right-click a data cell.
    await page.locator(".grid-body td").filter({ hasText: /paid|pending|shipped/ }).first().click({ button: "right" });
    await page.waitForSelector(".context-menu", { timeout: 3000 });
    await page.waitForTimeout(200);
    await shot();
  },
});
