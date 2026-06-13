import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "export-dialog",
  description: "Export dialog mid-configuration on the seeded orders table.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    // Toolbar Export button opens the dialog.
    await page.locator("button", { hasText: "Export" }).first().click();
    await page.waitForSelector("text=Format", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
