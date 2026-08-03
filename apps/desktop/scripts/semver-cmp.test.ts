import { describe, expect, it } from "vitest";
import { semverCmp } from "./semver-cmp";

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

describe("semverCmp", () => {
  it("orders by major, then minor, then patch", () => {
    expect(sign(semverCmp("1.0.0", "0.9.9"))).toBe(1);
    expect(sign(semverCmp("0.2.0", "0.1.9"))).toBe(1);
    expect(sign(semverCmp("0.1.2", "0.1.1"))).toBe(1);
    expect(sign(semverCmp("0.1.0", "0.2.0"))).toBe(-1);
  });

  it("treats equal versions as equal", () => {
    expect(semverCmp("0.1.0", "0.1.0")).toBe(0);
    expect(semverCmp("1.2.3", "1.2.3")).toBe(0);
  });

  it("a pre-release sorts before the same core release", () => {
    // 0.2.0-beta.1 < 0.2.0
    expect(sign(semverCmp("0.2.0-beta.1", "0.2.0"))).toBe(-1);
    expect(sign(semverCmp("0.2.0", "0.2.0-beta.1"))).toBe(1);
  });

  it("orders two pre-releases lexically", () => {
    expect(sign(semverCmp("0.2.0-beta.2", "0.2.0-beta.1"))).toBe(1);
    expect(sign(semverCmp("0.2.0-alpha", "0.2.0-beta"))).toBe(-1);
  });

  it("higher core beats pre-release of a lower core", () => {
    expect(sign(semverCmp("0.2.0", "0.3.0-beta.1"))).toBe(-1);
  });

  it("supports the release gate: a re-release (same) is NOT greater", () => {
    // The bump guard rejects when semverCmp(next, baseline) <= 0.
    expect(semverCmp("0.1.0", "0.1.0") <= 0).toBe(true);   // same → rejected
    expect(semverCmp("0.0.9", "0.1.0") <= 0).toBe(true);   // lower → rejected
    expect(semverCmp("0.2.0", "0.1.0") <= 0).toBe(false);  // higher → allowed
  });
});
