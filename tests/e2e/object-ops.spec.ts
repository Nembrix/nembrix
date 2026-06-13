import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000111",
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
});

test("right-click a table opens the context menu with object-op actions", async ({ page }) => {
  await page.getByText("users").click({ button: "right" });
  await expect(page.getByText("Rename…")).toBeVisible();
  await expect(page.getByText("Duplicate…")).toBeVisible();
  await expect(page.getByText("Drop…")).toBeVisible();
});

test("Rename Table flow shows SQL preview before Apply", async ({ page }) => {
  await page.getByText("users").click({ button: "right" });
  await page.getByText("Rename…").click();
  await expect(page.getByText(/Rename public\.users/)).toBeVisible();

  // The two labels in this form are "From" (disabled) and "To" (editable).
  // Target by their input position to avoid label-text ambiguity.
  await page.locator(".modal-body input").nth(1).fill("users_v2");
  await page.getByRole("button", { name: "Preview SQL" }).click();
  await expect(page.locator(".sql-preview")).toContainText(
    `ALTER TABLE "public"."users" RENAME TO "users_v2"`,
  );
});

test("Duplicate Table shows the with-data warning", async ({ page }) => {
  await page.getByText("orders").click({ button: "right" });
  await page.getByText("Duplicate…").click();
  // The form has: From (disabled), To schema (text), To name (text), With data (checkbox).
  // Filter to text inputs only and fill the last one.
  const textInputs = page.locator('.modal-body input[type="text"]:not([disabled])');
  await textInputs.last().fill("orders_copy");
  await page.getByRole("button", { name: "Preview SQL" }).click();
  await expect(page.locator(".sql-preview")).toContainText("CREATE TABLE");
  await expect(page.locator(".warn-row")).toContainText(/does NOT copy indexes/);
});
