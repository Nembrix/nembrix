import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

/**
 * The wake-from-sleep reflow nudge writes to the DOM on focus/visibility.
 * These pin that it is a no-op for the layout — the risk of a workaround like
 * this is that it disturbs the very thing it is meant to protect.
 */
test("the reflow nudge leaves the layout unchanged", async ({ page }) => {
  await seedConnectedSession(page);
  const app = page.locator(".app");
  const before = await app.evaluate((el) => el.getBoundingClientRect().height);

  // Drive both triggers the hook listens for.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Height must be unchanged immediately — the nudge must never resize the app.
  const after = await app.evaluate((el) => el.getBoundingClientRect().height);
  expect(after).toBe(before);

  // The transient padding is reverted on the next animation frame, so poll for
  // it rather than racing a fixed timeout.
  await expect
    .poll(() => app.evaluate((el) => (el as HTMLElement).style.paddingBottom))
    .toBe("");
});

test("the app still renders after repeated wake events", async ({ page }) => {
  await seedConnectedSession(page);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  await page.waitForTimeout(150);
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".rail-avatar").first()).toBeVisible();
});
