import { describe, it, expect } from "vitest";
import { buildMongoFind, mongoFilterDoc } from "./buildTableQuery";
import type { FilterChip } from "@/store";

const rel = { schema: "testdb", table: "users" };

function chip(partial: Partial<FilterChip>): FilterChip {
  return { id: "1", column: "name", op: "=", value: "x", ...partial };
}

describe("buildMongoFind", () => {
  it("builds a find with an empty filter + limit", () => {
    expect(buildMongoFind(rel, [], undefined, 200)).toBe("db.users.find({}).limit(200)");
  });

  it("adds .sort() when a sort is set (desc → -1)", () => {
    const cmd = buildMongoFind(rel, [], { column: "age", dir: "desc" }, 50);
    expect(cmd).toBe('db.users.find({}).sort({"age":-1}).limit(50)');
  });

  it("includes an equality filter, coercing numbers/bools", () => {
    const cmd = buildMongoFind(rel, [chip({ column: "active", value: "true" })], undefined, 10);
    expect(cmd).toBe('db.users.find({"active":true}).limit(10)');
  });
});

describe("mongoFilterDoc", () => {
  it("maps comparison operators", () => {
    expect(mongoFilterDoc([chip({ column: "age", op: ">", value: "18" })])).toEqual({ age: { $gt: 18 } });
    expect(mongoFilterDoc([chip({ column: "age", op: "<=", value: "65" })])).toEqual({ age: { $lte: 65 } });
    expect(mongoFilterDoc([chip({ column: "n", op: "!=", value: "x" })])).toEqual({ n: { $ne: "x" } });
  });

  it("maps null checks", () => {
    expect(mongoFilterDoc([chip({ column: "deleted", op: "IS NULL", value: null })])).toEqual({ deleted: null });
    expect(mongoFilterDoc([chip({ column: "deleted", op: "IS NOT NULL", value: null })])).toEqual({ deleted: { $ne: null } });
  });

  it("maps CONTAINS/ICONTAINS to a $regex and escapes special chars", () => {
    expect(mongoFilterDoc([chip({ column: "email", op: "ICONTAINS", value: "a.b" })])).toEqual({
      email: { $regex: "a\\.b", $options: "i" },
    });
    expect(mongoFilterDoc([chip({ column: "email", op: "CONTAINS", value: "x" })])).toEqual({
      email: { $regex: "x", $options: "" },
    });
  });

  it("skips disabled chips and unknown operators", () => {
    expect(mongoFilterDoc([chip({ enabled: false })])).toEqual({});
  });
});
