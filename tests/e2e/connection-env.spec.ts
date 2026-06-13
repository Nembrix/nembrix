import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("saving a connection with environment=Production tints the rail ring red", async ({ page }) => {
  await page.locator(".rail-add").click();
  await expect(page.getByText(/new postgresql connection/i)).toBeVisible();

  await page.getByLabel("Name").fill("Prod DB");
  await page.getByLabel("Host").fill("prod.example.com");
  await page.getByLabel("Port").fill("5432");
  await page.getByLabel("User").fill("app");
  await page.getByLabel("Password").fill("secret");
  await page.getByLabel("Database").fill("app");

  // Env field
  await page.locator("#cf-env").selectOption("production");

  await page.getByRole("button", { name: "Save" }).click();

  // Rail entry has is-prod class + a PROD pill underneath.
  await expect(page.locator(".rail-entry.is-prod")).toHaveCount(1);
  await expect(page.locator(".rail-env", { hasText: "PRODUCTION" })).toBeVisible();
});

test("env preset color updates when the environment changes", async ({ page }) => {
  await page.locator(".rail-add").click();
  await page.locator("#cf-env").selectOption("production");
  // The first swatch (production red) should be selected.
  await expect(page.locator(".env-swatch.selected").first()).toBeVisible();
  const selected = await page.locator(".env-swatch.selected").evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  // rgb(239, 68, 68) is #ef4444 — the production preset.
  expect(selected).toBe("rgb(239, 68, 68)");
});

test("SSH key file picker reads the chosen file into key_data (browser mode)", async ({ page }) => {
  await page.locator(".rail-add").click();
  await page.locator("#cf-ssh").check();
  await page.locator("#cf-ssh-auth").selectOption("key_file");

  // Write a temp file we can hand to the hidden input.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dbclient-e2e-"));
  const keyFile = path.join(tmpDir, "id_rsa");
  await fs.writeFile(keyFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake content\n-----END OPENSSH PRIVATE KEY-----\n", "utf8");

  // Set the hidden <input type="file"> directly.
  await page.locator("[data-testid='ssh-key-input']").setInputFiles(keyFile);

  await expect(page.locator(".ssh-key-summary"))
    .toContainText(/id_rsa · \d+ bytes attached/);
});
