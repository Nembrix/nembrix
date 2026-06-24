import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000555",
      name: "Demo", engine: "postgres",
      host: "h", port: 5432, username: "u",
      database: "d", ssl_mode: "prefer", ssh: null, color: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem("nembrix.mock.connections", JSON.stringify([rec]));
  });
  await page.reload();
  await page.locator(".rail-avatar").first().click();
  await page.locator("[data-testid='connect-btn']").click();
  await page.getByText("orders").dblclick();
  await page.locator(".result-segments .segmented button", { hasText: "Structure" }).click();
});

test("clicking the type cell opens an inline editor with type suggestions", async ({ page }) => {
  // Each row in the Structure table is one column on `orders`.
  const row = page.locator(".meta-table.editable tbody tr", { hasText: "user_id" });
  await row.locator("td.editable-cell.mono").first().click();

  // Inline text input appears for editing the type.
  await expect(row.locator(".inline-type-input")).toBeVisible();
  // The datalist for common Postgres types is wired up.
  await expect(row.locator(`datalist[id^="pg-types-"]`)).toBeAttached();
});

test("nullable column shows an inline toggle (no dialog)", async ({ page }) => {
  // `payload` is nullable in the seed.
  const row = page.locator(".meta-table.editable tbody tr", { hasText: "payload" });

  // Inline toggle shown — not a clickable cell that opens a dialog.
  const toggle = row.locator(".inline-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle.locator(".inline-toggle-label")).toHaveText("yes");

  await toggle.click();
  // After the SET NOT NULL fires through the mock, the introspect refresh
  // brings back the original schema (still nullable in the mock). What we
  // *can* verify is that no dialog opened — i.e. the toggle is in-place.
  await expect(page.locator(".sql-preview")).toHaveCount(0);
});

test("renaming via the column-name cell still opens the dialog", async ({ page }) => {
  // Rename is destructive of identity → dialog with confirmation kept.
  const row = page.locator(".meta-table.editable tbody tr", { hasText: "total_cents" });
  await row.locator("td.editable-cell").first().click();
  await expect(page.getByText(/Rename total_cents/)).toBeVisible();
  await page.locator(".modal-body input[type='text']:not([disabled])").first().fill("amount");
  await expect(page.locator(".sql-preview")).toContainText(
    `ALTER TABLE "public"."orders" RENAME COLUMN "total_cents" TO "amount";`,
  );
});
