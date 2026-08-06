import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
  await page.locator(".empty-tab-card", { hasText: "users" }).click();
  // Mock returns 3 rows for users.
  await expect(page.locator(".grid-scroll")).toContainText("alice");
});

test("typing a needle filters the grid to matching rows and updates the count", async ({ page }) => {
  const grid = page.locator(".grid-scroll");
  await expect(grid).toContainText("alice@example.com");
  await expect(grid).toContainText("bob@example.com");
  await expect(grid).toContainText("carol@example.com");

  const input = page.locator("[data-testid='grid-search']");
  await input.fill("alice");
  await expect(grid).toContainText("alice@example.com");
  await expect(grid).not.toContainText("bob@example.com");
  await expect(grid).not.toContainText("carol@example.com");

  // 1 match out of 3 loaded rows. The async row-total estimate may add an
  // " of N" suffix, so match the matches/loaded counts + "rows". The count
  // lives in the footer below the grid now, not the top toolbar.
  await expect(page.locator(".data-view-footer .data-view-meta")).toHaveText(
    /^1 \/ 3( of [\d,]+( \(est\.\))?)? rows/,
  );
});

test("clearing the search restores all rows", async ({ page }) => {
  const input = page.locator("[data-testid='grid-search']");
  await input.fill("alice");
  await page.locator(".grid-quick-search-clear").click();
  const grid = page.locator(".grid-scroll");
  await expect(grid).toContainText("alice@example.com");
  await expect(grid).toContainText("bob@example.com");
  await expect(grid).toContainText("carol@example.com");
  // Back to the unfiltered count: all 3 loaded rows. The async row-total
  // estimate may add an " of N" suffix, so match the loaded count + "rows".
  // The count lives in the footer below the grid now, not the top toolbar.
  await expect(page.locator(".data-view-footer .data-view-meta")).toHaveText(
    /^3( of [\d,]+( \(est\.\))?)? rows/,
  );
});

test("Escape from the search input clears it", async ({ page }) => {
  const input = page.locator("[data-testid='grid-search']");
  await input.fill("alice");
  await expect(page.locator(".grid-scroll")).not.toContainText("bob@example.com");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.locator(".grid-scroll")).toContainText("bob@example.com");
});
