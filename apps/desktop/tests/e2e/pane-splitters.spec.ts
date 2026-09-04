import { test } from "@playwright/test";
import { expect } from "./_setup";

/**
 * The script console is a resizable pane below the results grid. It seeds a
 * tab with `lang: "script"` directly rather than driving the Lang selector —
 * the console's visibility keys off that field, and seeding keeps the spec
 * about resizing rather than about mode-switching.
 */
async function seedScriptTab(page: import("@playwright/test").Page) {
  const connId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const tabId = crypto.randomUUID();
  await page.addInitScript(
    ({ connId, sessionId, tabId }) => {
      if (localStorage.getItem("__seeded__")) return;
      localStorage.clear();
      localStorage.setItem("__seeded__", "1");
      const now = new Date(0).toISOString();
      localStorage.setItem(
        "nembrix.mock.connections",
        JSON.stringify([
          {
            id: connId,
            name: "Demo",
            engine: "postgres",
            host: "h",
            port: 5432,
            username: "u",
            database: "d",
            ssl_mode: "prefer",
            ssh: null,
            color: null,
            created_at: now,
            updated_at: now,
          },
        ]),
      );
      localStorage.setItem(
        "nembrix.tabs.v1",
        JSON.stringify({
          tabs: [
            {
              id: tabId,
              connId: sessionId,
              kind: "query",
              lang: "script",
              title: "Script",
              sql: "console.log('hi')",
            },
          ],
          activeTabId: tabId,
          selectedConnId: sessionId,
          sessions: [{ id: sessionId, connectionId: connId, openedAt: now }],
        }),
      );
    },
    { connId, sessionId, tabId },
  );
  await page.goto("/");
  await expect(page.locator(".script-console")).toBeVisible({ timeout: 15000 });
}

test("dragging the console splitter resizes it and persists", async ({ page }) => {
  await seedScriptTab(page);

  const consolePane = page.locator(".script-console");
  const before = (await consolePane.boundingBox())!.height;

  // Drag the handle UP by 120px — the console is the bottom pane, so up = taller.
  const split = page.locator("[data-testid='console-split']");
  const box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 8 });
  await page.mouse.up();

  const after = (await consolePane.boundingBox())!.height;
  expect(after).toBeGreaterThan(before + 80);

  // The size is stored as a percentage and rehydrated on reload.
  await page.reload();
  await expect(page.locator(".script-console")).toBeVisible({ timeout: 15000 });
  const persisted = (await page.locator(".script-console").boundingBox())!.height;
  expect(persisted).toBeGreaterThan(before + 80);
});

test("double-clicking the console splitter resets its height", async ({ page }) => {
  await seedScriptTab(page);

  const consolePane = page.locator(".script-console");
  const before = (await consolePane.boundingBox())!.height;

  const split = page.locator("[data-testid='console-split']");
  const box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 140, { steps: 6 });
  await page.mouse.up();
  expect((await consolePane.boundingBox())!.height).toBeGreaterThan(before + 90);

  await page.locator("[data-testid='console-split']").dblclick();
  const after = (await consolePane.boundingBox())!.height;
  expect(Math.abs(after - before)).toBeLessThan(24);
});

test("the console cannot be dragged past its bounds", async ({ page }) => {
  await seedScriptTab(page);

  const shell = page.locator(".result-shell");
  const shellBox = (await shell.boundingBox())!;
  const split = page.locator("[data-testid='console-split']");
  const box = (await split.boundingBox())!;

  // Yank far past the top of the shell — the 90% clamp must hold, leaving the
  // grid visible rather than letting the console swallow the whole pane.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, shellBox.y - 400, { steps: 10 });
  await page.mouse.up();

  const height = (await page.locator(".script-console").boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(shellBox.height * 0.92);
});

test("the inspector splitter still drags after the shared-style refactor", async ({ page }) => {
  // The inspector divider moved to the shared .pane-split treatment; this
  // guards that widening the hit area didn't break its drag or its layout.
  await seedScriptTab(page);

  const inspector = page.locator(".inspector-wrap");
  const before = (await inspector.boundingBox())!.width;

  const split = page.locator(".inspector-resize");
  const box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = (await inspector.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
});

test("every pane splitter shares one hit-area width", async ({ page }) => {
  // The point of the refactor: one grab target size everywhere. If a future
  // change reintroduces a bespoke splitter, this catches the drift.
  await seedScriptTab(page);

  const widths = await page.locator(".pane-split.is-horizontal").evaluateAll(
    (els) => els.map((el) => el.getBoundingClientRect().height),
  );
  expect(widths.length).toBeGreaterThanOrEqual(2); // editor split + console split
  for (const h of widths) expect(h).toBe(7);

  const vertical = await page.locator(".pane-split.is-vertical").evaluateAll(
    (els) => els.map((el) => el.getBoundingClientRect().width),
  );
  for (const w of vertical) expect(w).toBe(7);
});

test("hiding the results pane leaves a visible way to bring it back", async ({ page }) => {
  // Regression: ⌘2 unmounts the grid, the console AND the drag handle, so the
  // editor filled the whole tab with nothing to click. The toolbar now grows a
  // "Show Results" button whenever the pane is hidden.
  await seedScriptTab(page);
  await expect(page.locator(".script-console")).toBeVisible();

  await page.keyboard.press("Meta+2");
  await expect(page.locator(".script-console")).toHaveCount(0);
  await expect(page.locator(".pane-split.is-horizontal")).toHaveCount(0);

  const restore = page.locator("[data-testid='show-results']");
  await expect(restore).toBeVisible();
  await restore.click();

  await expect(page.locator(".script-console")).toBeVisible();
  // Two horizontal splitters in script mode: editor/results and results/console.
  await expect(page.locator(".pane-split.is-horizontal")).toHaveCount(2);
  // The button retires once the pane is back.
  await expect(restore).toHaveCount(0);
});

test("a hidden results pane survives a reload", async ({ page }) => {
  // Panel visibility used to reset on every reload, so an intentional layout
  // never survived a restart (the flip side of the bug that made an accidental
  // ⌘2 look permanent).
  await seedScriptTab(page);
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".script-console")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("[data-testid='show-results']")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".script-console")).toHaveCount(0);

  // And it can still be brought back after the reload.
  await page.locator("[data-testid='show-results']").click();
  await expect(page.locator(".script-console")).toBeVisible();
});

test("the View menu ticks the panels that are visible", async ({ page }) => {
  await seedScriptTab(page);

  const viewMenu = page.locator(".menu-bar-item", { hasText: "View" }).first();
  await viewMenu.click();
  const results = page.locator(".menu-item", { hasText: "Toggle Results Pane" });
  await expect(results).toHaveAttribute("aria-checked", "true");
  await results.click();

  await expect(page.locator(".script-console")).toHaveCount(0);
  await viewMenu.click();
  await expect(
    page.locator(".menu-item", { hasText: "Toggle Results Pane" }),
  ).toHaveAttribute("aria-checked", "false");
});
