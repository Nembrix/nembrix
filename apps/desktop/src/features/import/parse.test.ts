import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIALECT, detectFormat, parseCsv, parseJson, parseJsonl, splitSql,
} from "./parse";

describe("parseCsv", () => {
  it("parses a basic comma-separated file with header", () => {
    const out = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("synthesizes c1, c2, … when header is disabled", () => {
    const out = parseCsv("1,2,3\n4,5,6\n", { ...DEFAULT_DIALECT, header: false });
    expect(out.columns).toEqual(["c1", "c2", "c3"]);
    expect(out.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("handles fields with embedded commas, quotes, and newlines", () => {
    const csv = `name,note\n"Smith, John","line1\nline2"\n"he said ""hi""",ok\n`;
    const out = parseCsv(csv);
    expect(out.rows).toEqual([
      ["Smith, John", "line1\nline2"],
      [`he said "hi"`, "ok"],
    ]);
  });

  it("interprets the configured null token", () => {
    const out = parseCsv("a,b\n1,\\N\n,\n", {
      ...DEFAULT_DIALECT, nullToken: "\\N",
    });
    expect(out.rows).toEqual([
      ["1", null],
      ["", ""], // empty != nullToken
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const out = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(out.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("respects a tab delimiter", () => {
    const out = parseCsv("a\tb\n1\t2\n", { ...DEFAULT_DIALECT, delimiter: "\t" });
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("default dialect treats unquoted NULL as null and empty as empty", () => {
    const out = parseCsv("a,b\nNULL,\n,NULL\n");
    expect(out.rows).toEqual([
      [null, ""],
      ["", null],
    ]);
  });

  it("emptyIsNull flag turns empty cells into null too", () => {
    const out = parseCsv("a,b\nNULL,\n,foo\n", {
      ...DEFAULT_DIALECT, emptyIsNull: true,
    });
    expect(out.rows).toEqual([
      [null, null],
      [null, "foo"],
    ]);
  });

  it("quoted \"NULL\" stays as the literal string", () => {
    const out = parseCsv(`a,b\n"NULL",NULL\n`);
    expect(out.rows).toEqual([
      ["NULL", null],
    ]);
  });
});

describe("parseJson", () => {
  it("accepts an array of objects", () => {
    const out = parseJson(`[{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]`);
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.rows).toEqual([["1", "x"], ["2", "y"]]);
  });

  it("accepts a single object", () => {
    const out = parseJson(`{"a": 1, "b": null}`);
    expect(out.rows).toEqual([["1", null]]);
  });

  it("unions keys across objects, preserving first-appearance order", () => {
    const out = parseJson(`[{"a": 1}, {"b": 2}, {"a": 3, "c": 4}]`);
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.rows).toEqual([
      ["1", null, null],
      [null, "2", null],
      ["3", null, "4"],
    ]);
  });

  it("stringifies nested values rather than dropping them", () => {
    const out = parseJson(`[{"a": {"k": 1}, "b": [1, 2]}]`);
    expect(out.rows[0]).toEqual([`{"k":1}`, `[1,2]`]);
  });
});

describe("parseJsonl", () => {
  it("parses one object per line and skips blanks", () => {
    const out = parseJsonl(`{"a": 1}\n\n{"a": 2}\n`);
    expect(out.rows).toEqual([["1"], ["2"]]);
  });
});

describe("splitSql", () => {
  it("splits on semicolons at the top level", () => {
    const stmts = splitSql("SELECT 1; SELECT 2;");
    expect(stmts).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const stmts = splitSql(`INSERT INTO t VALUES ('a;b'); SELECT 1;`);
    expect(stmts).toEqual([`INSERT INTO t VALUES ('a;b')`, `SELECT 1`]);
  });

  it("handles doubled single quotes inside string literals", () => {
    const stmts = splitSql(`SELECT 'O''Brien'; SELECT 2;`);
    expect(stmts).toEqual([`SELECT 'O''Brien'`, `SELECT 2`]);
  });

  it("handles line comments without breaking", () => {
    const stmts = splitSql("-- a comment with ; semicolons\nSELECT 1;");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("SELECT 1");
  });

  it("handles dollar-quoted strings (PL/pgSQL bodies)", () => {
    const fn = "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN RETURN 1; END;\n$body$;\nSELECT f();";
    const stmts = splitSql(fn);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("$body$");
    // The internal semicolon inside the body must NOT split.
    expect(stmts[0]).toContain("BEGIN RETURN 1; END;");
  });
});

describe("detectFormat", () => {
  it("uses the extension when it's a known one", () => {
    expect(detectFormat("orders.csv", "")).toBe("csv");
    expect(detectFormat("orders.tsv", "")).toBe("csv");
    expect(detectFormat("orders.json", "")).toBe("json");
    expect(detectFormat("orders.jsonl", "")).toBe("jsonl");
    expect(detectFormat("orders.ndjson", "")).toBe("jsonl");
    expect(detectFormat("orders.sql", "")).toBe("sql");
  });

  it("falls back to content heuristics", () => {
    expect(detectFormat("blob", "INSERT INTO users VALUES (1);")).toBe("sql");
    expect(detectFormat("blob", "[{\"a\":1}]")).toBe("json");
    expect(detectFormat("blob", "{\"a\":1}\n{\"a\":2}")).toBe("jsonl");
    expect(detectFormat("blob", "a,b\n1,2")).toBe("csv");
  });
});
