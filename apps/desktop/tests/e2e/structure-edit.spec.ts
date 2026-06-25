import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
  await page.locator(".empty-tab-card", { hasText: "orders" }).click();
  await page.locator(".result-segments .segmented button", { hasText: "Structure" }).click();
});

test("clicking the type cell opens an inline editor with type suggestions", async ({ page }) => {
  // Each row in the Structure table is one column on `orders`.
  const row = page.locator(".meta-table.editable tbody tr", { hasText: "user_id" });
  await row.locator("td.editable-cell.mono").first().click();

  // Inline type editor (a <select> combobox of common PG types) appears.
  const typeInput = row.locator("select.inline-type-input");
  await expect(typeInput).toBeVisible();
  // The common Postgres type options are wired up.
  await expect(typeInput.locator("option", { hasText: "custom" })).toBeAttached();
  await expect(typeInput.locator("option")).not.toHaveCount(0);
});

test("nullable column shows an inline toggle (no dialog)", async ({ page }) => {
  // `payload` is nullable in the seed.
  const row = page.locator(".meta-table.editable tbody tr", { hasText: "payload" });

  // Inline toggle shown — not a clickable cell that opens a dialog.
  const toggle = row.locator(".inline-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle.locator(".inline-toggle-label")).toHaveText(/yes/i);

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
