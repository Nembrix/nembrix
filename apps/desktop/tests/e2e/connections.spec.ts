import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("renders the three-column shell empty-state", async ({ page }) => {
  // Rail visible (its 'add' button is a Plus icon)
  await expect(page.locator(".rail")).toBeVisible();
  // Inspector empty-state
  await expect(page.getByText(/Select a connection on the left/i)).toBeVisible();
  // Main empty-state
  await expect(page.getByText(/Select a connection on the rail to begin/i)).toBeVisible();
});

test("opens the connection form via the rail + button", async ({ page }) => {
  await page.locator(".rail-add").click();
  await expect(page.getByText(/new postgresql connection/i)).toBeVisible();

  await page.getByLabel("Name").fill("Localhost");
  await page.getByLabel("Host").fill("127.0.0.1");
  await page.getByLabel("Port").fill("5432");
  await page.getByLabel("User").fill("postgres");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByLabel("Database").fill("postgres");

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText(/OK · \d+ ms/)).toBeVisible();

  await page.getByRole("button", { name: "Save" }).click();
  // After save the rail has one avatar tile.
  await expect(page.locator(".rail-avatar")).toHaveCount(1);
});

test("rail shows the connection name and database under each avatar", async ({ page }) => {
  await page.evaluate(() => {
    const rec = {
      id: "00000000-0000-0000-0000-0000000000aa",
      name: "Demo",
      engine: "postgres",
      host: "h", port: 5432, username: "u",
      database: "demo_db", ssl_mode: "prefer", ssh: null, color: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem("nembrix.mock.connections", JSON.stringify([rec]));
  });
  await page.reload();

  const entry = page.locator(".rail-entry").first();
  await expect(entry.locator(".rail-name")).toHaveText("Demo");
  await expect(entry.locator(".rail-db")).toHaveText("demo_db");
});

test("selecting a connection populates the inspector and status pill", async ({ page }) => {
  await page.evaluate(() => {
    const rec = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Demo",
      engine: "postgres",
      host: "127.0.0.1", port: 5432, username: "demo",
      database: "demo", ssl_mode: "prefer", ssh: null, color: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem("nembrix.mock.connections", JSON.stringify([rec]));
  });
  await page.reload();

  await page.locator(".rail-avatar").first().click();
  // The status pill's name segment is uppercased; scoping to .status-pill avoids
  // matching the rail label "Demo" or the lowercase database name.
  await expect(page.locator(".status-pill .name")).toHaveText("DEMO");

  // Connect via the lock icon in the status bar.
  await page.locator("[data-testid='connect-btn']").click();
  // Inspector now shows the Tables group.
  await expect(page.getByText("Tables")).toBeVisible();

  // Double-click `users` opens the pure-GUI data view, which auto-loads.
  await page.getByText("users").dblclick();
  // Wait for the grid to render rows. The grid now uses one table per
  // virtual row, so we check the scroll container's text content.
  await expect(page.locator(".grid-scroll")).toContainText("alice@example.com");
  await expect(page.locator(".grid-scroll")).toContainText("bob@example.com");
});

test("Beautify uppercases SQL keywords", async ({ page }) => {
  await page.evaluate(() => {
    const rec = {
      id: "00000000-0000-0000-0000-000000000002",
      name: "Demo",
      engine: "postgres",
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
