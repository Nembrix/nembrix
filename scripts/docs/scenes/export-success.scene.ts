import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "export-success",
  description: "Export success dialog after exporting the orders table.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    // Open Export dialog → click Download (the browser-mode Save button).
    await page.locator("button", { hasText: "Export" }).first().click();
    await page.waitForSelector("text=Format", { timeout: 5000 });
    // The primary button reads "Download" in browser mode, "Save to file…"
    // in Tauri. We're always in browser-mode here.
    await page.locator("button", { hasText: "Download" }).click();
    await page.waitForSelector("text=Success", { timeout: 8000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
