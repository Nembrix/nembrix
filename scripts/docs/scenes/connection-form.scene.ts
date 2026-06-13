import { defineScene } from "../helpers";

export default defineScene({
  name: "connection-form",
  description: "New Connection dialog with realistic fields filled in.",
  async run({ page, shot }) {
    // File → New Connection…
    await page.locator(".menu-bar-item", { hasText: "File" }).click();
    await page.locator(".menu-item", { hasText: "New Connection" }).first().click();
    await page.waitForSelector("[id='cf-name']", { timeout: 5000 });
    await page.fill("[id='cf-name']",     "Acme Production");
    await page.fill("[id='cf-host']",     "db.acme.example");
    await page.fill("[id='cf-port']",     "5432");
    await page.fill("[id='cf-user']",     "shop");
    await page.fill("[id='cf-password']", "•••••••");
    await page.fill("[id='cf-database']", "shop");
    await page.waitForTimeout(200);
    await shot();
  },
});
