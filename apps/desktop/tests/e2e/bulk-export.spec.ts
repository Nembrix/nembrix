import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

/** Bulk-export the public schema via the File → Export menu. */
test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

/**
 * Open the bulk-export dialog through the command palette.
 *
 * Waits for the palette to actually narrow to the export action before
 * pressing Enter. Typing and immediately pressing Enter races the filter: on a
 * loaded CI runner the highlighted row can still be the pre-filter selection,
 * so Enter fires the wrong action and "Bulk export" never appears.
 */
async function openBulkExport(page: import("@playwright/test").Page) {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("export");
  // Enter fires whatever row is `.active`, so wait until the ACTIVE row is the
  // export one — not merely until an export row exists somewhere in the list.
  await expect(page.locator(".palette-row.active")).toContainText(/export/i);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Bulk export")).toBeVisible();
}

test("File → Export opens the bulk dialog with all tables checked", async ({ page }) => {
  // Use the palette so we don't depend on the menu's open-then-click sequence.
  await openBulkExport(page);
  const boxes = page.locator(".export-columns input[type='checkbox']");
  // Mock seeds 2 relations in public (users + orders).
  await expect(boxes).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(boxes.nth(i)).toBeChecked();
  }
});

test("running a bulk export in browser mode produces a combined download", async ({ page }) => {
  await openBulkExport(page);

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

test("Export is enabled without a destination folder", async ({ page }) => {
  // Regression: the button was gated on a folder being chosen, so in the
  // desktop app clicking it did nothing and gave no reason. It now stays
  // enabled and opens the folder picker on click (Tauri), and only a genuinely
  // unsatisfiable state — no tables selected — disables it.
  //
  // NOTE: this suite runs in browser mode (isTauri === false), where the folder
  // requirement never applied, so it cannot exercise the Tauri-only picker
  // branch. What it does pin is the disable rule: only an empty selection
  // disables Export, with a stated reason.
  await openBulkExport(page);

  const exportBtn = page.getByRole("button", { name: /^Export \d+ table/ });
  await expect(exportBtn).toBeEnabled();

  // Deselecting everything is the one state that should disable it.
  await page.getByRole("button", { name: "None" }).click();
  await expect(exportBtn).toBeDisabled();
  await expect(page.getByText("Select at least one table.")).toBeVisible();

  await page.getByRole("button", { name: "Select all" }).click();
  await expect(exportBtn).toBeEnabled();
});
