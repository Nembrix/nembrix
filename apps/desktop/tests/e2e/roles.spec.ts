import { test, type Page } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

/** Open the Roles tab. Use the command palette (driven by the menu
 *  dispatcher) so we don't depend on the fragile multi-step menu
 *  open/click interaction. */
async function openRolesTab(page: Page) {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("manage roles");
  // Wait for the filtered result before committing — pressing Enter on a
  // not-yet-filtered list selects the wrong (or no) action.
  await expect(page.locator(".palette-row").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".roles-shell")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

test("opens Roles tab and lists pg_roles", async ({ page }) => {
  await openRolesTab(page);
  await expect(page.locator(".role-row", { hasText: "postgres" })).toBeVisible();
  await expect(page.locator(".role-row", { hasText: "qa" })).toBeVisible();
  await expect(page.locator(".role-row", { hasText: "readonly" })).toBeVisible();
});

test("selecting a role loads its grant matrix", async ({ page }) => {
  await openRolesTab(page);

  await page.locator(".role-row", { hasText: "qa" }).click();
  await expect(page.locator(".role-attrs-title", { hasText: "qa" })).toBeVisible();
  // qa has SELECT only — verify by checking that the first relation's SELECT cell shows ✓.
  const usersRow = page.locator("table.grant-matrix-table tbody tr", { hasText: "users" });
  await expect(usersRow.locator(".priv-check.on")).toHaveCount(1);
});

test("toggling a privilege queues a pending change with SQL preview", async ({ page }) => {
  await openRolesTab(page);

  await page.locator(".role-row", { hasText: "qa" }).click();
  const usersRow = page.locator("table.grant-matrix-table tbody tr", { hasText: "users" });
  // Wait for the matrix to settle on qa's view (SELECT on, INSERT off).
  // The mock returns SELECT only for qa, so exactly 1 priv-check.on per row.
  await expect(usersRow.locator(".priv-check.on")).toHaveCount(1);

  // Click the INSERT cell (priv-cell index 1).
  await usersRow.locator("td.priv-cell").nth(1).click();

  // The pending counter + Apply button appear, and the SQL preview includes GRANT INSERT.
  await expect(page.getByText(/1 pending/)).toBeVisible();
  await expect(page.locator(".pending-preview .sql-preview"))
    .toContainText(`GRANT INSERT ON "public"."users" TO "qa"`);
});

test("New role opens the Create dialog with SQL preview", async ({ page }) => {
  await openRolesTab(page);

  await page.locator(".roles-sidebar button[title='New role']").click();
  await expect(page.locator(".modal-header", { hasText: "Create role" })).toBeVisible();
  await page.locator(".modal-body input[type='text']").fill("audit");
  await expect(page.locator(".modal-body .sql-preview")).toContainText(`CREATE ROLE "audit"`);
});
