import { defineScene } from "../helpers";

export default defineScene({
  name: "about-dialog",
  description: "About Nembrix dialog opened from Help → About.",
  async run(ctx) {
    const { page, shot } = ctx;
    await page.locator(".menu-bar-item", { hasText: "Help" }).click();
    await page.locator(".menu-item", { hasText: "About Nembrix" }).click();
    await page.waitForSelector(".about-modal", { timeout: 5000 });
    await page.waitForTimeout(200);
    await shot();
  },
});
