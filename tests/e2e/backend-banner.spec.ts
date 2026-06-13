import { test, expect } from "@playwright/test";

test("the Mock mode banner is visible when no sidecar is running", async ({ page }) => {
  // Block any outgoing request to the sidecar so the probe definitely fails,
  // regardless of whether a real sidecar happens to be running locally.
  await page.route("**/localhost:1421/**", (r) => r.abort());
  await page.goto("/");
  const banner = page.locator(".backend-banner.mock");
  await expect(banner).toBeVisible();
  // Banner text is split across child nodes — assert via toContainText on the parent.
  await expect(banner).toContainText("Mock mode");
  await expect(banner).toContainText("npm run dev:all");
  await expect(banner).toContainText("cargo tauri dev");
});
