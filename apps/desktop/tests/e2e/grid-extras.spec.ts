import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000222",
      name: "Demo",
      engine: "postgres",
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
  // Data-view auto-loads — wait for the grid to render before continuing.
  await expect(page.locator("table.grid tbody tr").first()).toBeVisible();
});

test("clicking a top-value in the column summary adds a filter chip", async ({ page }) => {
  await page.getByRole("columnheader", { name: /user_id/ }).click();
  await expect(page.getByText(/Top values/)).toBeVisible();
  // First top row (the most-common user_id value).
  await page.locator(".col-summary .top-row").first().click();
  await expect(page.locator(".filter-bar .chip")).toHaveCount(1);
  await expect(page.locator(".filter-bar .chip .col")).toHaveText("user_id");
});

test("Clear all removes every filter chip", async ({ page }) => {
  await page.getByRole("columnheader", { name: /user_id/ }).click();
  await page.locator(".col-summary .top-row").first().click();
  await expect(page.locator(".filter-bar .chip")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.locator(".filter-bar .chip")).toHaveCount(0);
});

test("pinning a row keeps it visible (sticky)", async ({ page }) => {
  // Each virtual row is its own table — target the first .pin-btn directly.
  const firstPin = page.locator(".pin-btn").first();
  await firstPin.click({ force: true });
  // A sticky pinned row now lives in the body table directly under the header.
  await expect(page.locator(".grid-body tbody tr").first()).toHaveCSS("position", "sticky");
});

test("Chart tab renders an SVG once X/Y are picked", async ({ page }) => {
  await page.getByRole("button", { name: "Chart" }).click();
  await expect(page.locator(".chart-svg")).toBeVisible();
});
