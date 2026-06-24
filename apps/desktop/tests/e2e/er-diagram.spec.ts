import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000ccc",
      name: "Demo", engine: "postgres",
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
});

async function openErTab(page: import("@playwright/test").Page) {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await page.keyboard.type("ER diagram");
  await page.keyboard.press("Enter");
  await expect(page.locator("svg.er-canvas")).toBeVisible();
}

test("ER tab opens with a node per table and an edge for each FK", async ({ page }) => {
  await openErTab(page);

  // The mock schema seeds public.users + public.orders with one FK orders → users.
  await expect(page.locator(".er-node")).toHaveCount(2);
  await expect(page.locator(".er-edge")).toHaveCount(1);
  // Header text on each node should show the qualified name.
  await expect(page.locator(".er-node-title", { hasText: "users" })).toBeVisible();
  await expect(page.locator(".er-node-title", { hasText: "orders" })).toBeVisible();
});

test("Reset layout button clears persisted positions and re-relaxes", async ({ page }) => {
  await openErTab(page);
  // Seed a fake "pinned" position so Reset has something to clear.
  await page.evaluate(() => {
    localStorage.setItem("nembrix.er.positions", JSON.stringify({
      ["00000000-0000-0000-0000-000000000ccc:public"]: { "users": { x: 999, y: 999 } },
    }));
  });
  await page.getByRole("button", { name: /Reset layout/ }).click();
  // After reset, the persisted entry should be gone.
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("nembrix.er.positions") || "{}"));
  expect(persisted["00000000-0000-0000-0000-000000000ccc:public"] ?? {}).toEqual({});
});

test("hovering a node highlights it and its connected edges", async ({ page }) => {
  await openErTab(page);
  await page.locator(".er-node", { hasText: "orders" }).hover();
  // The connected edge should pick up the "hot" class.
  await expect(page.locator(".er-edge.hot")).toHaveCount(1);
});
