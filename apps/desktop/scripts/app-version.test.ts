import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const readText = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * The version the app *ships* lives in tauri.conf.json + Cargo.toml, which the
 * release pipeline rewrites in lockstep. package.json is NOT part of that
 * rewrite, so anything user-visible must not read its version — that's how
 * About ended up claiming 0.1.0 while the installed build was 0.4.4.
 */
describe("app version wiring", () => {
  it("tauri.conf.json and Cargo.toml agree", () => {
    const conf = read("../src-tauri/tauri.conf.json");
    const cargo = readText("../src-tauri/Cargo.toml");
    const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
    expect(m).not.toBeNull();
    expect(conf.version).toBe(m![1]);
  });

  it("both package.json files match the shipping version", () => {
    // Kept in lockstep by bump-version. They are not the source of truth, but
    // release-local asserts apps/desktop/package.json equals the manifests and
    // refuses to run on a mismatch — which it did while they sat at 0.1.0.
    const conf = read("../src-tauri/tauri.conf.json");
    expect(read("../package.json").version).toBe(conf.version);
    expect(read("../../../package.json").version).toBe(conf.version);
  });

  it("bump-version rewrites all four manifests", () => {
    // Guards the regression directly: the script used to skip package.json by
    // design, so every release widened the gap.
    const src = readText("./bump-version.ts");
    expect(src).toMatch(/bumpPackageJson\(APP_PKG, next\)/);
    expect(src).toMatch(/bumpPackageJson\(ROOT_PKG, next\)/);
    expect(src).toMatch(/writeFileSync\(TAURI_CONF/);
    expect(src).toMatch(/writeFileSync\(CARGO_TOML/);
  });

  it("__APP_VERSION__ is injected from tauri.conf.json, not package.json", () => {
    const cfg = readText("../vite.config.ts");
    expect(cfg).toMatch(/__APP_VERSION__:\s*JSON\.stringify\(tauriConf\.version\)/);
    // Guard the specific regression: reading pkg.version silently drifts,
    // because the release bump never touches package.json.
    expect(cfg).not.toMatch(/__APP_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  });
});
