import { describe, it, expect } from "vitest";
import {
  clauseFor, buildWhereFragment, rewriteSqlWithFilters, stripFilters,
} from "./filter-sql";
import type { FilterChip } from "@/store";

const eq = (column: string, value: string | null, op: FilterChip["op"] = "="): FilterChip => ({
  id: column, column, op, value,
});

describe("clauseFor", () => {
  it("quotes string values", () => {
    expect(clauseFor(eq("email", "a@b.com"))).toBe('"email" = \'a@b.com\'');
  });
  it("escapes embedded single quotes", () => {
    expect(clauseFor(eq("name", "O'Brien"))).toBe('"name" = \'O\'\'Brien\'');
  });
  it("passes numeric literals through bare", () => {
    expect(clauseFor(eq("id", "42"))).toBe('"id" = 42');
    expect(clauseFor(eq("amt", "-3.14"))).toBe('"amt" = -3.14');
  });
  it("renders IS NULL without a value", () => {
    expect(clauseFor(eq("name", null, "IS NULL"))).toBe('"name" IS NULL');
  });
  it("CONTAINS compiles to LIKE '%v%' with escaped wildcards", () => {
    expect(clauseFor(eq("name", "foo", "CONTAINS")))
      .toBe(`"name" LIKE '%foo%'`);
    // 50% off — the % must be escaped so it doesn't match arbitrary chars.
    expect(clauseFor(eq("offer", "50%", "CONTAINS")))
      .toBe(`"offer" LIKE '%50\\%%'`);
  });
  it("ICONTAINS uses ILIKE for case-insensitive substring", () => {
    expect(clauseFor(eq("name", "Bar", "ICONTAINS")))
      .toBe(`"name" ILIKE '%Bar%'`);
  });
  it("NOT CONTAINS / NOT ICONTAINS render with NOT prefix", () => {
    expect(clauseFor(eq("name", "x", "NOT CONTAINS")))
      .toBe(`"name" NOT LIKE '%x%'`);
    expect(clauseFor(eq("name", "x", "NOT ICONTAINS")))
      .toBe(`"name" NOT ILIKE '%x%'`);
  });
});

describe("rewriteSqlWithFilters", () => {
  it("is idempotent: toggling chips on/off returns to the original SQL", () => {
    const original = "SELECT * FROM users LIMIT 200;";
    const chips = [eq("id", "1"), eq("email", "a@b.com")];
    const withFilters = rewriteSqlWithFilters(original, chips);
    expect(withFilters).toContain('"id" = 1');
    expect(withFilters).toContain('"email" = \'a@b.com\'');
    const back = rewriteSqlWithFilters(withFilters, []);
    expect(back).toBe(original);
  });

  it("replaces an existing injected filter block rather than appending", () => {
    const original = "SELECT * FROM users LIMIT 200;";
    const onceA = rewriteSqlWithFilters(original, [eq("id", "1")]);
    const onceB = rewriteSqlWithFilters(onceA, [eq("email", "x@y.com")]);
    // Exactly one filter block (one start marker, one end marker).
    expect((onceB.match(/\/\*__dbclient_filters__\*\//g) ?? []).length).toBe(1);
    expect((onceB.match(/\/\*__\/dbclient_filters__\*\//g) ?? []).length).toBe(1);
    expect(onceB).toContain('"email" = \'x@y.com\'');
    expect(onceB).not.toContain('"id" = 1');
  });

  it("injects BEFORE the first LIMIT/ORDER BY", () => {
    const sql = "SELECT * FROM users ORDER BY id LIMIT 10;";
    const out = rewriteSqlWithFilters(sql, [eq("active", "true")]);
    const whereIdx = out.indexOf("WHERE");
    const orderIdx = out.indexOf("ORDER");
    expect(whereIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(whereIdx);
  });

  it("appends a WHERE block when no LIMIT/ORDER BY is present", () => {
    const sql = "SELECT * FROM users";
    const out = rewriteSqlWithFilters(sql, [eq("id", "1")]);
    expect(out).toContain("WHERE");
    expect(out.trim().endsWith(";")).toBe(true);
  });

  it("stripFilters is a no-op when there are no markers", () => {
    expect(stripFilters("SELECT 1")).toBe("SELECT 1");
  });

  it("buildWhereFragment is empty for an empty chip list", () => {
    expect(buildWhereFragment([])).toBe("");
  });
});
