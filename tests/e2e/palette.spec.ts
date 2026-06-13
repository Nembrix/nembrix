import { test, expect, type Page } from "@playwright/test";

/** Open the command palette via the in-app menu — Chromium intercepts ⌘P for print. */
async function openPalette(page: Page) {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("Command Palette opens and Esc closes it", async ({ page }) => {
  // Use the in-app menu rather than ⌘P — Chromium intercepts ⌘P for print.
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder(/Search actions/)).toBeHidden();
});

test("running an action through the palette", async ({ page }) => {
  await openPalette(page);
  // Type a fuzzy approximation of "New Connection"
  await page.keyboard.type("new conn");
  // The matching action should be the first row.
  await page.keyboard.press("Enter");
  // The connection form opens as a result.
  await expect(page.getByText(/new postgresql connection/i)).toBeVisible();
});

test("> mode filters to actions only", async ({ page }) => {
  // Seed a saved connection so the unfiltered list contains a 'Connections' group.
  await page.evaluate(() => {
    const rec = {
      id: "00000000-0000-0000-0000-000000000077",
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

  await openPalette(page);
  // Without prefix: Connections group is visible
  await expect(page.getByText("Connections", { exact: true })).toBeVisible();
  // > prefix hides non-action groups
  await page.keyboard.type("> ");
  await expect(page.getByText("Connections", { exact: true })).toBeHidden();
});
