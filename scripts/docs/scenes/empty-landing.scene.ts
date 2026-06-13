import { defineScene } from "../helpers";

export default defineScene({
  name: "empty-landing",
  description: "Empty rail, no recent connections, fresh-install state.",
  seed: "none",
  async run({ page, shot }) {
    await page.waitForSelector("text=No recent connections yet", { timeout: 5000 });
    await shot();
  },
});
