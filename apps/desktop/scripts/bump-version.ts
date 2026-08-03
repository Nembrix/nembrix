/**
 * Bump the app version in lockstep across tauri.conf.json + Cargo.toml.
 *
 *   yarn bump-version 0.2.0
 *
 * Fails loudly if the two files disagree before the bump (so we don't
 * silently overwrite a hand-edit). Doesn't touch root package.json —
 * the app's version is driven by Tauri / Cargo.
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
const TAURI_CONF = join(APP_ROOT, "src-tauri", "tauri.conf.json");
const CARGO_TOML = join(APP_ROOT, "src-tauri", "Cargo.toml");

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

console.log(`updated ${TAURI_CONF}`);
console.log(`updated ${CARGO_TOML}`);
console.log("");
console.log(`next: git add -p && git commit -m "Release v${next}" && trigger the Release workflow.`);
