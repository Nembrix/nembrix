import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "edit-pending-banner",
  description: "Grid with 2 dirty (pending) cells and the yellow banner at the top.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    // Edit two cells so the banner shows "2 pending edits".
    const statusCells = page.locator(".grid-body td").filter({ hasText: /paid|pending|shipped|refunded/ });
    await statusCells.nth(0).dblclick();
    await page.keyboard.type("paid_x");
    await page.keyboard.press("Enter");
    await statusCells.nth(2).dblclick();
    await page.keyboard.type("shipped_x");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".grid-edit-banner", { timeout: 3000 });
    // Make sure we're scrolled to the top so the banner is in the shot.
    await page.evaluate(() => {
      const scroll = document.querySelector(".grid-scroll");
      if (scroll) scroll.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    await shot();
  },
});
