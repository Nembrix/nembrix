import { defineScene, ensureSeedSchemaLoaded } from "../helpers";

export default defineScene({
  name: "scripting",
  description:
    "JavaScript scripting mode: a db.query loop with console.log, results in the grid.",
  async run(ctx) {
    const { page, shot } = ctx;
    await ensureSeedSchemaLoaded(ctx);

    // New query tab.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+T" : "Control+T");
    await page.waitForSelector(".cm-content", { timeout: 6000 });

    // Flip the language toggle SQL → JavaScript (the select with a "script"
    // option; it only renders for SQL engines, which the seed connection is).
    const langSelect = page.locator('select:has(option[value="script"])');
    await langSelect.selectOption("script");
    await page.waitForTimeout(300);

    // Type a representative script: parameterized query + loop + log.
    await page.locator(".cm-content").click();
    await page.keyboard.type(
      [
        'const users = await db.query(',
        '  "SELECT id, name FROM users WHERE id > $1",',
        '  [0],',
        ');',
        'for (const u of users) {',
        '  console.log(`user ${u.id}: ${u.name}`);',
        '}',
        'return users;',
      ].join("\n"),
      { delay: 8 },
    );
    await page.waitForTimeout(300);
    await shot();
  },
});
