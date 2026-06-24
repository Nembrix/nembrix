import { describe, expect, it } from "vitest";
import { compactNumber, heatLevel, parseExplainJson } from "./explain";

const SAMPLE_EXPLAIN = JSON.stringify([{
  Plan: {
    "Node Type": "Hash Join",
    "Join Type": "Inner",
    "Startup Cost": 12.5,
    "Total Cost": 250.0,
    "Plan Rows": 1000,
    "Plan Width": 32,
    "Hash Cond": "(o.user_id = u.id)",
    "Plans": [
      {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        "Alias": "o",
        "Startup Cost": 0,
        "Total Cost": 50,
        "Plan Rows": 5000,
        "Plan Width": 16,
        "Filter": "(status = 'paid'::text)",
        "Rows Removed by Filter": 100,
      },
      {
        "Node Type": "Hash",
        "Startup Cost": 5,
        "Total Cost": 5,
        "Plan Rows": 100,
        "Plan Width": 8,
        "Plans": [{
          "Node Type": "Index Scan",
          "Relation Name": "users",
          "Index Name": "users_pkey",
          "Startup Cost": 0,
          "Total Cost": 4,
          "Plan Rows": 100,
          "Plan Width": 8,
          "Index Cond": "(active = true)",
        }],
      },
    ],
  },
  "Planning Time": 1.234,
}]);

const SAMPLE_ANALYZE = JSON.stringify([{
  Plan: {
    "Node Type": "Seq Scan",
    "Relation Name": "users",
    "Startup Cost": 0,
    "Total Cost": 50,
    "Plan Rows": 1000,
    "Plan Width": 32,
    "Actual Startup Time": 0.1,
    "Actual Total Time": 12.5,
    "Actual Rows": 1000,
    "Actual Loops": 1,
  },
  "Planning Time": 0.5,
  "Execution Time": 13.0,
}]);

describe("parseExplainJson", () => {
  it("parses EXPLAIN output into a tree", () => {
    const r = parseExplainJson(SAMPLE_EXPLAIN);
    expect(r.root.type).toBe("Hash Join");
    expect(r.root.joinType).toBe("Inner");
    expect(r.root.condition).toBe("(o.user_id = u.id)");
    expect(r.root.children).toHaveLength(2);
    expect(r.root.children[0].type).toBe("Seq Scan");
    expect(r.root.children[0].target).toBe("orders o");
    expect(r.root.children[0].filter).toBe("(status = 'paid'::text)");
    expect(r.root.children[0].rowsRemoved).toBe(100);
    // Walk deeper
    expect(r.root.children[1].children[0].type).toBe("Index Scan");
  });

  it("computes maxCost across the tree", () => {
    const r = parseExplainJson(SAMPLE_EXPLAIN);
    expect(r.maxCost).toBe(250);
  });

  it("captures planning + execution time when present", () => {
    const r = parseExplainJson(SAMPLE_ANALYZE);
    expect(r.planningMs).toBe(0.5);
    expect(r.executionMs).toBe(13.0);
    expect(r.root.actual?.totalMs).toBe(12.5);
    expect(r.maxActualMs).toBe(12.5);
  });

  it("throws on bad JSON shape", () => {
    expect(() => parseExplainJson("{}")).toThrow();
    expect(() => parseExplainJson("[{}]")).toThrow();
  });
});

describe("compactNumber", () => {
  it("formats large numbers compactly", () => {
    expect(compactNumber(42)).toBe("42");
    expect(compactNumber(12500)).toBe("12.5K");
    expect(compactNumber(1_234_567)).toBe("1.23M");
    expect(compactNumber(20_000_000)).toBe("20.0M");
  });
});

describe("heatLevel", () => {
  it("classifies by weight", () => {
    expect(heatLevel(0.1)).toBe("cool");
    expect(heatLevel(0.4)).toBe("warm");
    expect(heatLevel(0.8)).toBe("hot");
  });
});
