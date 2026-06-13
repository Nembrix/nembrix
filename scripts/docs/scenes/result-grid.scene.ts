import { defineScene, ensureSeedSchemaLoaded, openTableFromInspector } from "../helpers";

export default defineScene({
  name: "result-grid",
  description: "Data grid showing the seeded orders table.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);
    await openTableFromInspector(ctx, "orders");
    // Wait for rows to render. The toolbar shows "N rows" once they're
    // loaded — the row-count fetch may not have completed yet, so just
    // anchor on the simpler "N row(s)" pattern instead of "N of M".
    await page.waitForSelector("text=/\\d+ rows?/", { timeout: 12_000 });
    await page.waitForTimeout(400);
    await shot();
  },
});
