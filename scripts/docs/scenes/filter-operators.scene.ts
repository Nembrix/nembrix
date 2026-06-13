import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "filter-operators",
  description: "Filter builder with the operator dropdown open showing every operator.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    await page.click("button:has-text('Add filter')");
    await page.waitForSelector(".filter-row", { timeout: 3000 });
    // Click the operator select to open its native dropdown — Playwright
    // can't capture the popout reliably across OSes, so we trigger
    // selectOption to display the operator menu visually via focus.
    const opSelect = page.locator(".filter-row .filter-op").first();
    await opSelect.focus();
    await page.waitForTimeout(300);
    await shot();
  },
});
