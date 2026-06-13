import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "roles",
  description: "Roles tab listing pg_roles with the postgres role auto-selected.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await page.locator(".menu-bar-item", { hasText: "Database" }).click();
    await page.locator(".menu-item", { hasText: "Manage Roles" }).click();
    await page.waitForSelector(".roles-shell", { timeout: 8000 });
    // Let the roles list populate from pg_roles.
    await page.waitForTimeout(1200);
    await shot();
  },
});
