import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the UI through Vite's dev server with the in-browser mock IPC layer.
 * No Rust host required, so CI runs in plain headless Chromium.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  // The app is driven through the mock IPC layer, which has small artificial
  // delays (list → connect → introspect → stream); on a loaded CI runner the
  // full "click a table → grid renders" chain can exceed Playwright's default
  // 5s assertion timeout, which surfaced as the intermittent "grid never
  // rendered" flake. Give assertions more headroom on CI — the app is fine,
  // the runner is just slow. (Per-test timeout scales up to match.)
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  timeout: process.env.CI ? 60_000 : 30_000,
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
