import { describe, expect, it } from "vitest";
import { asTransaction, emitDdl } from "./emitDdl";
import type { OverlayState } from "./overlay";

const empty: OverlayState = { mode: "live-fork", tables: [], droppedTables: [] };

describe("emitDdl", () => {
  it("emits nothing for an empty overlay", () => {
    expect(emitDdl(empty, "public").statements).toEqual([]);
  });

  it("CREATE TABLE for a freshly-added table", () => {
    const state: OverlayState = {
      mode: "sketchpad",
      tables: [{
        name: "users",
        columns: [
          { name: "id", type_name: "integer", nullable: false, default: null, _added: true },
          { name: "email", type_name: "text", nullable: true, default: null, _added: true },
        ],
        primary_key: ["id"],
        foreign_keys: [],
        indexes: [],
        _added: true,
      }],
      droppedTables: [],
    };
    const out = emitDdl(state, "public").statements.join("\n");
    expect(out).toContain('CREATE TABLE "public"."users"');
    expect(out).toContain('"id" integer NOT NULL');
    expect(out).toContain('"email" text');
    expect(out).toContain('PRIMARY KEY ("id")');
  });

  it("DROP TABLE for tables removed from live", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [],
      droppedTables: ["legacy_audit"],
    };
    expect(emitDdl(state, "app").statements[0])
      .toBe('DROP TABLE "app"."legacy_audit";');
  });

  it("ALTER TABLE ... RENAME on table rename", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [{
        name: "orders_v2",
        originalName: "orders",
        columns: [],
        primary_key: [],
        foreign_keys: [],
        indexes: [],
      }],
      droppedTables: [],
    };
    expect(emitDdl(state, "public").statements[0])
      .toBe('ALTER TABLE "public"."orders" RENAME TO "orders_v2";');
  });

  it("ADD COLUMN for new columns on existing tables", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [{
        name: "users",
        columns: [
          { name: "id", type_name: "integer", nullable: false, default: null },
          { name: "deleted_at", type_name: "timestamptz", nullable: true, default: null, _added: true },
        ],
        primary_key: ["id"],
        foreign_keys: [],
        indexes: [],
      }],
      droppedTables: [],
    };
    const out = emitDdl(state, "public").statements;
    expect(out.some((s) => s.includes('ADD COLUMN "deleted_at" timestamptz'))).toBe(true);
  });

  it("DROP COLUMN for tracked drops", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [{
        name: "users",
        columns: [{ name: "id", type_name: "integer", nullable: false, default: null }],
        primary_key: ["id"],
        foreign_keys: [],
        indexes: [],
        _droppedColumns: ["legacy_pw"],
      }],
      droppedTables: [],
    };
    expect(emitDdl(state, "public").statements[0])
      .toBe('ALTER TABLE "public"."users" DROP COLUMN "legacy_pw";');
  });

  it("ADD CONSTRAINT for added FKs", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [{
        name: "orders",
        columns: [
          { name: "id", type_name: "integer", nullable: false, default: null },
          { name: "user_id", type_name: "integer", nullable: false, default: null },
        ],
        primary_key: ["id"],
        foreign_keys: [{
          name: "orders_user_id_fkey",
          columns: ["user_id"],
          referenced_schema: "public",
          referenced_table: "users",
          referenced_columns: ["id"],
          _added: true,
        }],
        indexes: [],
      }],
      droppedTables: [],
    };
    const out = emitDdl(state, "public").statements.join("\n");
    expect(out).toContain('ADD CONSTRAINT "orders_user_id_fkey"');
    expect(out).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")');
  });

  it("DROP CONSTRAINT for tracked FK drops", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [{
        name: "orders",
        columns: [],
        primary_key: [],
        foreign_keys: [],
        indexes: [],
        _droppedFks: ["orders_user_id_fkey"],
      }],
      droppedTables: [],
    };
    expect(emitDdl(state, "public").statements[0])
      .toBe('ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_user_id_fkey";');
  });

  it("orders statements: DROP FK before DROP COLUMN before DROP TABLE before CREATE", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [
        {
          name: "users",
          columns: [{ name: "id", type_name: "integer", nullable: false, default: null }],
          primary_key: ["id"],
          foreign_keys: [],
          indexes: [],
          _droppedColumns: ["legacy_pw"],
          _droppedFks: ["users_org_id_fkey"],
        },
        {
          name: "audit",
          columns: [{ name: "id", type_name: "integer", nullable: false, default: null, _added: true }],
          primary_key: ["id"],
          foreign_keys: [],
          indexes: [],
          _added: true,
        },
      ],
      droppedTables: ["sessions"],
    };
    const stmts = emitDdl(state, "public").statements;
    const dropFk = stmts.findIndex((s) => s.includes("DROP CONSTRAINT"));
    const dropCol = stmts.findIndex((s) => s.includes("DROP COLUMN"));
    const dropTable = stmts.findIndex((s) => s.includes("DROP TABLE"));
    const createTable = stmts.findIndex((s) => s.includes("CREATE TABLE"));
    expect(dropFk).toBeLessThan(dropCol);
    expect(dropCol).toBeLessThan(dropTable);
    expect(dropTable).toBeLessThan(createTable);
  });

  it("asTransaction wraps statements in BEGIN/COMMIT", () => {
    const state: OverlayState = {
      mode: "live-fork",
      tables: [],
      droppedTables: ["x"],
    };
    const tx = asTransaction(emitDdl(state, "public"));
    expect(tx.startsWith("BEGIN;")).toBe(true);
    expect(tx.endsWith("COMMIT;")).toBe(true);
    expect(tx).toContain('DROP TABLE "public"."x";');
  });
});
