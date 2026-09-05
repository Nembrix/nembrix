import { test } from "@playwright/test";
import { expect, seedConnectedSession, openTable } from "./_setup";

/**
 * A dropped connection can leave `stream` resolved with no batch ever
 * arriving — no `done`, no error — which left the grid on "Running…"
 * indefinitely ("0 rows · 12.0 s" and climbing). The watchdog turns that into
 * an actionable error.
 */
test("a stream that never emits surfaces an error instead of spinning", async ({ page }) => {
  // Make the mock stream accept the call and then never emit anything.
  await page.addInitScript(() => {
    (window as unknown as { __STALL_STREAM__?: boolean }).__STALL_STREAM__ = true;
    (window as unknown as { __STALL_MS__?: number }).__STALL_MS__ = 1500;
  });
  await seedConnectedSession(page);
  await openTable(page, "orders").catch(() => {});

  // Without the watchdog this stays "Running…" forever.
  await expect(page.getByText(/No response from the database/)).toBeVisible({
    timeout: 15_000,
  });
});
