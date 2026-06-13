import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "editor",
  description: "SQL editor with a partial query showing schema-aware autocomplete.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // ⌘T opens a new query tab — the binding is in menu/accelerators.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+T" : "Control+T");
    // CodeMirror gets a `.cm-content` div once it mounts.
    await page.waitForSelector(".cm-content", { timeout: 6000 });
    // Type something that should trigger column-name autocomplete.
    await page.locator(".cm-content").click();
    await page.keyboard.type("SELECT  FROM orders WHERE ", { delay: 30 });
    await page.waitForTimeout(400);
    await shot();
  },
});
