import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000444",
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
  await page.getByText("orders").dblclick();
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
  await expect(page.getByText("→ public.orders.csv")).toBeVisible();
});

test("switching format updates the suggested filename extension", async ({ page }) => {
  await page.getByRole("button", { name: /Export/ }).click();
  await page.locator(".segmented button", { hasText: "JSONL" }).click();
  await expect(page.getByText("→ public.orders.jsonl")).toBeVisible();
  await page.locator(".segmented button", { hasText: "SQL" }).click();
  await expect(page.getByText("→ public.orders.sql")).toBeVisible();
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
