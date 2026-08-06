import { describe, it, expect } from "vitest";
import {
  buildMongoFind,
  mongoFilterDoc,
  buildMongoUpdate,
  buildMongoInsert,
  buildMongoDelete,
  buildMongoCount,
  mongoIdFilter,
  mongoIdMatchValue,
} from "./buildTableQuery";
import type { FilterChip } from "@/store";
import type { CellValue } from "@/ipc/types";

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

const OID = "507f1f77bcf86cd799439011"; // 24-hex ObjectId
const oidCell: CellValue = { kind: "text", value: OID };
const strIdCell: CellValue = { kind: "text", value: "user-42" };
const intIdCell: CellValue = { kind: "int", value: 7 };

describe("mongoIdMatchValue / mongoIdFilter", () => {
  it("wraps a 24-hex string _id as extended-JSON $oid", () => {
    expect(mongoIdMatchValue(oidCell)).toEqual({ $oid: OID });
    expect(mongoIdFilter(oidCell)).toEqual({ _id: { $oid: OID } });
  });

  it("keeps a non-hex string _id as a plain string", () => {
    expect(mongoIdMatchValue(strIdCell)).toBe("user-42");
    expect(mongoIdFilter(strIdCell)).toEqual({ _id: "user-42" });
  });

  it("keeps a numeric _id as a number", () => {
    expect(mongoIdMatchValue(intIdCell)).toBe(7);
    expect(mongoIdFilter(intIdCell)).toEqual({ _id: 7 });
  });
});

describe("buildMongoUpdate", () => {
  it("builds updateOne with an $oid filter and $set (coercing the value)", () => {
    const cmd = buildMongoUpdate({
      collection: "users",
      id: oidCell,
      column: "age",
      newValue: "30",
    });
    expect(cmd).toBe(
      `db.users.updateOne({"_id":{"$oid":"${OID}"}}, {"$set":{"age":30}})`,
    );
  });

  it("sets null for the __NULL__ sentinel and matches a plain-string _id", () => {
    const cmd = buildMongoUpdate({
      collection: "users",
      id: strIdCell,
      column: "nickname",
      newValue: "__NULL__",
    });
    expect(cmd).toBe(
      'db.users.updateOne({"_id":"user-42"}, {"$set":{"nickname":null}})',
    );
  });
});

describe("buildMongoInsert", () => {
  it("builds insertOne, coercing values and skipping _id", () => {
    const cmd = buildMongoInsert({
      collection: "users",
      fields: [
        { column: "_id", value: OID },
        { column: "name", value: "ada" },
        { column: "age", value: "36" },
        { column: "active", value: "true" },
      ],
    });
    expect(cmd).toBe('db.users.insertOne({"name":"ada","age":36,"active":true})');
  });

  it("builds insertOne({}) for an empty draft", () => {
    expect(buildMongoInsert({ collection: "users", fields: [] })).toBe(
      "db.users.insertOne({})",
    );
  });
});

describe("buildMongoDelete", () => {
  it("builds deleteOne with an $oid filter", () => {
    expect(buildMongoDelete({ collection: "users", id: oidCell })).toBe(
      `db.users.deleteOne({"_id":{"$oid":"${OID}"}})`,
    );
  });

  it("builds deleteOne with a numeric _id", () => {
    expect(buildMongoDelete({ collection: "users", id: intIdCell })).toBe(
      'db.users.deleteOne({"_id":7})',
    );
  });
});

describe("buildMongoCount", () => {
  it("builds countDocuments with an empty filter", () => {
    expect(buildMongoCount(rel, [])).toBe("db.users.countDocuments({})");
  });

  it("builds countDocuments honoring filter chips", () => {
    const cmd = buildMongoCount(rel, [chip({ column: "active", op: "=", value: "true" })]);
    expect(cmd).toBe('db.users.countDocuments({"active":true})');
  });
});
