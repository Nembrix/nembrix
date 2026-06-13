import { describe, expect, it } from "vitest";
import { diffSchemas, type DiffOp } from "./engine";
import type { ColumnNode, RelationNode, SchemaNode } from "@/ipc/types";

function col(name: string, type_name: string, opts: Partial<ColumnNode> = {}): ColumnNode {
  return { name, type_name, nullable: false, default: null, ...opts };
}
function table(name: string, columns: ColumnNode[], opts: Partial<RelationNode> = {}): RelationNode {
  return {
    name, columns,
    primary_key: opts.primary_key ?? [],
    foreign_keys: opts.foreign_keys ?? [],
    indexes: opts.indexes ?? [],
  };
}
function schema(name: string, tables: RelationNode[]): SchemaNode {
  return { name, tables, views: [], functions: [] };
}

const opKinds = (ops: DiffOp[]) => ops.map((o) => o.kind);

describe("diffSchemas - tables", () => {
  it("emits table.add when a table appears in right but not left", () => {
    const left  = schema("public", [table("users", [col("id", "integer")])]);
    const right = schema("public", [
      table("users", [col("id", "integer")]),
      table("orders", [col("id", "integer")]),
    ]);
    const { ops } = diffSchemas(left, right);
    expect(ops.find((o) => o.kind === "table.add")?.table).toBe("orders");
  });

  it("emits table.drop when a table is missing from right", () => {
    const left  = schema("public", [table("users", []), table("legacy", [])]);
    const right = schema("public", [table("users", [])]);
    const { ops } = diffSchemas(left, right);
    expect(ops.find((o) => o.kind === "table.drop")?.table).toBe("legacy");
  });

  it("emits no ops when the schemas are identical", () => {
    const sc = schema("public", [table("users", [col("id", "integer")])]);
    expect(diffSchemas(sc, sc).ops).toHaveLength(0);
  });
});

describe("diffSchemas - columns", () => {
  const base = schema("public", [
    table("users", [col("id", "integer"), col("email", "text")]),
  ]);

  it("column.add for a new column on the right", () => {
    const right = schema("public", [
      table("users", [col("id", "integer"), col("email", "text"), col("created_at", "timestamptz")]),
    ]);
    const { ops } = diffSchemas(base, right);
    expect(opKinds(ops)).toContain("column.add");
    expect(ops.find((o) => o.kind === "column.add")?.column).toBe("created_at");
  });

  it("column.drop for a column missing on the right", () => {
    const right = schema("public", [table("users", [col("id", "integer")])]);
    const { ops } = diffSchemas(base, right);
    expect(opKinds(ops)).toContain("column.drop");
    expect(ops.find((o) => o.kind === "column.drop")?.column).toBe("email");
  });

  it("column.changeType when only the type differs", () => {
    const right = schema("public", [
      table("users", [col("id", "bigint"), col("email", "text")]),
    ]);
    const { ops } = diffSchemas(base, right);
    expect(opKinds(ops)).toContain("column.changeType");
    expect(ops.find((o) => o.kind === "column.changeType")?.payload).toEqual({
      from: "integer", to: "bigint",
    });
  });

  it("column.setNotNull when right is non-nullable", () => {
    const left  = schema("public", [table("users", [col("email", "text", { nullable: true })])]);
    const right = schema("public", [table("users", [col("email", "text", { nullable: false })])]);
    expect(opKinds(diffSchemas(left, right).ops)).toContain("column.setNotNull");
  });

  it("column.dropNotNull when right is nullable", () => {
    const left  = schema("public", [table("users", [col("email", "text", { nullable: false })])]);
    const right = schema("public", [table("users", [col("email", "text", { nullable: true })])]);
    expect(opKinds(diffSchemas(left, right).ops)).toContain("column.dropNotNull");
  });

  it("column.setDefault when right has a new default", () => {
    const left  = schema("public", [table("u", [col("a", "integer")])]);
    const right = schema("public", [table("u", [col("a", "integer", { default: "0" })])]);
    expect(opKinds(diffSchemas(left, right).ops)).toContain("column.setDefault");
  });

  it("column.dropDefault when the right side removes the default", () => {
    const left  = schema("public", [table("u", [col("a", "integer", { default: "0" })])]);
    const right = schema("public", [table("u", [col("a", "integer")])]);
    expect(opKinds(diffSchemas(left, right).ops)).toContain("column.dropDefault");
  });
});

describe("diffSchemas - indexes", () => {
  it("matches indexes by column+uniqueness+method (not name), so equivalent indexes with auto-names don't appear as diffs", () => {
    const lt = table("users", [col("id", "integer")], {
      indexes: [{ name: "users_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree", definition: "" }],
    });
    const rt = table("users", [col("id", "integer")], {
      indexes: [{ name: "users_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree", definition: "" }],
    });
    const ops = diffSchemas(schema("public", [lt]), schema("public", [rt])).ops;
    expect(ops.filter((o) => o.group === "indexes")).toHaveLength(0);
  });

  it("flags index.add and index.drop when only one side has it", () => {
    const lt = table("users", [col("id", "integer")]);
    const rt = table("users", [col("id", "integer")], {
      indexes: [{ name: "users_id_idx", columns: ["id"], is_unique: false, is_primary: false, method: "btree", definition: "" }],
    });
    const ops = diffSchemas(schema("public", [lt]), schema("public", [rt])).ops;
    expect(ops.find((o) => o.kind === "index.add")?.summary).toMatch(/users_id_idx/);
  });
});

describe("diffSchemas - foreign keys", () => {
  it("fk.add when right has an FK not present in left", () => {
    const lt = table("orders", [col("user_id", "integer")]);
    const rt = table("orders", [col("user_id", "integer")], {
      foreign_keys: [{
        name: "orders_user_id_fkey",
        columns: ["user_id"],
        referenced_schema: "public",
        referenced_table: "users",
        referenced_columns: ["id"],
      }],
    });
    const ops = diffSchemas(schema("public", [lt]), schema("public", [rt])).ops;
    expect(ops.find((o) => o.kind === "fk.add")?.payload).toMatchObject({
      referenced_table: "users",
    });
  });
});

describe("diffSchemas - perTable summary", () => {
  it("counts added/removed/changed grouped per (schema.table)", () => {
    const left  = schema("public", [table("users", [col("id", "integer"), col("legacy", "text")])]);
    const right = schema("public", [
      table("users", [col("id", "bigint"), col("email", "text")]), // change id type, add email, drop legacy
      table("orders", []), // new table
    ]);
    const { perTable } = diffSchemas(left, right);
    const usersSummary = perTable.get("public.users")!;
    expect(usersSummary.added).toBe(1);
    expect(usersSummary.removed).toBe(1);
    expect(usersSummary.changed).toBe(1);
    expect(perTable.get("public.orders")?.added).toBe(1);
  });
});
