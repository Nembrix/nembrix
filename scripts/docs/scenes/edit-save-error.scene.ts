import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "edit-save-error",
  description: "Save error modal with a real Postgres rejection.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    // Edit a row's user_id (integer column) to a non-integer string so
    // Postgres rejects the UPDATE on Save. The error modal pops up.
    const userIdCell = page.locator(".grid-body td").filter({ hasText: /^\d+$/ }).nth(2);
    await userIdCell.dblclick();
    await page.keyboard.type("not-a-number");
    await page.keyboard.press("Enter");
    // ⌘S commits the pending edit; Postgres rejects.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+S" : "Control+S");
    await page.waitForSelector("text=Save failed", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
