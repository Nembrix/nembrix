import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "import-mapping",
  description: "Import dialog with a small CSV pasted and the column mapping table visible.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Give the schema cache an extra beat to finish populating before
    // we open the dialog — the table picker reads from store.schemas.
    await page.waitForTimeout(500);
    await page.locator(".menu-bar-item", { hasText: "File" }).click();
    await page.locator(".menu-item", { hasText: "Import" }).click();
    await page.waitForSelector("text=Import", { timeout: 5000 });
    // Seed the file input with a small CSV that maps onto users.
    const csv = "name,email\nAlice,a@example.com\nBob,b@example.com\nCarol,c@example.com\n";
    await page.locator("[data-testid='import-file']").setInputFiles({
      name: "users.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    // The Target section appears after parse. Pick the users table —
    // the schema introspect needs to complete before users shows up.
    await page.waitForSelector("text=Target", { timeout: 5000 });
    await page.waitForTimeout(800);
    // Form-grid selects in order: delimiter, schema, TABLE, conflict.
    // Wait for the table select (index 2) to populate with real options.
    await page.waitForFunction(() => {
      const sels = document.querySelectorAll(".form-grid select");
      return sels.length > 2 && (sels[2] as HTMLSelectElement).options.length > 1;
    }, undefined, { timeout: 10_000 });
    await page.locator(".form-grid select").nth(2).selectOption({ label: "users" });
    await page.waitForSelector("table.import-mapping", { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot();
  },
});
