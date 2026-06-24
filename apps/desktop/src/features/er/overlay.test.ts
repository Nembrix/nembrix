import { describe, expect, it } from "vitest";
import {
  isDirty,
  overlayFromLive,
  overlaySketchpad,
  projectAsRelations,
  type OverlayState,
} from "./overlay";
import type { RelationNode } from "@/ipc/types";

const usersTable: RelationNode = {
  name: "users",
  columns: [
    { name: "id", type_name: "integer", nullable: false, default: null },
    { name: "email", type_name: "text", nullable: false, default: null },
  ],
  primary_key: ["id"],
  foreign_keys: [],
  indexes: [],
};

describe("overlayFromLive", () => {
  it("mirrors the live schema as a clean overlay", () => {
    const overlay = overlayFromLive([usersTable]);
    expect(overlay.mode).toBe("live-fork");
    expect(overlay.tables).toHaveLength(1);
    expect(overlay.tables[0].name).toBe("users");
    expect(overlay.tables[0].columns).toHaveLength(2);
    expect(overlay.droppedTables).toEqual([]);
  });

  it("deep-clones columns so mutating the overlay doesn't touch the live schema", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables[0].columns[0].name = "mutated";
    expect(usersTable.columns[0].name).toBe("id");
  });
});

describe("overlaySketchpad", () => {
  it("starts empty with sketchpad mode", () => {
    const overlay = overlaySketchpad();
    expect(overlay.mode).toBe("sketchpad");
    expect(overlay.tables).toEqual([]);
    expect(overlay.droppedTables).toEqual([]);
  });
});

describe("isDirty", () => {
  it("clean overlay mirrors the live schema → not dirty", () => {
    expect(isDirty(overlayFromLive([usersTable]))).toBe(false);
  });

  it("empty sketchpad → not dirty", () => {
    expect(isDirty(overlaySketchpad())).toBe(false);
  });

  it("any table in sketchpad → dirty", () => {
    const overlay: OverlayState = {
      ...overlaySketchpad(),
      tables: [{
        name: "t", columns: [], primary_key: [], foreign_keys: [], indexes: [], _added: true,
      }],
    };
    expect(isDirty(overlay)).toBe(true);
  });

  it("added table → dirty", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables.push({
      name: "new_t", columns: [], primary_key: [], foreign_keys: [], indexes: [], _added: true,
    });
    expect(isDirty(overlay)).toBe(true);
  });

  it("dropped table → dirty", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.droppedTables = ["other"];
    expect(isDirty(overlay)).toBe(true);
  });

  it("renamed table → dirty", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables[0].name = "people";
    overlay.tables[0].originalName = "users";
    expect(isDirty(overlay)).toBe(true);
  });

  it("dropped column on existing table → dirty", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables[0]._droppedColumns = ["email"];
    expect(isDirty(overlay)).toBe(true);
  });

  it("renamed column on existing table → dirty", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables[0].columns[0]._dirty = true;
    expect(isDirty(overlay)).toBe(true);
  });
});

describe("projectAsRelations", () => {
  it("strips internal flags when projecting back to RelationNode shape", () => {
    const overlay = overlayFromLive([usersTable]);
    overlay.tables[0].columns[0]._dirty = true;
    overlay.tables[0].columns[0]._added = true;
    const rels = projectAsRelations(overlay);
    expect(rels[0].columns[0]).not.toHaveProperty("_dirty");
    expect(rels[0].columns[0]).not.toHaveProperty("_added");
    expect(rels[0].columns[0].name).toBe("id");
  });
});
