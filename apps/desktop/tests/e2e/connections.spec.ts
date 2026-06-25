import { test } from "@playwright/test";
import { expect, seedConnectedSession, seedEmpty } from "./_setup";

test("renders the three-column shell empty-state", async ({ page }) => {
  await seedEmpty(page);
  // Rail visible (its 'add' button is a Plus icon)
  await expect(page.locator(".rail")).toBeVisible();
  // Inspector empty-state
  await expect(page.getByText(/Select a connection on the left/i)).toBeVisible();
  // Main empty-state
  await expect(page.getByText(/No connection selected/i)).toBeVisible();
});

test("opens the connection form via the rail + button", async ({ page }) => {
  await seedEmpty(page);
  // `.rail-add` matches both the new-connection (+) and manage tiles; the
  // first is the new-connection button.
  await page.locator(".rail-add").first().click();
  await expect(page.getByText(/new postgresql connection/i)).toBeVisible();

  await page.getByLabel("Name").fill("Localhost");
  await page.getByLabel("Host").fill("127.0.0.1");
  await page.getByLabel("Port").fill("5432");
  await page.getByLabel("User").fill("postgres");
  await page.getByLabel("Password").fill("hunter2");
  // `getByLabel("Database")` also matches the engine <select>; target the input.
  await page.locator("#cf-database").fill("postgres");

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText(/OK · \d+ ms/)).toBeVisible();

  // "Save" only persists the connection; the rail renders *sessions*, so use
  // "Connect" (save + open session + connect) to make a rail avatar appear.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // After save+connect the rail has one avatar tile.
  await expect(page.locator(".rail-avatar")).toHaveCount(1);
});

test("rail shows the connection name and database under each avatar", async ({ page }) => {
  await seedConnectedSession(page, { name: "Demo", database: "demo_db", connect: false });

  const entry = page.locator(".rail-entry").first();
  await expect(entry.locator(".rail-name")).toHaveText("Demo");
  await expect(entry.locator(".rail-db")).toHaveText("demo_db");
});

test("selecting a connection populates the inspector and status pill", async ({ page }) => {
  // Seed the session but don't auto-connect — this test clicks connect itself.
  await seedConnectedSession(page, { name: "Demo", database: "demo", connect: false });

  // The status pill reflects the selected connection — it surfaces the engine
  // and database. Scope to .status-pill to avoid matching the rail label.
  await expect(page.locator(".status-pill .pill-db")).toHaveText("demo");

  // Connect via the lock icon in the status bar.
  await page.locator("[data-testid='connect-btn']").click();
  // Inspector now shows the Tables group. Use exact to avoid matching the
  // "public · 2 tables" schema summary line.
  await expect(page.getByText("Tables", { exact: true })).toBeVisible();

  // Double-click `users` in the inspector list opens the pure-GUI data view,
  // which auto-loads. Scope to .item-row so we don't match the empty-tab card.
  await page.locator(".inspector-list .item-row", { hasText: "users" }).dblclick();
  // Wait for the grid to render rows. The grid now uses one table per
  // virtual row, so we check the scroll container's text content.
  await expect(page.locator(".grid-scroll")).toContainText("alice@example.com");
  await expect(page.locator(".grid-scroll")).toContainText("bob@example.com");
});

test("Beautify uppercases SQL keywords", async ({ page }) => {
  await seedConnectedSession(page, { name: "Demo" });

  // The inspector exposes a "New query" + button directly — use that
  // (Chromium intercepts ⌘T for new tab).
  await page.locator("[data-testid='new-query-btn']").click();

  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("select * from users where id = 1;");
  await page.getByRole("button", { name: /Beautify/ }).click();
  await expect(editor).toContainText("SELECT * FROM users WHERE id = 1;");
});
