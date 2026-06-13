import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "import-dialog",
  description: "Import dialog with CSV format selected, ready to pick a file.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // File menu → Import…
    await page.locator(".menu-bar-item", { hasText: "File" }).click();
    await page.locator(".menu-item", { hasText: "Import" }).click();
    await page.waitForSelector("text=Import", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
