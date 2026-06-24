import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// vitest runs in a node env with no DOM; install a tiny in-memory
// localStorage shim before importing the module under test so the
// global it touches at top-level exists.
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage;
});

import {
  clearSlowQueries, loadSettings, loadSlowQueries,
  recordSlowQuery, saveSettings,
} from "./slowQueries";

beforeEach(() => {
  localStorage.clear();
});

describe("slowQueries", () => {
  it("records when over threshold", () => {
    recordSlowQuery({ connId: "c1", sql: "SELECT 1", elapsedMs: 800 }, 1_700_000_000_000);
    const log = loadSlowQueries();
    expect(log).toHaveLength(1);
    expect(log[0].sql).toBe("SELECT 1");
    expect(log[0].elapsedMs).toBe(800);
  });

  it("skips when under threshold", () => {
    recordSlowQuery({ connId: "c1", sql: "SELECT 1", elapsedMs: 50 }, 1_700_000_000_000);
    expect(loadSlowQueries()).toHaveLength(0);
  });

  it("skips when disabled", () => {
    saveSettings({ ...loadSettings(), enabled: false });
    recordSlowQuery({ connId: "c1", sql: "SELECT 1", elapsedMs: 5000 }, 1_700_000_000_000);
    expect(loadSlowQueries()).toHaveLength(0);
  });

  it("enforces the limit (oldest entries drop off)", () => {
    saveSettings({ thresholdMs: 1, limit: 3, enabled: true });
    for (let i = 0; i < 5; i++) {
      recordSlowQuery({ connId: "c1", sql: `Q${i}`, elapsedMs: 1000 }, 1_700_000_000_000 + i);
    }
    const log = loadSlowQueries();
    expect(log.length).toBe(3);
    // unshift => newest first; the 3 most recent are Q4, Q3, Q2.
    expect(log.map((e) => e.sql)).toEqual(["Q4", "Q3", "Q2"]);
  });

  it("clearSlowQueries empties the log", () => {
    recordSlowQuery({ connId: "c1", sql: "x", elapsedMs: 1000 }, 1);
    clearSlowQueries();
    expect(loadSlowQueries()).toHaveLength(0);
  });

  it("loadSettings defaults are sensible", () => {
    const s = loadSettings();
    expect(s.thresholdMs).toBe(500);
    expect(s.limit).toBe(500);
    expect(s.enabled).toBe(true);
  });
});
