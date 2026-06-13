import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "analysis-hash-join",
  description: "Analysis pane after EXPLAIN ANALYZE on a join query.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    // Open a query tab and type a join.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+T" : "Control+T");
    await page.waitForSelector(".cm-content", { timeout: 6000 });
    // Focus + type. We aim a click at the editor area first to ensure
    // the keystrokes land there, then type slowly so the controlled
    // CodeMirror state has time to settle.
    await page.locator(".cm-content").click();
    await page.keyboard.type(
      "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.name LIMIT 10",
      { delay: 15 },
    );
    // CodeMirror's onChange is debounced — give it a beat to commit.
    await page.waitForTimeout(1200);
    // Switch to Analysis view → use plain EXPLAIN (faster, deterministic).
    await page.click("button:has-text('Analysis')");
    await page.waitForSelector(".analysis-toolbar", { timeout: 5000 });
    await page.getByRole("button", { name: /^EXPLAIN$/ }).first().click();
    await page.waitForSelector(".analysis-node-row", { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot();
  },
});
