import { describe, expect, it } from "vitest";
import { composeInsert, composeInsertBatch } from "./insert";

const QT = `"public"."users"`;

describe("composeInsert", () => {
  it("composes a basic INSERT with quoted columns and value escaping", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["id", "name"], conflictKey: [], mode: "stop" },
      ["1", "O'Brien"],
    );
    expect(sql).toBe(`INSERT INTO "public"."users" ("id", "name") VALUES (1, 'O''Brien');`);
  });

  it("passes NULL through unquoted", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["id", "name"], conflictKey: [], mode: "stop" },
      ["1", null],
    );
    expect(sql).toBe(`INSERT INTO "public"."users" ("id", "name") VALUES (1, NULL);`);
  });

  it("emits ON CONFLICT DO NOTHING in skip mode with a key", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["id", "name"], conflictKey: ["id"], mode: "skip" },
      ["1", "x"],
    );
    expect(sql).toContain(`ON CONFLICT ("id") DO NOTHING`);
  });

  it("emits ON CONFLICT … DO UPDATE for update mode", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["id", "name", "email"], conflictKey: ["id"], mode: "update" },
      ["1", "alice", "a@x.com"],
    );
    expect(sql).toContain(`ON CONFLICT ("id") DO UPDATE SET`);
    expect(sql).toContain(`"name" = EXCLUDED."name"`);
    expect(sql).toContain(`"email" = EXCLUDED."email"`);
    // Key column is NOT updated to itself.
    expect(sql).not.toContain(`"id" = EXCLUDED."id"`);
  });

  it("falls back to DO NOTHING when every column is part of the key", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["id"], conflictKey: ["id"], mode: "update" },
      ["1"],
    );
    expect(sql).toContain(`ON CONFLICT ("id") DO NOTHING`);
    expect(sql).not.toContain(`DO UPDATE`);
  });

  it("falls back to bare ON CONFLICT DO NOTHING when no key is given but mode=update", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["a"], conflictKey: [], mode: "update" },
      ["x"],
    );
    expect(sql).toContain(`ON CONFLICT DO NOTHING`);
  });

  it("passes integer-looking strings through unquoted", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["n"], conflictKey: [], mode: "stop" },
      ["42"],
    );
    expect(sql).toContain(`VALUES (42)`);
  });

  it("renders bool literals bare", () => {
    const sql = composeInsert(
      { qualifiedTarget: QT, columns: ["active"], conflictKey: [], mode: "stop" },
      ["true"],
    );
    expect(sql).toContain(`VALUES (TRUE)`);
  });
});

describe("composeInsertBatch", () => {
  it("emits an empty string for empty rows", () => {
    expect(composeInsertBatch(
      { qualifiedTarget: QT, columns: ["a"], conflictKey: [], mode: "stop" },
      [],
    )).toBe("");
  });

  it("falls back to single-row composeInsert when count is 1", () => {
    const sql = composeInsertBatch(
      { qualifiedTarget: QT, columns: ["a"], conflictKey: [], mode: "stop" },
      [["1"]],
    );
    expect(sql).toBe(composeInsert(
      { qualifiedTarget: QT, columns: ["a"], conflictKey: [], mode: "stop" },
      ["1"],
    ));
  });

  it("packs multiple rows into one INSERT with a comma-separated VALUES list", () => {
    const sql = composeInsertBatch(
      { qualifiedTarget: QT, columns: ["id", "name"], conflictKey: ["id"], mode: "skip" },
      [["1", "a"], ["2", "b"]],
    );
    expect(sql).toMatch(/^INSERT INTO/);
    expect(sql).toContain("(1, 'a'),");
    expect(sql).toContain("(2, 'b')");
    expect(sql).toContain(`ON CONFLICT ("id") DO NOTHING`);
  });
});
