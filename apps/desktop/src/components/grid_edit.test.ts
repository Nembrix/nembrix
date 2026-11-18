import { describe, expect, it } from "vitest";
import {
  buildDelete, buildInsert, buildUpdate, cellToText, pkLiteral, pkValuesFor, valueLiteral,
} from "./grid_edit";
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

describe("MySQL dialect", () => {
  it("quotes with backticks and MySQL literals", () => {
    expect(buildUpdate({
      schema: "shop", table: "orders", column: "note",
      newLiteral: valueLiteral("a\\b", "varchar", "mysql"),
      pkColumns: ["id"], pkValues: { id: { kind: "int", value: 7 } }, dialect: "mysql",
    })).toBe("UPDATE `shop`.`orders` SET `note` = 'a\\\\b' WHERE `id` = 7;");
    expect(buildDelete({
      schema: "shop", table: "orders",
      pkColumns: ["code"], pkValues: { code: { kind: "text", value: "x'y" } }, dialect: "mysql",
    })).toBe("DELETE FROM `shop`.`orders` WHERE `code` = 'x''y';");
  });

  it("renders bytes and JSON keys without Postgres casts", () => {
    expect(pkLiteral({ kind: "bytes", value: [0xff, 0x01] }, "mysql")).toBe("X'ff01'");
    expect(pkLiteral({ kind: "document", value: { a: 1 } }, "mysql")).toBe(`CAST('{"a":1}' AS JSON)`);
    expect(valueLiteral('{"a":1}', "json", "mysql")).toBe(`'{"a":1}'`);
  });

  it("inserts a row of defaults the way each dialect spells it", () => {
    expect(buildInsert({ schema: "s", table: "t", values: [], dialect: "mysql" }))
      .toBe("INSERT INTO `s`.`t` () VALUES ();");
    expect(buildInsert({ schema: "s", table: "t", values: [] }))
      .toBe(`INSERT INTO "s"."t" DEFAULT VALUES;`);
    expect(buildInsert({ schema: "s", table: "t", values: [["n", "1"]], dialect: "mysql" }))
      .toBe("INSERT INTO `s`.`t` (`n`) VALUES (1);");
  });
});

describe("SQLite dialect", () => {
  it("quotes like Postgres but takes backslashes literally and has no casts", () => {
    expect(buildUpdate({
      schema: "main", table: "t", column: "note",
      newLiteral: valueLiteral("a\\b", "text", "sqlite"),
      pkColumns: ["id"], pkValues: { id: { kind: "int", value: 7 } }, dialect: "sqlite",
    })).toBe(`UPDATE "main"."t" SET "note" = 'a\\b' WHERE "id" = 7;`);
    expect(pkLiteral({ kind: "bytes", value: [0xff, 0x01] }, "sqlite")).toBe("X'ff01'");
    expect(pkLiteral({ kind: "document", value: { a: 1 } }, "sqlite")).toBe(`'{"a":1}'`);
    expect(valueLiteral('{"a":1}', "json", "sqlite")).toBe(`'{"a":1}'`);
    expect(valueLiteral("42", "integer", "sqlite")).toBe("42");
    expect(buildInsert({ schema: "main", table: "t", values: [], dialect: "sqlite" }))
      .toBe(`INSERT INTO "main"."t" DEFAULT VALUES;`);
  });
});

describe("valueLiteral numeric guard", () => {
  it("leaves real numbers bare for numeric columns (MySQL type names too)", () => {
    expect(valueLiteral("42", "int", "mysql")).toBe("42");
    expect(valueLiteral("-1.5e3", "double")).toBe("-1.5e3");
    expect(valueLiteral("10", "int unsigned", "mysql")).toBe("10");
  });

  it("quotes anything that isn't a number instead of splicing it in", () => {
    expect(valueLiteral("1; DROP TABLE t", "integer")).toBe("'1; DROP TABLE t'");
    expect(valueLiteral("abc", "int", "mysql")).toBe("'abc'");
  });
});
