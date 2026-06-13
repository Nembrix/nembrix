import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("⌘N opens the connection form", async ({ page }) => {
  await page.keyboard.press("Meta+N");
  await expect(page.getByText(/new postgresql connection/i)).toBeVisible();
});

test("⌘T does nothing without a connected DB but doesn't crash", async ({ page }) => {
  // No conn selected; accelerator must be a no-op because availability disables it.
  await page.keyboard.press("Meta+T");
  // Empty-state placeholder still visible — no tab was created.
  await expect(page.getByText(/Select a connection on the rail/)).toBeVisible();
});

test("Help → Keyboard Shortcuts via the palette opens the cheat sheet", async ({ page }) => {
  // Chromium intercepts ⌘P for print; use the in-app menu.
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await page.keyboard.type("keyboard short");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Keyboard shortcuts")).toBeVisible();
});
