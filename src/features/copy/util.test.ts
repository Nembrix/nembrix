import { describe, expect, it } from "vitest";
import type { RelationNode } from "@/ipc/types";
import {
  emitCreateTable, emitForeignKeys, emitIndexes, emitSequenceResets, topoSortByFks,
} from "./util";

const rel = (over: Partial<RelationNode> = {}): RelationNode => ({
  name: "users",
  columns: [
    { name: "id", type_name: "integer", nullable: false, default: "nextval('users_id_seq'::regclass)" },
    { name: "email", type_name: "text", nullable: false, default: null },
  ],
  primary_key: ["id"],
  foreign_keys: [],
  indexes: [
    { name: "users_pkey", columns: ["id"], is_unique: true, is_primary: true, method: "btree",
      definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" },
    { name: "users_email_key", columns: ["email"], is_unique: true, is_primary: false, method: "btree",
      definition: "CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)" },
  ],
  ...over,
});

describe("emitCreateTable", () => {
  it("emits NOT NULL, defaults, and PRIMARY KEY", () => {
    const sql = emitCreateTable(`"public"."users"`, rel());
    expect(sql).toMatch(/CREATE TABLE "public"\."users"/);
    expect(sql).toMatch(/"id" integer NOT NULL DEFAULT nextval/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
  });
  it("honors IF NOT EXISTS opt", () => {
    expect(emitCreateTable(`"x"."y"`, rel(), { ifNotExists: true })).toMatch(/IF NOT EXISTS/);
  });
});

describe("emitIndexes", () => {
  it("skips primary index", () => {
    const out = emitIndexes(rel(), "public", "public");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/users_email_key/);
  });
  it("makes CREATE INDEX idempotent", () => {
    const out = emitIndexes(rel(), "public", "public");
    expect(out[0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
  });
  it("rewrites the schema when target differs", () => {
    const out = emitIndexes(rel(), "public", "archive");
    expect(out[0]).toMatch(/archive\.users/);
    expect(out[0]).not.toMatch(/public\.users/);
  });
});

describe("emitSequenceResets", () => {
  it("emits setval for serial defaults only", () => {
    const out = emitSequenceResets(`"public"."users"`, rel());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/setval\('users_id_seq'/);
    expect(out[0]).toMatch(/MAX\("id"\)/);
  });
  it("returns nothing for tables with no serial cols", () => {
    const noSerial = rel({
      columns: [{ name: "uuid", type_name: "uuid", nullable: false, default: null }],
    });
    expect(emitSequenceResets(`"x"."y"`, noSerial)).toHaveLength(0);
  });
});

describe("emitForeignKeys", () => {
  it("emits ALTER TABLE ADD CONSTRAINT", () => {
    const withFk = rel({
      foreign_keys: [{
        name: "users_org_fkey",
        columns: ["org_id"],
        referenced_schema: "public",
        referenced_table: "orgs",
        referenced_columns: ["id"],
      }],
    });
    const out = emitForeignKeys(`"public"."users"`, withFk);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/ALTER TABLE "public"\."users"/);
    expect(out[0]).toMatch(/REFERENCES "public"\."orgs" \("id"\)/);
  });
});

describe("topoSortByFks", () => {
  it("puts referenced tables before referrers", () => {
    const orgs = rel({ name: "orgs", foreign_keys: [] });
    const users = rel({ name: "users", foreign_keys: [{
      name: "fk", columns: ["org_id"],
      referenced_schema: "public", referenced_table: "orgs", referenced_columns: ["id"],
    }]});
    // Input order: dependent first
    const sorted = topoSortByFks([users, orgs]);
    expect(sorted.map((r) => r.name)).toEqual(["orgs", "users"]);
  });
  it("tolerates cycles by bailing on revisit", () => {
    // a → b → a — both should still appear in the output, even if order
    // isn't guaranteed.
    const a = rel({ name: "a", foreign_keys: [{
      name: "a_b", columns: ["b_id"],
      referenced_schema: "public", referenced_table: "b", referenced_columns: ["id"],
    }]});
    const b = rel({ name: "b", foreign_keys: [{
      name: "b_a", columns: ["a_id"],
      referenced_schema: "public", referenced_table: "a", referenced_columns: ["id"],
    }]});
    const sorted = topoSortByFks([a, b]);
    expect(sorted.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });
});
