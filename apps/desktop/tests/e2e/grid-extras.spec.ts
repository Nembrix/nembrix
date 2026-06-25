import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
  await page.locator(".empty-tab-card", { hasText: "orders" }).click();
  // Data-view auto-loads — wait for the grid to render before continuing.
  await expect(page.locator("table.grid tbody tr").first()).toBeVisible();
});

test("clicking a top-value in the column summary adds a filter chip", async ({ page }) => {
  await page.getByRole("columnheader", { name: /user_id/ }).locator(".hdr-stats").click();
  await expect(page.getByText(/Top values/)).toBeVisible();
  // First top row (the most-common user_id value).
  await page.locator(".col-summary .top-row").first().click();
  await expect(page.locator(".filter-builder .chip")).toHaveCount(1);
  await expect(page.locator(".filter-builder .chip .col")).toHaveText("user_id");
});

test("Clear all removes every filter chip", async ({ page }) => {
  await page.getByRole("columnheader", { name: /user_id/ }).locator(".hdr-stats").click();
  await page.locator(".col-summary .top-row").first().click();
  await expect(page.locator(".filter-builder .chip")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.locator(".filter-builder .chip")).toHaveCount(0);
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
