import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "er-diagram-highlight",
  description: "ER diagram with the orders table hovered, highlighting its neighbors (users, order_items).",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "ER Diagram" }).click();
    await page.waitForSelector(".er-canvas .er-node", { timeout: 8000 });
    await page.locator("button", { hasText: "Reset layout" }).click();
    await page.waitForTimeout(1500);
    await page.locator("button", { hasText: "Fit" }).click();
    await page.waitForTimeout(500);
    // Hover the orders node — its title text is the table name. The
    // group's onMouseEnter handler sets the highlight state, which dims
    // every other node and turns the orders → users / order_items edges
    // into the "hot" style.
    const ordersNode = page.locator(".er-node", { hasText: "orders" }).first();
    await ordersNode.hover();
    await page.waitForTimeout(400);
    await shot();
  },
});
