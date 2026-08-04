/**
 * Dry-run a release locally. Produces signed-or-unsigned bundles and a
 * release manifest that mirrors what CI would attach to a GitHub
 * release — but doesn't touch git, doesn't push, doesn't upload.
 *
 * Use when you want to validate:
 *   - The version bump in tauri.conf.json + Cargo.toml + package.json
 *     is consistent (we already enforce this in scripts/bump-version.ts,
 *     but this confirms nothing drifted between bumps).
 *   - The full build pipeline produces all expected artifacts.
 *   - File sizes are sensible (sudden ~50MB bumps usually mean a debug
 *     binary slipped into release).
 *   - The Homebrew cask template renders correctly with placeholder
 *     substitution.
 *
 * What gets produced (in `dist-release/<version>/`):
 *   - All bundle artifacts copied out of src-tauri/target/release/bundle
 *   - `nembrix.rb` — rendered cask template with placeholders filled
 *     (you can copy this into the tap repo to test installs)
 *   - `manifest.json` — version + per-file SHA-256 + sizes
 *   - `RELEASE_NOTES.draft.md` — git log between HEAD and the previous
 *     git tag, formatted as a release-notes draft
 *
 * Flags:
 *   --skip-build    Reuse an existing release build (faster iteration
 *                   on the post-build packaging)
 *   --version <v>   Override the version (otherwise reads from
 *                   package.json)
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve relative to the script's own file so it works no matter
// where yarn was invoked from. Script lives at apps/desktop/scripts/.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(APP_ROOT, "..", "..");
const BUNDLE_DIR = join(APP_ROOT, "target", "release", "bundle");
const CASK_TEMPLATE = join(REPO, ".cask", "nembrix.rb.tmpl");

interface Args {
  skipBuild: boolean;
  version: string | null;
}

function parseArgs(): Args {
  const out: Args = { skipBuild: false, version: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-build") out.skipBuild = true;
    else if (a === "--version") out.version = argv[++i] ?? null;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: REPO, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function runCapture(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { cwd: REPO, shell: false, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → exit ${res.status}: ${res.stderr}`);
  return res.stdout.trim();
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

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
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const SHIPPABLE = [".dmg", ".msi", ".exe", ".deb", ".AppImage", ".rpm", ".tar.gz"];

async function collectArtifacts(): Promise<string[]> {
  const all = await walk(BUNDLE_DIR);
  return all.filter((f) => SHIPPABLE.some((ext) => f.endsWith(ext)));
}

async function readVersion(): Promise<string> {
  // Read the desktop app's package.json — that's the version Tauri
  // bundles as. The workspace-root package.json isn't relevant.
  const pkg = JSON.parse(await readFile(join(APP_ROOT, "package.json"), "utf8"));
  return String(pkg.version);
}

/** Cross-check that every place we declare a version agrees with
 *  package.json. Catches drift before it ships. */
