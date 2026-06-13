# Docs media (local-only)

Full-auto Playwright capture pipeline. **One command, no prep**:

```sh
yarn docs:media
```

What it does:

1. Spins up `postgres:16-alpine` as a testcontainer, applies `seed.sql`.
2. Boots the Node sidecar + Vite dev server (or attaches if they're
   already running — see the safety check below).
3. Injects a saved + connected connection into localStorage so every
   scene starts with the inspector already loaded.
4. Runs every `*.scene.ts`, screenshots → `apps/docs/public/media/`.
5. Tears down everything we started (including the testcontainer).

Requires: **Docker** running (Docker Desktop, OrbStack, Colima — any).
The pipeline auto-detects the active Docker context's socket so you
don't usually need `DOCKER_HOST`; set it explicitly to override.

This pipeline is **local-only**, never CI — the docs deploy
workflow only consumes already-committed PNGs.

## Where things live

| | |
| --- | --- |
| **Capture orchestrator** | `capture.ts` |
| **Helper API (`defineScene`)** | `helpers.ts` |
| **Coverage audit** | `audit.ts` |
| **Individual scenes** | `scenes/*.scene.ts` |
| **Output** | `apps/docs/public/media/<scene-name>.png` |
| **Astro reference** | `/media/<scene-name>.png` in MDX |

The orchestrator discovers every `*.scene.ts` automatically — no
registry to update.

## Daily loop

```sh
# 1. See what's missing
yarn docs:media:audit

# 2. Capture. The pipeline brings up its own stack — no yarn dev:all needed.
yarn docs:media                        # all scenes
yarn docs:media --only=filters         # one
yarn docs:media --only=filters,editor  # several
yarn docs:media --headed               # watch the browser
yarn docs:media --force-reuse          # reuse a running sidecar/vite (advanced)
```

If port 1420 or 1421 is already in use, the script refuses to run
unless you pass `--force-reuse` — without that safety check it would
silently screenshot against whatever DB your `yarn dev:all` is pointed
at.

## Authoring a scene

```ts
// scripts/docs/scenes/filters-empty.scene.ts
import { defineScene } from "../helpers";

export default defineScene({
  name: "filters-empty",
  description: "Filter builder expanded with one empty row.",
  // seed defaults to "connected" — the inspector loads with the seed
  // schema before run() fires.
  async run({ page, shot }) {
    await page.waitForSelector("text=orders", { timeout: 8000 });
    await page.click("text=orders");
    await page.click("button:has-text('Add filter')");
    await page.waitForTimeout(200);
    await shot();   // writes filters-empty.png
  },
});
```

The `seed` option controls the localStorage state the orchestrator
injects before navigation:

| `seed` | What's in localStorage | Use for |
| --- | --- | --- |
| `"connected"` (default) | Saved connection + open session | Most scenes |
| `"connection-only"` | Saved connection, no session | Recents landing, manage-connections demos |
| `"none"` | Empty | Empty landing, first-launch shots |

What the helper does for you:

- Reads the seed mode and the orchestrator sets up the right context
  init script (so localStorage is pre-populated before any app code
  reads it).
- Defaults the screenshot filename to the scene's `name`. Pass a
  string to `shot()` to override or capture multiple frames.

## Coverage audit

`yarn docs:media:audit` scans every MDX file for `/media/<name>.<ext>`
references and reports what's missing or orphaned. Exit code is
non-zero when anything is missing — useful as a pre-commit hook to
catch unreviewed doc additions.

## Pending scenes

See [`scenes/_TODO-db-dependent.md`](scenes/_TODO-db-dependent.md)
for the list of doc references still missing a scene file. Each one
is a short authoring task now that the pipeline handles boot + seed.

## Limitations

- **No videos** — punt for now. Playwright's `recordVideo: { dir }`
  can be wired into `SceneContext` later if we want walkthrough clips.
- **Browser-mode only** — no Tauri OS-window screenshots (titlebar,
  traffic lights). Grab those manually.
