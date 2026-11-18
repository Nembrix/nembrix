import { describe, it, expect } from "vitest";
import {
  boolLiteral, contains, ilike, qualify, quoteIdent, selectStar, stringLiteral, withRowLimit,
} from "./sql-dialect";

describe("sql dialect", () => {
  it("quotes identifiers per dialect, doubling the quote character", () => {
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
    // A double quote inside a MySQL identifier needs no escaping.
    expect(quoteIdent("mysql", 'a"b')).toBe("`a\"b`");
    expect(qualify("mysql", "shop", "orders")).toBe("`shop`.`orders`");
    expect(qualify("postgres", "public", "orders")).toBe('"public"."orders"');
  });

  it("escapes string literals per dialect", () => {
    expect(stringLiteral("postgres", "it's")).toBe("'it''s'");
    expect(stringLiteral("postgres", "a\\b")).toBe("'a\\b'");
    expect(stringLiteral("mysql", "it's")).toBe("'it''s'");
    // MySQL reads \ as an escape: a trailing backslash must not swallow the quote.
    expect(stringLiteral("mysql", "a\\")).toBe("'a\\\\'");
  });

  it("maps case-(in)sensitive LIKE to what each dialect has", () => {
    expect(ilike("postgres", "c", "'%x%'", false)).toBe("c ILIKE '%x%'");
    expect(ilike("mysql", "c", "'%x%'", true)).toBe("LOWER(c) NOT LIKE LOWER('%x%')");
    expect(ilike("sqlite", "c", "'%x%'", false)).toBe("c LIKE '%x%'");
  });

  it("builds substring matches that treat the input literally", () => {
    const cs = { caseInsensitive: false, negate: false };
    const ci = { caseInsensitive: true, negate: false };
    expect(contains("postgres", "c", "x", cs)).toBe("c LIKE '%x%'");
    expect(contains("mysql", "c", "x", cs)).toBe("c LIKE BINARY '%x%'");
    expect(contains("postgres", "c", "5%_", ci)).toBe("c ILIKE '%5\\%\\_%'");
    // SQLite: LIKE ignores case, so case-sensitive is instr(); LIKE has no
    // default escape character, so it's declared.
    expect(contains("sqlite", "c", "it's", cs)).toBe("instr(c, 'it''s') > 0");
    expect(contains("sqlite", "c", "x", { caseInsensitive: false, negate: true })).toBe("instr(c, 'x') = 0");
    expect(contains("sqlite", "c", "5%", ci)).toBe("c LIKE '%5\\%%' ESCAPE '\\'");
  });

  it("quotes SQLite like Postgres, without backslash escaping", () => {
    expect(qualify("sqlite", "main", 'a"b')).toBe('"main"."a""b"');
    expect(stringLiteral("sqlite", "a\\'")).toBe("'a\\'''");
  });

  it("speaks T-SQL for SQL Server", () => {
    expect(quoteIdent("mssql", "we]ird")).toBe("[we]]ird]");
    expect(qualify("mssql", "dbo", "orders")).toBe("[dbo].[orders]");
    // N'…' keeps Unicode; backslashes are plain characters.
    expect(stringLiteral("mssql", "it's é\\")).toBe("N'it''s é\\'");
    expect(boolLiteral("mssql", true)).toBe("1");
    expect(boolLiteral("postgres", false)).toBe("FALSE");
    expect(selectStar("mssql", "[dbo].[t] ORDER BY [id] DESC", 50))
      .toBe("SELECT TOP (50) * FROM [dbo].[t] ORDER BY [id] DESC");
    expect(selectStar("postgres", '"t"', 5)).toBe('SELECT * FROM "t" LIMIT 5');
  });

  it("matches SQL Server substrings literally, [ included", () => {
    // `[` opens a character class in T-SQL LIKE, so it's escaped too.
    expect(contains("mssql", "[c]", "a_[b]", { caseInsensitive: true, negate: false }))
      .toBe("LOWER([c]) LIKE LOWER(N'%a\\_\\[b]%') ESCAPE '\\'");
    // Case-sensitive: a binary collation, applied to the column as text.
    expect(contains("mssql", "[c]", "Ab", { caseInsensitive: false, negate: true }))
      .toBe("CAST([c] AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2 NOT LIKE N'%Ab%' ESCAPE '\\'");
  });

  it("caps editor queries the way each dialect can", () => {
    expect(withRowLimit("postgres", "SELECT * FROM t;", 100)).toBe("SELECT * FROM t\nLIMIT 100;");
    expect(withRowLimit("postgres", "SELECT * FROM t LIMIT 5", 100)).toBe("SELECT * FROM t LIMIT 5");
    expect(withRowLimit("postgres", "UPDATE t SET a = 1", 100)).toBe("UPDATE t SET a = 1");
    expect(withRowLimit("mssql", "select distinct name from t", 100))
      .toBe("select distinct TOP (100) name from t");
    expect(withRowLimit("mssql", "SELECT TOP 5 * FROM t", 100)).toBe("SELECT TOP 5 * FROM t");
    expect(withRowLimit("mssql", "SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY", 100))
      .toBe("SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY");
    // A CTE can't take TOP up front; it runs as typed.
    expect(withRowLimit("mssql", "WITH x AS (SELECT 1 AS a) SELECT * FROM x", 100))
      .toBe("WITH x AS (SELECT 1 AS a) SELECT * FROM x");
  });
});
