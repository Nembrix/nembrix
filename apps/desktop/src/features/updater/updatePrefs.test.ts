import { describe, it, expect, beforeEach } from "vitest";

// Minimal localStorage shim so prefs.ts (a browser module) runs under the
// node test environment. Mirrors the shim in groups.test.ts.
class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  get length(): number { return this.map.size; }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { loadPrefs, savePrefs, DEFAULT_PREFS } = await import("@/features/preferences/prefs");
const { formatUpdateDate } = await import("./formatUpdateDate");

describe("update preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to prompting, with nothing skipped", () => {
    expect(loadPrefs().updates).toEqual({ auto: false, skipVersion: null });
  });

  it("round-trips the auto-update opt-in", () => {
    const p = loadPrefs();
    savePrefs({ ...p, updates: { ...p.updates, auto: true } });
    expect(loadPrefs().updates.auto).toBe(true);
  });

  it("round-trips a skipped version", () => {
    const p = loadPrefs();
    savePrefs({ ...p, updates: { ...p.updates, skipVersion: "9.9.9" } });
    expect(loadPrefs().updates.skipVersion).toBe("9.9.9");
  });

  /** Prefs written before `updates` existed must not come back undefined —
   *  the dialog reads .auto/.skipVersion directly on every check. */
  it("backfills updates for prefs saved by an older build", () => {
    localStorage.setItem(
      "nembrix.prefs.v1",
      JSON.stringify({ csv: { nullToken: "\\N", delimiter: ",", emptyIsNull: false, lineEnding: "\n" } }),
    );
    expect(loadPrefs().updates).toEqual(DEFAULT_PREFS.updates);
    // ...without clobbering what that older build did save.
    expect(loadPrefs().csv.nullToken).toBe("\\N");
  });
});

describe("formatUpdateDate", () => {
  it("renders a plain ISO date", () => {
    expect(formatUpdateDate("2026-08-22")).toBeTruthy();
  });

  /** Tauri emits "2026-08-22 14:03:11.123 +00:00:00" — a space instead of
   *  the RFC 3339 "T", which not every engine parses. */
  it("handles Tauri's space-separated stamp", () => {
    expect(formatUpdateDate("2026-08-22 14:03:11.123 +00:00:00")).toBeTruthy();
  });

  it("falls back to the date part rather than showing Invalid Date", () => {
    const out = formatUpdateDate("2026-08-22 not-a-real-time");
    expect(out).not.toMatch(/Invalid/);
    expect(out).toBeTruthy();
  });

  it("returns null when there is nothing usable", () => {
    expect(formatUpdateDate("garbage")).toBeNull();
  });
});
