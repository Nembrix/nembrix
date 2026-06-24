import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-0000000000dd",
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

async function openSchemaDiffTab(page: import("@playwright/test").Page) {
  // Use the command palette — most reliable in tests.
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await page.keyboard.type("Schema Diff");
  await page.keyboard.press("Enter");
  await expect(page.locator(".diff-shell")).toBeVisible();
}

test("Schema Diff tab opens with both side pickers and the migration preview pane", async ({ page }) => {
  await openSchemaDiffTab(page);
  await expect(page.locator(".diff-side-picker")).toHaveCount(2);
  await expect(page.getByText("Migration SQL")).toBeVisible();
});

test("comparing a schema with itself shows the identical empty-state", async ({ page }) => {
  await openSchemaDiffTab(page);
  // The mock backend returns the same SchemaTree for every conn — diffing
  // a connection against itself yields zero ops.
  await expect(page.locator(".diff-tree")).toContainText("identical");
  // Migration SQL pane shows the "nothing to do" comment.
  await expect(page.locator("[data-testid='migration-sql']")).toContainText("Nothing to migrate");
});

test("Apply button is disabled when there are no selected diff ops", async ({ page }) => {
  await openSchemaDiffTab(page);
  await expect(page.getByRole("button", { name: /^Apply 0$/ })).toBeDisabled();
});
