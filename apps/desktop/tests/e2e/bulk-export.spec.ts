import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

/** Bulk-export the public schema via the File → Export menu. */
test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

test("File → Export opens the bulk dialog with all tables checked", async ({ page }) => {
  // Use the palette so we don't depend on the menu's open-then-click sequence.
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("export");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Bulk export")).toBeVisible();
  const boxes = page.locator(".export-columns input[type='checkbox']");
  // Mock seeds 2 relations in public (users + orders).
  await expect(boxes).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(boxes.nth(i)).toBeChecked();
  }
});

test("running a bulk export in browser mode produces a combined download", async ({ page }) => {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("export");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Bulk export")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export 2 tables/ }).click();
  const download = await downloadPromise;

  // Two table headers and the rows from the mock backend (alice / orders 1299).
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(path!, "utf8");
  expect(text).toContain("public.users");
  expect(text).toContain("public.orders");
  expect(text).toContain("alice@example.com");
  expect(text).toContain("1299");

  // Per-table progress rows show success.
  await expect(page.locator(".bulk-job.status-done")).toHaveCount(2);
});
