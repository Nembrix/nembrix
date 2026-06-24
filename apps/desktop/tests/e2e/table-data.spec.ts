import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000333",
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
});

test("double-clicking a table opens a data view that loads rows by default (no editor)", async ({ page }) => {
  await page.getByText("orders").dblclick();
  // No CodeMirror editor in this tab.
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  // The pure-GUI toolbar shows the relation name.
  await expect(page.getByText("public.orders")).toBeVisible();
  // Data is loaded by the mock backend — the grid-scroll container has rows.
  await expect(page.locator(".grid-scroll")).toContainText("placed_at");
});

test("Structure / Indexes / Info segments swap the body content", async ({ page }) => {
  await page.getByText("orders").dblclick();

  await page.locator(".result-segments .segmented button", { hasText: "Structure" }).click();
  await expect(page.locator(".meta-table")).toBeVisible();
  // Column metadata visible (we seeded `total_cents` as bigint in the mock).
  await expect(page.getByText("total_cents")).toBeVisible();
  await expect(page.getByText(/bigint/i)).toBeVisible();

  await page.locator(".result-segments .segmented button", { hasText: "Indexes" }).click();
  // Index name appears twice per row (Name column + Definition column).
  // Use a stricter locator scoped to the Name column.
  await expect(page.locator(".meta-table tbody tr td:first-child", { hasText: "orders_pkey" })).toBeVisible();
  await expect(page.locator(".meta-table tbody tr td:first-child", { hasText: "orders_payload_gin" })).toBeVisible();

  await page.locator(".result-segments .segmented button", { hasText: "Info" }).click();
  await expect(page.getByText("Primary key")).toBeVisible();
  await expect(page.getByText("Foreign keys").first()).toBeVisible();
});

test("hiding a column drops it from the data grid", async ({ page }) => {
  await page.getByText("orders").dblclick();
  await expect(page.getByRole("columnheader", { name: /placed_at/ })).toBeVisible();

  await page.getByRole("button", { name: /Columns/ }).click();
  await page.locator(".col-menu-row", { hasText: "placed_at" }).click();
  // After hiding, the column is gone from the header.
  await expect(page.getByRole("columnheader", { name: /placed_at/ })).toHaveCount(0);
});
