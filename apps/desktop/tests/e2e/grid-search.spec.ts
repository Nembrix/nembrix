import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000777",
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
  await page.getByText("users").dblclick();
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

  await expect(page.getByText("1 / 3 rows")).toBeVisible();
});

test("clearing the search restores all rows", async ({ page }) => {
  const input = page.locator("[data-testid='grid-search']");
  await input.fill("alice");
  await page.locator(".grid-quick-search-clear").click();
  const grid = page.locator(".grid-scroll");
  await expect(grid).toContainText("alice@example.com");
  await expect(grid).toContainText("bob@example.com");
  await expect(grid).toContainText("carol@example.com");
  await expect(page.getByText("3 rows")).toBeVisible();
});

test("Escape from the search input clears it", async ({ page }) => {
  const input = page.locator("[data-testid='grid-search']");
  await input.fill("alice");
  await expect(page.locator(".grid-scroll")).not.toContainText("bob@example.com");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.locator(".grid-scroll")).toContainText("bob@example.com");
});
