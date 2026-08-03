import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearScope, getWidth, scopeKey, setWidth, stretchLastColumn } from "./grid-column-widths";

/* localStorage is a global in vitest-jsdom; with environment:"node" in our
 * config, we polyfill it with a tiny Map-backed stub. */

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    } as Storage,
  });
});

afterEach(() => {
  // @ts-expect-error fine in tests
  delete globalThis.localStorage;
});

describe("scopeKey", () => {
  it("uses connection + relation for table-backed tabs", () => {
    expect(scopeKey("c1", { schema: "public", table: "users" })).toBe("conn:c1:public.users");
  });
  it("uses a synthetic tab key for hand-written queries", () => {
    expect(scopeKey("c1", undefined, "tab-9")).toBe("__query:tab-9");
  });
});

describe("setWidth / getWidth", () => {
  it("round-trips a single column width", () => {
    const k = scopeKey("c1", { schema: "public", table: "users" });
    setWidth(k, "email", 240);
    expect(getWidth(k, "email")).toBe(240);
  });

  it("widths are scoped — different relations don't leak", () => {
    const a = scopeKey("c1", { schema: "public", table: "users" });
    const b = scopeKey("c1", { schema: "public", table: "orders" });
    setWidth(a, "id", 60);
    setWidth(b, "id", 200);
    expect(getWidth(a, "id")).toBe(60);
    expect(getWidth(b, "id")).toBe(200);
  });

  it("rounds to whole pixels", () => {
    const k = scopeKey("c1", { schema: "public", table: "users" });
    setWidth(k, "email", 123.7);
    expect(getWidth(k, "email")).toBe(124);
  });

  it("clearScope drops all widths for that scope", () => {
    const k = scopeKey("c1", { schema: "public", table: "users" });
    setWidth(k, "id", 60);
    setWidth(k, "email", 240);
    clearScope(k);
    expect(getWidth(k, "id")).toBeUndefined();
    expect(getWidth(k, "email")).toBeUndefined();
  });
});

describe("stretchLastColumn", () => {
  const GUTTER = 44;

  it("grows the last column to fill the viewport", () => {
    // 3 cols (100 each) + 44 gutter = 344; viewport 800 → 456 slack → last col.
    const out = stretchLastColumn([100, 100, 100], GUTTER, 800, false);
    expect(out).toEqual([100, 100, 100 + 456]);
    // total now exactly fills the viewport
    expect(GUTTER + out.reduce((a, b) => a + b, 0)).toBe(800);
  });

  it("does not shrink columns that already overflow the viewport", () => {
    const widths = [300, 300, 300];
    // 944 total > 500 viewport → no slack → unchanged (same ref)
    expect(stretchLastColumn(widths, GUTTER, 500, false)).toBe(widths);
  });

  it("leaves the last column alone when it was manually resized", () => {
    const widths = [100, 100, 100];
    expect(stretchLastColumn(widths, GUTTER, 800, true)).toBe(widths);
  });

  it("returns the same array when there are no columns", () => {
    const widths: number[] = [];
    expect(stretchLastColumn(widths, GUTTER, 800, false)).toBe(widths);
  });

  it("only the last column absorbs the slack, others are untouched", () => {
    const out = stretchLastColumn([80, 120], GUTTER, 500, false);
    // slack = 500 - (44+80+120) = 256
    expect(out[0]).toBe(80);
    expect(out[1]).toBe(120 + 256);
  });
});
