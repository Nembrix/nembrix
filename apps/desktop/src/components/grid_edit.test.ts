import { describe, expect, it } from "vitest";
import { buildUpdate, buildDelete, cellToText, pkLiteral, pkValuesFor, valueLiteral } from "./grid_edit";
import type { CellValue, ColMeta } from "@/ipc/types";

const intCell = (n: number): CellValue => ({ kind: "int", value: n });
const textCell = (s: string): CellValue => ({ kind: "text", value: s });
const nullCell: CellValue = { kind: "null" };

describe("pkLiteral", () => {
  it("quotes text and escapes single quotes", () => {
    expect(pkLiteral(textCell("O'Brien"))).toBe("'O''Brien'");
  });
  it("renders ints bare", () => {
    expect(pkLiteral(intCell(42))).toBe("42");
  });
  it("renders booleans as TRUE/FALSE", () => {
    expect(pkLiteral({ kind: "bool", value: true })).toBe("TRUE");
    expect(pkLiteral({ kind: "bool", value: false })).toBe("FALSE");
  });
});

describe("valueLiteral", () => {
  it("treats empty input as empty string literal", () => {
    expect(valueLiteral("", "text")).toBe("''");
  });
  it("leaves numeric input bare for int / numeric columns", () => {
    expect(valueLiteral("42", "integer")).toBe("42");
    expect(valueLiteral("-3.14", "numeric")).toBe("-3.14");
  });
  it("maps true/false strings to TRUE/FALSE for bool", () => {
    expect(valueLiteral("true", "bool")).toBe("TRUE");
    expect(valueLiteral("0", "boolean")).toBe("FALSE");
    expect(valueLiteral("yes", "bool")).toBe("TRUE");
  });
  it("quotes text and casts jsonb", () => {
    expect(valueLiteral("hello", "text")).toBe("'hello'");
    expect(valueLiteral(`{"a":1}`, "jsonb")).toBe(`'{"a":1}'::jsonb`);
  });
  it("escapes single quotes in text", () => {
    expect(valueLiteral("Bob's", "varchar")).toBe("'Bob''s'");
  });
});

describe("buildUpdate", () => {
  it("emits a single-cell UPDATE with one PK column", () => {
    const sql = buildUpdate({
      schema: "public",
      table: "users",
      column: "name",
      newLiteral: "'Alice'",
      pkColumns: ["id"],
      pkValues: { id: intCell(7) },
    });
    expect(sql).toBe(
      `UPDATE "public"."users" SET "name" = 'Alice' WHERE "id" = 7;`,
    );
  });
  it("supports composite primary keys", () => {
    const sql = buildUpdate({
      schema: "s",
      table: "t",
      column: "v",
      newLiteral: "42",
      pkColumns: ["a", "b"],
      pkValues: { a: textCell("x"), b: intCell(2) },
    });
    expect(sql).toBe(
      `UPDATE "s"."t" SET "v" = 42 WHERE "a" = 'x' AND "b" = 2;`,
    );
  });
  it("throws when the table has no PK", () => {
    expect(() => buildUpdate({
      schema: "s", table: "t", column: "c",
      newLiteral: "1", pkColumns: [], pkValues: {},
    })).toThrow(/primary key/i);
  });
  it("throws when a PK component is null", () => {
    expect(() => buildUpdate({
      schema: "s", table: "t", column: "c",
      newLiteral: "1", pkColumns: ["id"], pkValues: { id: nullCell },
    })).toThrow(/null/i);
  });
});

describe("buildDelete", () => {
  it("emits a single-row DELETE keyed by one PK column", () => {
    const sql = buildDelete({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: { id: intCell(7) },
    });
    expect(sql).toBe(`DELETE FROM "public"."users" WHERE "id" = 7;`);
  });
  it("supports composite primary keys", () => {
    const sql = buildDelete({
      schema: "s",
      table: "t",
      pkColumns: ["a", "b"],
      pkValues: { a: textCell("x"), b: intCell(2) },
    });
    expect(sql).toBe(`DELETE FROM "s"."t" WHERE "a" = 'x' AND "b" = 2;`);
  });
  it("throws when the table has no PK", () => {
    expect(() => buildDelete({
      schema: "s", table: "t", pkColumns: [], pkValues: {},
    })).toThrow(/primary key/i);
  });
  it("throws when a PK component is null", () => {
    expect(() => buildDelete({
      schema: "s", table: "t", pkColumns: ["id"], pkValues: { id: nullCell },
    })).toThrow(/null/i);
  });
});

describe("cellToText", () => {
  it("renders null as empty string", () => {
    expect(cellToText(nullCell)).toBe("");
  });
  it("renders documents as compact JSON", () => {
    expect(cellToText({ kind: "document", value: { a: 1 } })).toBe(`{"a":1}`);
  });
  it("renders bytes as hex literal", () => {
    expect(cellToText({ kind: "bytes", value: [0xde, 0xad, 0xbe, 0xef] })).toBe("\\xdeadbeef");
  });
});

describe("pkValuesFor", () => {
  const cols: ColMeta[] = [
    { name: "id", type_name: "int4", nullable: false },
    { name: "name", type_name: "text", nullable: true },
  ];
  it("returns the indexed PK values", () => {
    const r = pkValuesFor(cols, [intCell(1), textCell("a")], ["id"]);
    expect(r).toEqual({ id: intCell(1) });
  });
  it("returns undefined when PK column is missing from the row", () => {
    expect(pkValuesFor(cols, [intCell(1)], ["missing"])).toBeUndefined();
  });
  it("returns undefined when there is no PK", () => {
    expect(pkValuesFor(cols, [intCell(1)], [])).toBeUndefined();
  });
});
