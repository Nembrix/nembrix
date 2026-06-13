import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "structure-rename-preview",
  description: "Column rename via the SQL preview dialog (Structure tab → click a column name).",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Inspector rows open tables on DOUBLE-click, not single click.
    // Single-clicking does nothing — anchor with .item-row to avoid
    // matching the same text in the EmptyTabArea card.
    await page.locator(".item-row", { hasText: "orders" }).first().dblclick();
    await page.waitForSelector("button:has-text('Structure')", { timeout: 8000 });
    await page.click("button:has-text('Structure')");
    // Wait for the Columns table then click the first column name to
    // fire the ColumnAlterDialog with the ALTER TABLE … RENAME preview.
    await page.waitForSelector(".meta-table.editable td.editable-cell", { timeout: 5000 });
    await page.locator(".meta-table.editable td.editable-cell").first().click();
    await page.waitForSelector("text=/Rename|ALTER TABLE/", { timeout: 5000 });
    // Type a different name so the preview actually shows the rename.
    const nameInput = page.locator("input[type='text']").last();
    await nameInput.fill("user_ref");
    await page.waitForTimeout(250);
    await shot();
  },
});
