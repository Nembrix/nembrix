/**
 * Helpers for docs media scenes.
 *
 * The goals here are tiny:
 *   - Make the boilerplate (boot, reset storage, navigate) one line.
 *   - Encourage a single image per scene by default — multi-shot scenes
 *     are fine when you actually want to demonstrate a flow, but the
 *     default API steers you toward one PNG per scene.
 *
 * Authoring rule of thumb: the scene's `name` IS the image filename when
 * you only call `shot()` with no arg. So:
 *
 *   defineScene({
 *     name: "filters-empty",   // → media/filters-empty.png
 *     async run({ shot }) {
 *       …drive the UI…
 *       await shot();          // writes filters-empty.png
 *     },
 *   });
 */

import type { Scene, SceneContext, SeedMode } from "./capture";

export interface SceneBuilderContext extends SceneContext {
  /** Like `shot()` but defaults the filename to the scene's name. */
  shot: (name?: string, options?: Parameters<SceneContext["shot"]>[1]) => Promise<void>;
}

export interface DefineSceneOpts {
  /** Slug used for the filename + `--only=` matching. */
  name: string;
  /** One-line summary shown in the run log. */
  description: string;
  /**
   * What localStorage state the capture orchestrator should inject
   * before this scene runs. Defaults to "connected":
   *
   *   - "connected" (default): saved connection + open session — the
   *     inspector loads with the seed schema visible.
   *   - "connection-only": saved connection but no session — for shots
   *     that demo "you have connections, none open" (recents-landing).
   *   - "none": empty localStorage — for first-launch / empty-state shots.
   */
  seed?: SeedMode;
  /**
   * URL path to navigate to before `run()` fires. Defaults to "/". The
   * capture orchestrator handles the dev-server base URL.
   */
  path?: string;
  /**
   * Body. Use the `page` Playwright handle plus the `shot()` helper that
   * defaults to writing `<scene-name>.png`.
   */
  run: (ctx: SceneBuilderContext) => Promise<void>;
}

/**
 * Wrap a scene definition with the default boilerplate. The exported
 * `Scene` is what the capture orchestrator consumes.
 */
export function defineScene(opts: DefineSceneOpts): Scene {
  return {
    name: opts.name,
    description: opts.description,
    seed: opts.seed ?? "connected",
    async run(ctx) {
      const { page } = ctx;
      const path = opts.path ?? "/";
      // The orchestrator's context init script already seeded
      // localStorage with whatever the `seed` mode asked for. Just
      // navigate — the app will pick up the values on first read.
      await page.goto(joinUrl(ctx.url, path));
      // Default shot() filename = scene name.
      await opts.run({
        ...ctx,
        shot: async (name, options) => ctx.shot(name ?? opts.name, options),
      });
    },
  };
}

function joinUrl(base: string, path: string): string {
  if (!path || path === "/") return base;
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

/* ─────────────────── small interaction helpers ─────────────────── */

/**
 * Wait until a stable amount of time has passed with no DOM mutations.
 * Useful right before screenshotting — Playwright's networkidle only
 * catches network activity, not React re-renders.
 */
export async function settle(ctx: SceneContext, ms = 200): Promise<void> {
  // Fall back to a fixed sleep if requestIdleCallback isn't around.
  await ctx.page.waitForTimeout(ms);
}

/**
 * Click an element by visible text. Equivalent to `page.click(text=…)`
 * but with a friendlier error when nothing matches.
 */
export async function clickText(ctx: SceneContext, text: string): Promise<void> {
  const locator = ctx.page.getByText(text, { exact: false });
  await locator.first().click({ timeout: 5000 });
}

/**
 * Ensure the seeded session is connected and its schema is loaded
 * before the scene tries to interact with the inspector. The seed
 * script writes a session to localStorage, but the auto-reconnect
 * path in persist.ts can be slow or fail silently, so we manually
 * click the rail avatar as a fallback and wait for a known table
 * name to appear.
 */
export async function ensureSeedSchemaLoaded(
  ctx: SceneContext,
  opts: { firstTable?: string; timeoutMs?: number } = {},
): Promise<void> {
  const firstTable = opts.firstTable ?? "orders";
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const { page } = ctx;

  // Fast path — the auto-reconnect already populated the inspector.
  try {
    await page.waitForSelector(`text=${firstTable}`, { timeout: 1500 });
    return;
  } catch { /* fall through to manual connect */ }

  // Slow path — click the rail's first avatar to force a connect, then
  // wait again. The rail avatar is a `.rail-entry` element.
  const avatar = page.locator(".rail-entry").first();
  if (await avatar.count() > 0) {
    await avatar.click();
    // The schema may still be loading; the inspector renders once
    // introspect() completes.
    await page.waitForSelector(`text=${firstTable}`, { timeout: timeoutMs });
    return;
  }

  // Last resort — wait longer, in case the auto-reconnect is just slow.
  await page.waitForSelector(`text=${firstTable}`, { timeout: timeoutMs });
}

/**
 * Open a table from the inspector. Inspector rows fire on
 * **double-click**, not single click — anchoring on `.item-row` keeps
 * us from matching the same text in the EmptyTabArea cards.
 */
export async function openTableFromInspector(
  ctx: SceneContext,
  tableName: string,
): Promise<void> {
  await ctx.page
    .locator(".item-row", { hasText: tableName })
    .first()
    .dblclick();
}
