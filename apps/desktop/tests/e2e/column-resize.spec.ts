import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const rec = {
      id: "00000000-0000-0000-0000-000000000666",
      name: "Demo", engine: "postgres",
      host: "h", port: 5432, username: "u",
      database: "d", ssl_mode: "prefer", ssh: null, color: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem("nembrix.mock.connections", JSON.stringify([rec]));
  });
  await page.reload();
  await page.locator(".rail-avatar").first().click();
  await page.locator("[data-testid='connect-btn']").click();
  await page.getByText("orders").dblclick();
  await expect(page.locator(".grid-scroll table.grid-header")).toBeVisible();
});

test("dragging the resize grip widens the column and persists", async ({ page }) => {
  // Grab the `id` column header's grip and drag it 120px to the right.
  const header = page.locator(".grid-header th").nth(1); // skip gutter <th>
  const beforeBox = await header.boundingBox();
  expect(beforeBox).not.toBeNull();
  const grip = header.locator(".col-resize-grip");
  const gripBox = await grip.boundingBox();
  expect(gripBox).not.toBeNull();

  await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox!.x + gripBox!.width / 2 + 120, gripBox!.y + gripBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  const afterBox = await header.boundingBox();
  expect(afterBox).not.toBeNull();
  // Width grew by ~120 px.
  expect(afterBox!.width).toBeGreaterThan(beforeBox!.width + 80);

  // Reload — the tab persistence will restore the data view automatically.
  await page.reload();
  await expect(page.locator(".grid-scroll table.grid-header")).toBeVisible();

  const header2 = page.locator(".grid-header th").nth(1);
  const persistedBox = await header2.boundingBox();
  expect(persistedBox).not.toBeNull();
  expect(persistedBox!.width).toBeGreaterThan(beforeBox!.width + 80);
});

test("double-clicking the resize grip resets the column to its sampled width", async ({ page }) => {
  const header = page.locator(".grid-header th").nth(1);
  const before = (await header.boundingBox())!.width;

  // Make it wider first
  const grip = header.locator(".col-resize-grip");
  const gripBox = (await grip.boundingBox())!;
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 150, gripBox.y + gripBox.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await header.boundingBox())!.width).toBeGreaterThan(before + 100);

  // Double-click resets — find the (now displaced) grip on the same header.
  const grip2 = header.locator(".col-resize-grip");
  await grip2.dblclick();
  const after = (await header.boundingBox())!.width;
  // Back to (or near) the sampled width.
  expect(Math.abs(after - before)).toBeLessThan(20);
});
