import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  // Chromium exposes the File System Access save picker, which the export
  // dialog prefers over an anchor download — but Playwright can't drive that
  // native picker. Hide it so the dialog falls back to the Blob download path
  // (button label "Download") that emits a real `download` event.
  await page.addInitScript(() => {
    // Intentionally remove the picker for the test env so the dialog
    // falls back to the Blob download path.
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await seedConnectedSession(page);
  await page.locator(".empty-tab-card", { hasText: "orders" }).click();
  // Wait for data to load so the dialog has columns to render.
  await expect(page.locator(".grid-scroll")).toContainText("placed_at");
});

test("opens the Export dialog with all columns checked and the right default filename", async ({ page }) => {
  await page.getByRole("button", { name: /Export/ }).click();
  await expect(page.getByText(/Export public\.orders/)).toBeVisible();
  // 4 columns on the orders mock: id, user_id, total_cents, placed_at.
  const boxes = page.locator(".export-columns input[type='checkbox']");
  await expect(boxes).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(boxes.nth(i)).toBeChecked();
  }
  // Filename drops the default `public` schema — `orders.csv`, not
  // `public.orders.csv`. The dialog title above still shows the qualified
  // table, which is the right level of detail there.
  await expect(page.getByText("→ orders.csv")).toBeVisible();
});

test("switching format updates the suggested filename extension", async ({ page }) => {
  await page.getByRole("button", { name: /Export/ }).click();
  await page.locator(".segmented button", { hasText: "JSONL" }).click();
  await expect(page.getByText("→ orders.jsonl")).toBeVisible();
  await page.locator(".segmented button", { hasText: "SQL" }).click();
  await expect(page.getByText("→ orders.sql")).toBeVisible();
});

test("CSV download contains the expected header + cell values", async ({ page }) => {
  await page.getByRole("button", { name: /Export/ }).click();
  // Drop user_id to verify column filtering reaches the output.
  await page.locator(".export-column", { hasText: "user_id" }).locator("input").uncheck();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(path!, "utf8");

  // Header has id,total_cents,placed_at and NOT user_id.
  const firstLine = text.split("\n")[0];
  expect(firstLine).toBe("id,total_cents,placed_at");
  expect(text).toContain("1,1299,");
  expect(text).not.toContain("user_id");
});

test("SQL export emits an INSERT statement against the qualified target", async ({ page }) => {
  await page.getByRole("button", { name: /Export/ }).click();
  await page.locator(".segmented button", { hasText: "SQL" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(path!, "utf8");

  expect(text).toMatch(/^INSERT INTO "public"\."orders" \("id", "user_id", "total_cents", "placed_at"\) VALUES/m);
  expect(text).toContain(`(1, 1, 1299,`);
});
