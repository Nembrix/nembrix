import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "roles-grant-tree",
  description: "Roles tab with the grant matrix expanded for a role.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "Manage Roles" }).click();
    await page.waitForSelector(".roles-shell", { timeout: 8000 });
    await page.waitForTimeout(1200);
    // Click the first role row to bring its grant matrix into focus.
    const firstRole = page.locator(".roles-sidebar .item-row, .roles-sidebar .role-row").first();
    if (await firstRole.count()) await firstRole.click();
    await page.waitForTimeout(800);
    await shot();
  },
});
