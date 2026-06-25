import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

async function openImport(page: import("@playwright/test").Page) {
  // The fly-down File menu is fiddly under Playwright — go through the
  // command palette which uses the same dispatcher.
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("Import");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal-header", { hasText: "Import" })).toBeVisible();
}

test("auto-detects CSV format from the file extension and renders the column mapping", async ({ page }) => {
  await openImport(page);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dbclient-import-"));
  const csv = path.join(tmp, "users.csv");
  await fs.writeFile(csv, "id,email,name\n1,alice@x.com,Alice\n2,bob@x.com,Bob\n", "utf8");
  await page.locator("[data-testid='import-file']").setInputFiles(csv);

  // Format auto-detected as CSV.
  await expect(page.locator(".segmented button.active", { hasText: "CSV" })).toBeVisible();

  // Wait for the target picker to populate, then choose users.
  const targetSel = page.locator(".modal-body select").filter({
    has: page.locator("option", { hasText: "users" }),
  }).first();
  await targetSel.selectOption("users");

  // Column mapping table renders three rows.
  await expect(page.locator("table.import-mapping tbody tr")).toHaveCount(3);
  // Auto-mapping picks identical names where they match.
  await expect(page.locator("[data-testid='map-0']")).toHaveValue("id");
  await expect(page.locator("[data-testid='map-1']")).toHaveValue("email");
  await expect(page.locator("[data-testid='map-2']")).toHaveValue("name");

  await expect(page.getByText("2 rows parsed")).toBeVisible();
});

test("Skip-on-conflict mode shows the conflict key dropdown defaulting to the PK", async ({ page }) => {
  await openImport(page);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dbclient-import-"));
  const csv = path.join(tmp, "users.csv");
  await fs.writeFile(csv, "id,email,name\n1,alice@x.com,Alice\n", "utf8");
  await page.locator("[data-testid='import-file']").setInputFiles(csv);
  const targetSel = page.locator(".modal-body select").filter({
    has: page.locator("option", { hasText: "users" }),
  }).first();
  await targetSel.selectOption("users");

  // Conflict mode dropdown is the one whose options include the stop/skip/update labels.
  const modeSel = page.locator(".modal-body select").filter({
    has: page.locator("option", { hasText: "Skip on conflict" }),
  }).first();
  await modeSel.selectOption("skip");

  // Conflict key dropdown appears with the PK preselected.
  const keySelect = page.locator("[data-testid='conflict-key']");
  await expect(keySelect).toBeVisible();
  await expect(keySelect).toHaveValue("id");
});

test("a CSV row with no mapped columns blocks the Import button until something maps", async ({ page }) => {
  await openImport(page);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dbclient-import-"));
  const csv = path.join(tmp, "z.csv");
  await fs.writeFile(csv, "x,y\n1,2\n", "utf8");
  await page.locator("[data-testid='import-file']").setInputFiles(csv);

  // No mapped columns yet (no target table picked).
  const importBtn = page.getByRole("button", { name: "Import", exact: true });
  await expect(importBtn).toBeDisabled();
});
