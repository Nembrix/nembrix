import { describe, it, expect } from "vitest";
import { fuzzyMatch, highlightSegments } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("returns score 0, no positions for empty query", () => {
    expect(fuzzyMatch("hello", "")).toEqual({ score: 0, positions: [] });
  });

  it("rejects non-subsequence queries", () => {
    expect(fuzzyMatch("hello", "xyz")).toBeNull();
    expect(fuzzyMatch("abc", "abcd")).toBeNull();
  });

  it("finds contiguous substring matches with positions", () => {
    const m = fuzzyMatch("New Connection", "conn");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([4, 5, 6, 7]);
  });

  it("scores prefix > middle > sparse", () => {
    const prefix = fuzzyMatch("connection", "conn")!.score;
    const middle = fuzzyMatch("Show Connection Panel", "conn")!.score;
    const sparse = fuzzyMatch("can our notes nag?", "conn")!.score;
    expect(prefix).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(sparse);
  });

  it("rewards word-start matches", () => {
    const start = fuzzyMatch("Open Saved Query", "osq")!.score;
    const middle = fuzzyMatch("foobosqbar", "osq")!.score;
    expect(start).toBeGreaterThan(middle);
  });

  it("ranks 'New Connection' highly for the query 'new conn'", () => {
    const candidates = [
      "New Connection…", "New Query Tab", "Refresh Schema",
      "Manage Roles & Grants…", "Disconnect", "Connect",
    ];
    const scored = candidates
      .map((t) => ({ t, s: fuzzyMatch(t, "new conn")?.score ?? -Infinity }))
      .sort((a, b) => b.s - a.s);
    expect(scored[0].t).toBe("New Connection…");
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("Beautify SQL", "sql")).not.toBeNull();
    expect(fuzzyMatch("SELECT * FROM users", "select")).not.toBeNull();
  });
});

describe("highlightSegments", () => {
  it("groups consecutive matched chars into one segment", () => {
    const segs = highlightSegments("New Connection", [4, 5, 6, 7]);
    expect(segs).toEqual([
      { text: "New ", matched: false },
      { text: "Conn", matched: true },
      { text: "ection", matched: false },
    ]);
  });
  it("handles no positions", () => {
    expect(highlightSegments("hello", [])).toEqual([{ text: "hello", matched: false }]);
  });
});
