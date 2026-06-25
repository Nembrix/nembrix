import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

test("clicking a column header opens the summary popover", async ({ page }) => {
  // Data-view auto-loads rows on open.
  await page.locator(".empty-tab-card", { hasText: "orders" }).click();
  await expect(page.locator("table.grid tbody tr").first()).toBeVisible();

  // The header itself sorts — the column summary opens via the per-column
  // stats (bar-chart) icon inside the `id` header.
  await page
    .getByRole("columnheader", { name: /^id/ })
    .locator(".hdr-stats")
    .click();
  await expect(page.locator(".col-summary")).toBeVisible();
  await expect(page.getByText(/Rows seen/)).toBeVisible();
  await expect(page.getByText(/Distinct/)).toBeVisible();
});

test("a foreign-key column gets the fk badge and opens the detail panel on click", async ({ page }) => {
  await page.locator(".empty-tab-card", { hasText: "orders" }).click();
  await expect(page.locator("table.grid tbody tr").first()).toBeVisible();

  const userIdHeader = page.getByRole("columnheader", { name: /user_id/ });
  await expect(userIdHeader.locator(".fk-badge")).toBeVisible();

  // Clicking a user_id cell opens the FK side panel for the referenced users row.
  // The virtualized grid puts rows in an absolute container that Playwright's
  // viewport check rejects — dispatch the click directly to bypass it.
  await page.evaluate(() => {
    const cell = document.querySelector("td.fk-cell") as HTMLElement | null;
    cell?.click();
  });
  await expect(page.locator(".fk-panel")).toBeVisible();
});
