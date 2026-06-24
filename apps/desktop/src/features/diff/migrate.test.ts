import { describe, expect, it } from "vitest";
import { generateMigration } from "./migrate";
import type { DiffOp } from "./engine";
import type { ColumnNode, RelationNode } from "@/ipc/types";

function makeCol(name: string, type_name: string, opts: Partial<ColumnNode> = {}): ColumnNode {
  return { name, type_name, nullable: false, default: null, ...opts };
}

describe("generateMigration", () => {
  it("returns a no-op comment when there's nothing to do", () => {
    expect(generateMigration([])).toContain("Nothing to migrate");
  });

  it("wraps the script in BEGIN; … COMMIT;", () => {
    const op: DiffOp = {
      kind: "column.dropDefault",
      schema: "public", table: "u", column: "x",
      summary: "", group: "columns",
    };
    const sql = generateMigration([op]);
    expect(sql.split("\n")[0]).toBe("BEGIN;");
    expect(sql.split("\n").at(-1)).toBe("COMMIT;");
  });

  it("CREATE TABLE includes primary key and column definitions", () => {
    const rel: RelationNode = {
      name: "orders",
      columns: [makeCol("id", "integer"), makeCol("total", "bigint", { nullable: true })],
      primary_key: ["id"],
      foreign_keys: [],
      indexes: [],
    };
    const sql = generateMigration([{
      kind: "table.add", schema: "public", table: "orders",
      summary: "", group: "tables", payload: rel,
    }]);
    expect(sql).toMatch(/CREATE TABLE "public"\."orders" \(/);
    expect(sql).toContain(`"id" integer NOT NULL`);
    expect(sql).toMatch(/"total" bigint(?! NOT NULL)/);
    expect(sql).toContain(`PRIMARY KEY ("id")`);
  });

  it("ALTER COLUMN TYPE uses the target type from the payload", () => {
    const sql = generateMigration([{
      kind: "column.changeType",
      schema: "public", table: "u", column: "id",
      summary: "", group: "columns",
      payload: { from: "integer", to: "bigint" },
    }]);
    expect(sql).toContain(`ALTER TABLE "public"."u" ALTER COLUMN "id" TYPE bigint;`);
  });

  it("orders DROP fks → indexes → columns → tables before any ADD operations", () => {
    const ops: DiffOp[] = [
      { kind: "table.add",   schema: "public", table: "new_t",   summary: "", group: "tables", payload: { name: "new_t", columns: [makeCol("id", "integer")], primary_key: ["id"], foreign_keys: [], indexes: [] } as RelationNode },
      { kind: "fk.drop",     schema: "public", table: "orders",  summary: "", group: "fks",
        payload: { name: "orders_fk", columns: ["user_id"], referenced_schema: "public", referenced_table: "users", referenced_columns: ["id"] } },
      { kind: "column.drop", schema: "public", table: "users",   summary: "", group: "columns", column: "legacy" },
      { kind: "index.drop",  schema: "public", table: "users",   summary: "", group: "indexes",
        payload: { name: "users_legacy_idx", columns: ["legacy"], is_unique: false, is_primary: false, method: "btree", definition: "" } },
    ];
    const sql = generateMigration(ops);
    const idx = (s: string) => sql.indexOf(s);
    expect(idx("DROP CONSTRAINT")).toBeGreaterThan(-1);
    expect(idx("DROP INDEX")).toBeGreaterThan(-1);
    expect(idx("DROP COLUMN")).toBeGreaterThan(-1);
    expect(idx("CREATE TABLE")).toBeGreaterThan(-1);
    // Strict ordering: drops happen before creates.
    expect(idx("DROP CONSTRAINT")).toBeLessThan(idx("CREATE TABLE"));
    expect(idx("DROP INDEX")).toBeLessThan(idx("CREATE TABLE"));
    expect(idx("DROP COLUMN")).toBeLessThan(idx("CREATE TABLE"));
  });

  it("ADD FK is emitted last so the referenced table exists by the time the constraint is added", () => {
    const ops: DiffOp[] = [
      { kind: "fk.add",     schema: "public", table: "orders", summary: "", group: "fks",
        payload: { name: "orders_user_id_fkey", columns: ["user_id"], referenced_schema: "public", referenced_table: "users", referenced_columns: ["id"] } },
      { kind: "table.add",  schema: "public", table: "users",  summary: "", group: "tables",
        payload: { name: "users", columns: [makeCol("id", "integer")], primary_key: ["id"], foreign_keys: [], indexes: [] } as RelationNode },
    ];
    const sql = generateMigration(ops);
    expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("ADD CONSTRAINT"));
  });

  it("renders DROP TABLE with CASCADE", () => {
    const sql = generateMigration([{
      kind: "table.drop", schema: "public", table: "legacy",
      summary: "", group: "tables",
    }]);
    expect(sql).toContain(`DROP TABLE "public"."legacy" CASCADE;`);
  });

  it("skips a CREATE INDEX statement when the index is a primary key index", () => {
    const sql = generateMigration([{
      kind: "index.add", schema: "public", table: "u", summary: "", group: "indexes",
      payload: { name: "u_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree", definition: "" },
    }]);
    expect(sql).not.toMatch(/^CREATE/m);
    expect(sql).toContain("primary key index");
  });
});