async function checkVersionConsistency(expected: string): Promise<void> {
  const cfg = JSON.parse(await readFile(join(APP_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  if (cfg.version !== expected) {
    throw new Error(`Version drift: tauri.conf.json=${cfg.version} but package.json=${expected}. `
      + `Run \`yarn bump-version <v>\` to sync them.`);
  }
  // Cargo.toml: the workspace declares the version in the [workspace.package]
  // block; the app crate inherits it. We grep rather than parse TOML to
  // avoid pulling in a dep just for this read.
  const cargo = await readFile(join(APP_ROOT, "src-tauri", "Cargo.toml"), "utf8");
  const match = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  if (match && match[1] !== expected) {
    throw new Error(`Version drift: src-tauri/Cargo.toml=${match[1]} but package.json=${expected}.`);
  }
}

/** Render the Homebrew cask template with placeholders filled. We
 *  only know the macOS dmg's checksum locally, so the other-platform
 *  builds get marked unsigned and skipped — the rendered file is
 *  enough to dry-run a `brew install --cask ./nembrix.rb`. */
async function renderCask(version: string, dmgSha: string): Promise<string> {
  if (!existsSync(CASK_TEMPLATE)) {
    throw new Error(`Cask template missing: ${CASK_TEMPLATE}`);
  }
  let body = await readFile(CASK_TEMPLATE, "utf8");
  body = body.replace(/__VERSION__/g, version);
  body = body.replace(/__SHA256__/g, dmgSha);
  body = body.replace(/__OWNER__/g, "nembrix");
  body = body.replace(/__REPO__/g, "nembrix");
  return body;
}

/** Produce a release-notes draft from `git log $LAST_TAG..HEAD`. If
 *  there is no prior tag yet, fall back to the latest 30 commits. */
function draftReleaseNotes(version: string): string {
  let range: string;
  try {
    const lastTag = runCapture("git", ["describe", "--tags", "--abbrev=0"]);
    range = `${lastTag}..HEAD`;
  } catch {
    range = "-n 30";
  }
  const log = runCapture("git", [
    "log", "--pretty=format:- %s (%h)", ...range.split(" "),
  ]);
  const date = runCapture("git", ["log", "-1", "--pretty=format:%cI"]);
  return [
    `# Nembrix ${version}`,
    "",
    `_Drafted ${date}_`,
    "",
    "## Changes",
    "",
    log || "_(no commits since last tag)_",
    "",
    "## Verification",
    "",
    "- [ ] macOS bundle launches and Gatekeeper warning is expected/acceptable",
    "- [ ] Connection form save / test / connect all work against the docker fixture",
    "- [ ] EXPLAIN viewer renders against a real query",
    "- [ ] Schema diff between two demo connections matches `migra`",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const version = args.version ?? await readVersion();

  console.log("──────────────────────────────────────────────");
  console.log(`Nembrix release dry-run — v${version}`);
  console.log("──────────────────────────────────────────────");

  // ── 1. version consistency check ──
  console.log("→ Verifying version consistency");
  await checkVersionConsistency(version);
  console.log("  package.json + tauri.conf.json + Cargo.toml all agree");

  // ── 2. build (or reuse) ──
  if (!args.skipBuild) {
    console.log("\n→ Running production build (use --skip-build to skip)");
    // We're already invoked from inside the desktop workspace by
    // `yarn workspace @nembrix/desktop release:local`, so a plain
    // `yarn build:prod` runs the desktop chain (tsc → test → vite →
    // tauri build) with .env.signing sourced.
    await run("yarn", ["build:prod"]);
  } else {
    console.log("\n→ Skipping build (--skip-build set), expecting existing artifacts");
  }

  // ── 3. collect artifacts ──
  console.log("\n→ Collecting bundle artifacts");
  const artifacts = await collectArtifacts();
  if (artifacts.length === 0) {
    throw new Error(`No bundles found in ${BUNDLE_DIR}. Did the build succeed?`);
  }

  const outDir = join(REPO, "dist-release", version);
  await mkdir(outDir, { recursive: true });

  const manifest: {
    version: string;
    artifacts: { name: string; size: number; sha256: string; source: string }[];
  } = { version, artifacts: [] };

  for (const src of artifacts) {
    const dst = join(outDir, basename(src));
    await copyFile(src, dst);
    const s = await stat(dst);
    const hash = await sha256(dst);
    manifest.artifacts.push({
      name: basename(dst),
      size: s.size,
      sha256: hash,
      source: src.replace(REPO + "/", ""),
    });
    console.log(`  ${basename(dst)}  ${formatBytes(s.size)}  ${hash.slice(0, 12)}…`);
  }

  // ── 4. render the Homebrew cask ──
  const dmg = manifest.artifacts.find((a) => a.name.endsWith(".dmg"));
  if (dmg) {
    console.log("\n→ Rendering Homebrew cask");
    const cask = await renderCask(version, dmg.sha256);
    await writeFile(join(outDir, "nembrix.rb"), cask);
    console.log("  dist-release/{version}/nembrix.rb");
    console.log("  Test with:  brew install --cask " + join(outDir, "nembrix.rb"));
  } else {
    console.log("\n→ No .dmg in artifacts — skipping cask render");
    console.log("  (Cask is only rendered on macOS builds.)");
  }

  // ── 5. write the manifest ──
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("  dist-release/{version}/manifest.json");

  // ── 6. draft release notes ──
  await writeFile(join(outDir, "RELEASE_NOTES.draft.md"), draftReleaseNotes(version));
  console.log("  dist-release/{version}/RELEASE_NOTES.draft.md");

  console.log("\n──────────────────────────────────────────────");
  console.log("Local release complete.");
  console.log("Inspect:    open dist-release/" + version);
  console.log("Test install (macOS): open dist-release/" + version + "/*.dmg");
  console.log("──────────────────────────────────────────────");
}

main().catch((e) => {
  console.error(`\n✗ Release dry-run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
