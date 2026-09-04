/**
 * Bump the app version in lockstep across tauri.conf.json, Cargo.toml, and
 * both package.json files.
 *
 *   yarn bump-version 0.2.0
 *
 * Fails loudly if tauri.conf.json and Cargo.toml disagree before the bump (so
 * we don't silently overwrite a hand-edit).
 *
 * The package.json files were deliberately excluded here once, on the grounds
 * that "the app's version is driven by Tauri / Cargo". That held for the
 * shipped binary, but not for everything reading the manifest: they sat at
 * 0.1.0 while the app shipped 0.4.x, which made `yarn release-local` refuse to
 * run (it treats apps/desktop/package.json as the expected version and asserts
 * the manifests match). Keeping all four in lockstep costs nothing and removes
 * a whole class of "which version is real?" confusion.
 *
 * Note the manifests remain the SOURCE OF TRUTH — the pre-bump equality check
 * and the tag guard below both read tauri.conf.json, and vite injects
 * __APP_VERSION__ from it. package.json is kept in sync, not consulted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { semverCmp } from "./semver-cmp";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at apps/desktop/scripts/; the desktop app's manifests
// are one level up.
const APP_ROOT = join(__dirname, "..");
const REPO_ROOT = join(APP_ROOT, "..", "..");
const TAURI_CONF = join(APP_ROOT, "src-tauri", "tauri.conf.json");
const CARGO_TOML = join(APP_ROOT, "src-tauri", "Cargo.toml");
const APP_PKG = join(APP_ROOT, "package.json");
const ROOT_PKG = join(REPO_ROOT, "package.json");

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error("Usage: yarn bump-version <semver>");
  console.error('Example: yarn bump-version 0.2.0   (or 0.2.0-beta.1)');
  process.exit(1);
}

const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const tauriBefore = conf.version as string;

const cargoText = readFileSync(CARGO_TOML, "utf8");
const cargoMatch = cargoText.match(/^version\s*=\s*"([^"]+)"/m);
if (!cargoMatch) {
  console.error("Could not find version in Cargo.toml");
  process.exit(1);
}
const cargoBefore = cargoMatch[1];

if (tauriBefore !== cargoBefore) {
  console.error(
    `Versions are out of sync — tauri.conf.json: ${tauriBefore}, Cargo.toml: ${cargoBefore}. ` +
    `Fix the mismatch manually before bumping.`,
  );
  process.exit(1);
}

// Enforce a strictly INCREMENTAL bump against the last RELEASED version.
// The baseline is the highest existing `vX.Y.Z` git tag — NOT the on-disk
// version — so the very first release (no v* tags yet) can ship the
// current 0.1.0 as-is, while every subsequent release must go strictly up.
// The nightly rolling tag is ignored (it isn't a released version).
function lastReleasedVersion(): string | null {
  let raw: string;
  try {
    raw = execSync("git tag --list 'v[0-9]*'", { encoding: "utf8" });
  } catch {
    return null; // not a git repo / no git — skip the tag-based guard
  }
  const tags = raw.split("\n").map((t) => t.trim()).filter(Boolean);
  const versions = tags
    .map((t) => t.replace(/^v/, ""))
    .filter((v) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v));
  if (versions.length === 0) return null;
  return versions.sort(semverCmp).at(-1) ?? null;
}

const baseline = lastReleasedVersion();
if (baseline === null) {
  console.log(`no prior release tag — allowing initial version ${next}.`);
} else if (semverCmp(next, baseline) <= 0) {
  console.error(
    `Refusing to bump: ${next} is not greater than the last released v${baseline}. ` +
    `The version must strictly increase.`,
  );
  process.exit(1);
}

console.log(`bumping ${tauriBefore} → ${next}`);

conf.version = next;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n");

const cargoNext = cargoText.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${next}"`,
);
writeFileSync(CARGO_TOML, cargoNext);

/**
 * Rewrite just the top-level "version" line of a package.json.
 *
 * A targeted regex rather than JSON.parse + stringify: re-serializing would
 * reformat the whole file (key order is preserved by JSON.parse, but
 * indentation and any trailing newline are not), turning a one-line version
 * bump into a noisy diff over an otherwise untouched manifest. The anchor is
 * the first `"version": "..."` at two-space indent, which is the top-level
 * field — nested ones (in dependencies, etc.) are indented deeper.
 */
function bumpPackageJson(path: string, version: string): void {
  const text = readFileSync(path, "utf8");
  const re = /^(\s{2}"version"\s*:\s*)"[^"]+"/m;
  if (!re.test(text)) {
    console.error(`Could not find a top-level "version" field in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(re, `$1"${version}"`));
}

bumpPackageJson(APP_PKG, next);
bumpPackageJson(ROOT_PKG, next);

console.log(`updated ${TAURI_CONF}`);
console.log(`updated ${CARGO_TOML}`);
console.log(`updated ${APP_PKG}`);
console.log(`updated ${ROOT_PKG}`);
console.log("");
console.log(`next: git add -p && git commit -m "Release v${next}" && trigger the Release workflow.`);
