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

  it("__APP_VERSION__ is injected from tauri.conf.json, not package.json", () => {
    const cfg = readText("../vite.config.ts");
    expect(cfg).toMatch(/__APP_VERSION__:\s*JSON\.stringify\(tauriConf\.version\)/);
    // Guard the specific regression: reading pkg.version silently drifts,
    // because the release bump never touches package.json.
    expect(cfg).not.toMatch(/__APP_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  });
});
