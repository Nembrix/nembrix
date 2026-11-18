import { describe, it, expect } from "vitest";
import { contains, ilike, qualify, quoteIdent, stringLiteral } from "./sql-dialect";

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
});
