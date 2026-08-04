import { test } from "@playwright/test";
import { expect, seedConnectedSession } from "./_setup";

test.beforeEach(async ({ page }) => {
  await seedConnectedSession(page);
});

async function openErTab(page: import("@playwright/test").Page) {
  await page.locator(".menu-bar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: /Command Palette/ }).click();
  await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
  await page.keyboard.type("ER diagram");
  // Wait for the filtered result before committing — pressing Enter on a
  // not-yet-filtered list selects the wrong (or no) action.
  await expect(page.locator(".palette-row").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("svg.er-canvas")).toBeVisible({ timeout: 15000 });
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
  // The ER tab keys saved layouts by `${tab.connId}:${schemaName}`, where
  // `tab.connId` is the active session id. Derive the scope from the live
  // store so this stays correct regardless of the seeded ids.
  const scope = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("nembrix.tabs.v1") || "{}");
    return `${store.selectedConnId}:public`;
  });
  // Seed a fake "pinned" position so Reset has something to clear.
  await page.evaluate((scope) => {
    localStorage.setItem("nembrix.er.positions", JSON.stringify({
      [scope]: { "users": { x: 999, y: 999 } },
    }));
  }, scope);
  await page.getByRole("button", { name: /Reset layout/ }).click();
  // After reset, the persisted entry should be gone.
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("nembrix.er.positions") || "{}"));
  expect(persisted[scope] ?? {}).toEqual({});
});

test("hovering a node highlights it and its connected edges", async ({ page }) => {
  await openErTab(page);
  // Scope the node by its title text, then hover the enclosing <g>.
  // (Filtering an SVG <g> directly by hasText is unreliable.)
  await page
    .locator(".er-node")
    .filter({ has: page.locator(".er-node-title", { hasText: "orders" }) })
    .hover();
  // The connected edge should pick up the "hot" class.
  await expect(page.locator(".er-edge.hot")).toHaveCount(1);
});
