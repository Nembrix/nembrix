import { defineScene } from "../helpers";

export default defineScene({
  name: "palette",
  description: "Command palette open with a partial query showing fuzzy matches.",
  async run({ page, shot }) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    await page.waitForSelector("[data-testid='palette-input'], input[placeholder*='Search']", { timeout: 3000 });
    await page.keyboard.type("new q");
    await page.waitForTimeout(200);
    await shot();
  },
});
