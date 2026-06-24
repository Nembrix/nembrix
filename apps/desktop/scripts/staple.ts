/**
 * Post-build: notarize the .dmg (if needed) and staple the ticket
 * onto the signed .app and .dmg so Gatekeeper accepts them offline.
 *
 * Tauri's bundler signs the .app + .dmg and submits the .app to
 * notarytool, but it does NOT submit the .dmg. Stapling a DMG without
 * a per-DMG ticket fails with `Could not find base64 encoded ticket`
 * / error 65. So we submit the DMG ourselves when credentials are
 * available, then staple both.
 *
 * Required env (typically sourced from .env.signing):
 *   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID
 *
 * No-op on non-macOS — only the macOS bundler produces .app/.dmg.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(APP_ROOT, "target", "release", "bundle");

function staple(path: string): boolean {
  console.log(`→ Stapling ${path}`);
  const res = spawnSync("xcrun", ["stapler", "staple", path], {
    stdio: "inherit",
    shell: false,
  });
  if (res.status !== 0) {
    console.warn(`  ⚠ stapler exited ${res.status} — ticket may not be attached`);
    return false;
  }
  return true;
}

/** Submit an artifact to Apple's notarization service and block until
 *  it returns Accepted / Invalid / Rejected. Returns true on Accepted. */
function notarize(path: string): boolean {
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !password || !teamId) {
    console.warn(
      `  ⚠ skipping notarize (missing APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID) — staple will fail offline`,
    );
    return false;
  }
  console.log(`→ Submitting ${path} to notarytool…`);
  const res = spawnSync(
    "xcrun",
    [
      "notarytool", "submit", path,
      "--apple-id", appleId,
      "--password", password,
      "--team-id", teamId,
      "--wait",
    ],
    { stdio: "inherit", shell: false },
  );
  if (res.status !== 0) {
    console.warn(`  ⚠ notarytool exited ${res.status}`);
    return false;
  }
  return true;
}

function main(): void {
  if (process.platform !== "darwin") {
    console.log("[staple] skipping (non-macOS platform)");
    return;
  }
  if (!existsSync(BUNDLE_DIR)) {
    console.log("[staple] no bundle directory — nothing to staple");
    return;
  }

  // Staple the .app first (the inner thing), then the .dmg (which
  // wraps the .app). Stapling order matters: a stapled DMG holds
  // the ticket for offline launch *of the DMG*, but the .app inside
  // also needs its own staple for when the user has dragged it
  // to /Applications.
  let stapledAny = false;

  const appDir = join(BUNDLE_DIR, "macos");
  if (existsSync(appDir)) {
    for (const name of readdirSync(appDir)) {
      if (name.endsWith(".app")) {
        stapledAny = staple(join(appDir, name)) || stapledAny;
      }
    }
  }

  const dmgDir = join(BUNDLE_DIR, "dmg");
  if (existsSync(dmgDir)) {
    for (const name of readdirSync(dmgDir)) {
      if (!name.endsWith(".dmg")) continue;
      const dmgPath = join(dmgDir, name);
      // Try staple first — if the DMG was already notarized in a prior
      // run, this is a no-op. If it errors (typical: error 65 "ticket
      // not found"), submit to notarytool and re-staple.
      if (!staple(dmgPath)) {
        if (notarize(dmgPath)) {
          stapledAny = staple(dmgPath) || stapledAny;
        }
      } else {
        stapledAny = true;
      }
    }
  }

  if (!stapledAny) {
    console.log("[staple] no .app or .dmg artifacts found");
  } else {
    console.log("[staple] done.");
  }
}

main();
