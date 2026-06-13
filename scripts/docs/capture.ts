/**
 * Docs media capture — full-auto, LOCAL ONLY.
 *
 * One command, no prep:
 *   yarn docs:media
 *
 * What it does:
 *   1. Spins up a postgres:16-alpine testcontainer and applies seed.sql.
 *   2. Boots the Node sidecar + Vite dev server (or attaches if already
 *      running, with a safety check — see stack.ts).
 *   3. Launches Playwright with a context init script that injects a
 *      "saved + connected" connection into localStorage so every scene
 *      starts with the inspector loaded.
 *   4. Runs every scene under scripts/docs/scenes/*.scene.ts.
 *   5. Tears down the testcontainer (and any processes it owns).
 *
 * Why not CI? The screenshots depend on OS font rendering and exact
 * viewport sizing — pinning that in CI is more friction than it's
 * worth. The PNGs land in apps/docs/public/media/ and are committed.
 *
 * Useful flags:
 *   --only=filters,editor    only these scenes
 *   --headed                 watch the browser
 *   --force-reuse            reuse a running sidecar/vite without
 *                            the safety check (dangerous: screenshots
 *                            could come from the wrong DB)
 */

import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { startSeededPostgres, type DbHandle } from "./db";
import { startStack, type StackHandle } from "./stack";
import { seedScript } from "./inject";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES_DIR = join(__dirname, "scenes");
const OUT_DIR = join(__dirname, "..", "..", "apps", "docs", "public", "media");
const VIEWPORT = { width: 1440, height: 900 };

export type SeedMode = "connected" | "connection-only" | "none";

export interface SceneContext {
  page: Page;
  /** Write a PNG to apps/docs/public/media/<name>.png and log the path. */
  shot: (
    name: string,
    options?: { clip?: { x: number; y: number; width: number; height: number } },
  ) => Promise<void>;
  url: string;
}

export interface Scene {
  /** Filename slug used to match `--only=`. */
  name: string;
  /** Human-readable description shown in the run log. */
  description: string;
  /**
   * What state to seed before the scene runs:
   *   - "connected" (default): saved connection + open session,
   *     inspector loaded with seed schema.
   *   - "connection-only": saved connection, no open session
   *     (recents-landing, manage-connections demos).
   *   - "none": empty localStorage (empty-landing, fresh install).
   */
  seed?: SeedMode;
  /** The capture routine. Throw to fail loudly. */
  run: (ctx: SceneContext) => Promise<void>;
}

/* ─────────────────── CLI ─────────────────── */

const args = process.argv.slice(2);
const onlyFlag = args.find((a) => a.startsWith("--only="));
const onlyList = onlyFlag ? onlyFlag.replace("--only=", "").split(",") : null;
const headed = args.includes("--headed");
const forceReuse = args.includes("--force-reuse");

/* ─────────────────── main ─────────────────── */

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const scenes = await discoverScenes();
  if (scenes.length === 0) {
    console.warn("[capture] No scenes matched. Available:");
    console.warn(listSceneFiles().map((f) => "  " + f).join("\n"));
    process.exit(1);
  }
  console.log(`[capture] ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, output → ${OUT_DIR}`);

  let db: DbHandle | null = null;
  let stack: StackHandle | null = null;
  let browser: Browser | null = null;

  // Make double-sure we tear down everything even on Ctrl-C / crash.
  const teardown = async () => {
    if (browser) await browser.close().catch(() => { /* ignore */ });
    if (stack) await stack.stop().catch(() => { /* ignore */ });
    if (db) await db.stop().catch(() => { /* ignore */ });
  };
  process.on("SIGINT", async () => { await teardown(); process.exit(130); });
  process.on("SIGTERM", async () => { await teardown(); process.exit(143); });

  try {
    console.log("[capture] starting postgres testcontainer…");
    db = await startSeededPostgres();
    console.log(`[capture] postgres ready on ${db.host}:${db.port}`);

    console.log("[capture] starting stack…");
    stack = await startStack({ forceReuse });

    browser = await chromium.launch({ headless: !headed });

    const failures = await runScenes({ scenes, browser, db, viteUrl: stack.viteUrl });
    if (failures > 0) {
      console.error(`[capture] ${failures} scene${failures === 1 ? "" : "s"} failed.`);
      process.exitCode = 1;
    } else {
      console.log("[capture] done.");
    }
  } finally {
    await teardown();
  }
}

/* ─────────────────── scene discovery + execution ─────────────────── */

function listSceneFiles(): string[] {
  return readdirSync(SCENES_DIR).filter(
    (f) => f.endsWith(".scene.ts") || f.endsWith(".scene.js"),
  );
}

async function discoverScenes(): Promise<Scene[]> {
  const files = listSceneFiles();
  const scenes: Scene[] = [];
  for (const f of files) {
    const slug = basename(f).replace(/\.scene\.(ts|js)$/, "");
    if (onlyList && !onlyList.includes(slug)) continue;
    const mod = await import(join(SCENES_DIR, f));
    const scene: Scene = mod.default ?? mod.scene;
    if (!scene) {
      console.warn(`[capture] ${f} has no default export; skipping.`);
      continue;
    }
    scene.name = scene.name ?? slug;
    scenes.push(scene);
  }
  return scenes;
}

interface RunOpts {
  scenes: Scene[];
  browser: Browser;
  db: DbHandle;
  viteUrl: string;
}

async function runScenes(opts: RunOpts): Promise<number> {
  let failed = 0;
  // One context per seed mode — Playwright init scripts attach to a
  // context, not a page. Reusing contexts amortizes the boot cost.
  const contextsBySeed: Partial<Record<SeedMode, Page>> = {};

  const getPage = async (seed: SeedMode): Promise<Page> => {
    if (contextsBySeed[seed]) return contextsBySeed[seed]!;
    const context = await opts.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    if (seed !== "none") {
      await context.addInitScript({
        content: seedScript(opts.db, {
          connectionOnly: seed === "connection-only",
        }),
      });
    }
    const page = await context.newPage();
    contextsBySeed[seed] = page;
    return page;
  };

  for (const scene of opts.scenes) {
    process.stdout.write(`  · ${scene.name.padEnd(32)} `);
    try {
      const page = await getPage(scene.seed ?? "connected");
      const shot: SceneContext["shot"] = async (name, options) => {
        const path = join(OUT_DIR, `${name}.png`);
        await page.screenshot({ path, ...(options ?? {}) });
        process.stdout.write(`\n      → ${path.replace(OUT_DIR + "/", "media/")}`);
      };
      await scene.run({ page, shot, url: opts.viteUrl });
      process.stdout.write("\n      ✓ done\n");
    } catch (e) {
      failed++;
      process.stdout.write(`\n      ✗ ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return failed;
}

main().catch((e) => { console.error(e); process.exit(1); });
