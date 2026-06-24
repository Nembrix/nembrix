/**
 * List the shippable bundles produced by `cargo tauri build`.
 *
 * Tauri scatters .dmg / .msi / .deb / .AppImage / .app across several
 * subdirectories of `target/release/bundle/` depending on platform.
 * This script just walks that tree, picks the ones a user would
 * actually double-click, and prints them with sizes so you don't
 * have to hunt for the artifact after a build.
 *
 * Invoked from the desktop workspace, so cwd is apps/desktop/ and
 * target/ is right there.
 */
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve relative to the script's own location, so the script works
// regardless of where yarn was invoked from. apps/desktop is one
// level up from apps/desktop/scripts.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(APP_ROOT, "target", "release", "bundle");
const SHIPPABLE = [".dmg", ".msi", ".exe", ".deb", ".AppImage", ".rpm", ".app"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // .app is a directory on macOS but it's a shippable artifact —
    // surface it without recursing into it.
    if (SHIPPABLE.some((ext) => e.name.endsWith(ext))) out.push(p);
    else if (e.isDirectory()) out.push(...await walk(p));
  }
  return out;
}

async function main(): Promise<void> {
  console.log("\nBuild artifacts:");
  if (!existsSync(BUNDLE_DIR)) {
    console.log("  (no bundle directory — has `cargo tauri build` run?)");
    return;
  }
  const found = await walk(BUNDLE_DIR);
  if (found.length === 0) {
    console.log("  (no shippable bundles found)");
    return;
  }
  for (const f of found) {
    const s = await stat(f);
    const rel = f.replace(process.cwd() + "/", "");
    console.log(`  ${rel}  (${formatBytes(s.size)})`);
  }
  console.log("\nLocal builds are NOT signed — Gatekeeper / SmartScreen will warn on first launch.");
}

main().catch((e) => {
  console.error(`print-bundles failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
