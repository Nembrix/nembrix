import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "copy-dialog",
  description: "Copy-to-connection dialog (database mode) opened via menubar.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    // The label contains "Copy to Connection…" with an ellipsis.
    await page.locator(".menu-item", { hasText: "Copy to Connection" }).click();
    // The dialog header reads "Copy database between connections" when
    // mode = database, or "Copy table between connections" otherwise.
    await page.waitForSelector("text=between connections", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
