import { describe, it, expect } from "vitest";
import { looksLikeJavaScript } from "./looksLikeJavaScript";

describe("looksLikeJavaScript", () => {
  it("flags obvious scripts even behind a leading comment", () => {
    // The exact shape that slipped through the old first-line-only check: a
    // `-- //` / `//` comment on line 1, JS below.
    expect(
      looksLikeJavaScript(
        `-- // Query returns an array\nconst users = await db.query("SELECT id FROM users");`,
      ),
    ).toBe(true);
    expect(looksLikeJavaScript(`for (const u of users) { console.log(u.id); }`)).toBe(true);
    expect(looksLikeJavaScript(`const x = 1;`)).toBe(true);
    expect(looksLikeJavaScript(`await db.query("SELECT 1")`)).toBe(true);
    expect(looksLikeJavaScript(`rows.map(r => r.id)`)).toBe(true);
    expect(looksLikeJavaScript("console.log(`hi ${name}`)")).toBe(true);
  });

  it("does not flag ordinary SQL", () => {
    expect(looksLikeJavaScript(`SELECT id, email FROM users LIMIT 10`)).toBe(false);
    expect(looksLikeJavaScript(`select * from orders where total > 100`)).toBe(false);
    expect(
      looksLikeJavaScript(`WITH t AS (SELECT 1) SELECT * FROM t`),
    ).toBe(false);
    // A comment-only SQL snippet.
    expect(looksLikeJavaScript(`-- just a note\nSELECT now();`)).toBe(false);
    // "for" appears in SQL (FOR UPDATE) but not as "for (const …".
    expect(looksLikeJavaScript(`SELECT * FROM t FOR UPDATE`)).toBe(false);
  });
});
