import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

test("right-click a table opens the context menu with object-op actions", async ({ page }) => {
  await page.locator(".item-row", { hasText: "users" }).click({ button: "right" });
  await expect(page.getByText("Rename…")).toBeVisible();
  await expect(page.getByText("Duplicate…")).toBeVisible();
  await expect(page.getByText("Drop…")).toBeVisible();
});

test("Rename Table flow shows SQL preview before Apply", async ({ page }) => {
  await page.locator(".item-row", { hasText: "users" }).click({ button: "right" });
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
  await page.locator(".item-row", { hasText: "orders" }).click({ button: "right" });
  await page.getByText("Duplicate…").click();
  // The form has: From (disabled), To schema (text), To name (text), With data (checkbox).
  // Filter to text inputs only and fill the last one.
  const textInputs = page.locator('.modal-body input[type="text"]:not([disabled])');
  await textInputs.last().fill("orders_copy");
  await page.getByRole("button", { name: "Preview SQL" }).click();
  await expect(page.locator(".sql-preview")).toContainText("CREATE TABLE");
  await expect(page.locator(".warn-row")).toContainText(/does NOT copy indexes/);
});
