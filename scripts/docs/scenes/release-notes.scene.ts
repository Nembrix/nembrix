import { defineScene } from "../helpers";

/**
 * Placeholder scene — the release-notes doc page is itself a placeholder
 * until the first tagged release. We just snapshot the empty landing
 * because the doc page only references an image for visual rhythm.
 */
export default defineScene({
  name: "release-notes",
  description: "Placeholder shot for the (currently empty) release-notes page.",
  seed: "none",
  async run({ page, shot }) {
    await page.waitForSelector("text=No recent connections yet", { timeout: 5000 });
    await shot();
  },
});
