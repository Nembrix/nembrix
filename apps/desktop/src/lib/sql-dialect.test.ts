import { describe, it, expect } from "vitest";
import { ilike, like, qualify, quoteIdent, stringLiteral } from "./sql-dialect";

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
    expect(like("postgres", "c", "'%x%'", false)).toBe("c LIKE '%x%'");
    expect(like("mysql", "c", "'%x%'", false)).toBe("c LIKE BINARY '%x%'");
  });
});
