import { defineScene } from "../helpers";

export default defineScene({
  name: "connection-manager-groups",
  description: "Manage Connections dialog showing groups with the seeded 'Local dev' group + live indicator.",
  async run({ page, shot }) {
    // ⌘⇧L is the binding for Manage Connections — see src/menu/accelerators.ts
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+L" : "Control+Shift+L");
    await page.waitForSelector("text=LOCAL DEV", { timeout: 5000 });
    await page.waitForTimeout(200);
    await shot();
  },
});
