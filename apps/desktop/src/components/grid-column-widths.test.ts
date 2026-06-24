import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearScope, getWidth, scopeKey, setWidth } from "./grid-column-widths";

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
