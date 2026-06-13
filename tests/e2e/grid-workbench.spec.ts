import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000099",
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
});

test("clicking a column header opens the summary popover", async ({ page }) => {
  await page.locator(".rail-avatar").first().click();
  await page.locator("[data-testid='connect-btn']").click();
  // Data-view auto-loads rows on open.
  await page.getByText("orders").dblclick();
  await expect(page.locator("table.grid tbody tr").first()).toBeVisible();

  await page.getByRole("columnheader", { name: /^id/ }).click();
  await expect(page.getByText(/Rows seen/)).toBeVisible();
  await expect(page.getByText(/Distinct/)).toBeVisible();
});

test("a foreign-key column gets the fk badge and opens the detail panel on click", async ({ page }) => {
  await page.locator(".rail-avatar").first().click();
  await page.locator("[data-testid='connect-btn']").click();
  await page.getByText("orders").dblclick();
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
