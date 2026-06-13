import { defineScene } from "../helpers";

export default defineScene({
  name: "keyboard-shortcuts",
  description: "The Shortcuts modal listing every binding by area.",
  async run({ page, shot }) {
    // No keyboard shortcut for the shortcuts modal — go via Help menu.
    await page.locator(".menu-bar-item", { hasText: "Help" }).click();
    await page.locator(".menu-item", { hasText: "Keyboard Shortcuts" }).click();
    await page.waitForSelector("text=Keyboard shortcuts", { timeout: 5000 });
    await page.waitForTimeout(200);
    await shot();
  },
});
