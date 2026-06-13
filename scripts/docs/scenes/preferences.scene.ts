import { defineScene } from "../helpers";

export default defineScene({
  name: "preferences",
  description: "Preferences dialog with CSV defaults section visible.",
  async run({ page, shot }) {
    // Open via the shortcut so we don't depend on a particular menu path.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.waitForSelector("text=Preferences", { timeout: 3000 });
    await page.waitForTimeout(150);
    await shot();
  },
});
