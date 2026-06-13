import { defineScene } from "../helpers";

export default defineScene({
  name: "preferences-csv",
  description: "Preferences dialog focused on the CSV section with a non-default NULL token.",
  async run({ page, shot }) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.waitForSelector("text=Preferences", { timeout: 3000 });
    // Touch the NULL token field so the focus ring shows.
    await page.fill("[id='pref-null']", "\\N");
    await page.waitForTimeout(150);
    await shot();
  },
});
