import { beforeEach, describe, expect, it } from "vitest";

// Minimal localStorage shim so the module under test (which lives in the
// browser normally) runs under the node test environment. Each test gets
// a fresh store via beforeEach below.
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

import { compareOrder, load, reorder } from "./groups";

beforeEach(() => { localStorage.clear(); });

describe("compareOrder", () => {
  it("uses explicit order first, then name", () => {
    const names: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma" };
    const cmp = compareOrder({ a: 2, b: 0 }, (id) => names[id]);
    expect(["a", "b", "c"].sort(cmp)).toEqual(["b", "a", "c"]);
  });
  it("falls back to alphabetical when nothing is ordered", () => {
    const names: Record<string, string> = { x: "Zeta", y: "Alpha" };
    expect(["x", "y"].sort(compareOrder({}, (id) => names[id]))).toEqual(["y", "x"]);
  });
});

describe("reorder", () => {
  it("moves a connection above the target", () => {
    const initial = ["a", "b", "c", "d"];
    const next = reorder("d", "prod", "b", initial);
    const sorted = initial
      .slice()
      .sort((a, b) => (next.order[a] ?? 99) - (next.order[b] ?? 99));
    expect(sorted).toEqual(["a", "d", "b", "c"]);
  });
  it("moves a connection to the end when beforeId is null", () => {
    const initial = ["a", "b", "c"];
    const next = reorder("a", "g", null, initial);
    const sorted = initial
      .slice()
      .sort((a, b) => (next.order[a] ?? 99) - (next.order[b] ?? 99));
    expect(sorted).toEqual(["b", "c", "a"]);
  });
  it("is idempotent on no-op (moving above self)", () => {
    const initial = ["a", "b", "c"];
    const next = reorder("b", "g", "b", initial);
    expect(load().order).toEqual(next.order);
    // b ends up before its old position (which it left), so the bucket
    // becomes [a, b, c] still — no surprises.
    const sorted = initial
      .slice()
      .sort((a, b) => (next.order[a] ?? 99) - (next.order[b] ?? 99));
    expect(sorted).toEqual(["a", "b", "c"]);
  });
});
