import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { semverCmp } from "./semver-cmp";

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

  it("the docs' and README download links agree with each other", () => {
    // These were pinned by hand and drifted two releases behind (v0.4.0 while
    // the app shipped 0.4.4), so the site offered downloads for a release that
    // wasn't current. bump-version now rewrites them.
    //
    // Deliberately NOT asserted against tauri.conf.json: a bump runs before
    // the Release workflow publishes, so between those two points the on-disk
    // version has no assets and its URLs 404. The links track the last
    // PUBLISHED release instead, which can legitimately be one behind. What
    // must always hold is that all three files agree — a mismatch there means
    // a rewrite went partway and some page is stranded.
    const pages = [
      "../../docs/src/content/docs/index.mdx",
      "../../docs/src/content/docs/fr/index.mdx",
      "../../../README.md",
    ];
    const found = pages.map((page) => {
      const linked = readText(page).match(
        /\/releases\/download\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)\//,
      );
      expect(linked, `no download link found in ${page}`).not.toBeNull();
      return { page, version: linked![1] };
    });
    const versions = new Set(found.map((f) => f.version));
    expect(
      versions.size,
      `download links disagree: ${found.map((f) => `${f.page}=${f.version}`).join(", ")}`,
    ).toBe(1);
  });

  it("the download links never point ahead of the on-disk version", () => {
    // They may lag (the newest release isn't published yet) but must never
    // lead — a link to an unbuilt version 404s for every visitor.
    const onDisk = read("../src-tauri/tauri.conf.json").version;
    const linked = readText("../../../README.md").match(
      /\/releases\/download\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)\//,
    );
    expect(linked).not.toBeNull();
    expect(semverCmp(linked![1], onDisk)).toBeLessThanOrEqual(0);
  });

  it("bump-version rewrites the docs links and the workflow hint", () => {
    const src = readText("./bump-version.ts");
    // Links track the last published release, not the version being bumped to.
    expect(src).toMatch(/bumpDocsLinks\(page, publishedTarget\)/);
    expect(src).toMatch(/const publishedTarget = lastReleasedVersion\(\) \?\? next/);
    expect(src).toMatch(/bumpWorkflowExample\(BUMP_WORKFLOW, next\)/);
  });

  it("__APP_VERSION__ is injected from tauri.conf.json, not package.json", () => {
    const cfg = readText("../vite.config.ts");
    expect(cfg).toMatch(/__APP_VERSION__:\s*JSON\.stringify\(tauriConf\.version\)/);
    // Guard the specific regression: reading pkg.version silently drifts,
    // because the release bump never touches package.json.
    expect(cfg).not.toMatch(/__APP_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
  });
});
