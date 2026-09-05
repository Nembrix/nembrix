import { describe, it, expect } from "vitest";
import { buildPaletteItems } from "./items";
import { MENUS } from "@/menu/ids";

describe("buildPaletteItems", () => {
  it("emits each menu action once even when it appears in two menus", () => {
    // "New Connection…" is deliberately on both the File and Connection menus.
    // The palette used to emit it twice under the same `action:<id>` key, which
    // React flagged as a duplicate key and which rendered BOTH rows as active —
    // so pressing Enter could fire the wrong action.
    const ids = buildPaletteItems()
      .filter((i) => i.kind === "action")
      .map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still exposes an action that lives in two menus", () => {
    // De-duplicating must not drop the action entirely.
    const ids = buildPaletteItems().map((i) => i.id);
    expect(ids).toContain("action:file.new_connection");
  });

  it("every palette item id is unique", () => {
    const ids = buildPaletteItems().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every non-separator menu entry", () => {
    const menuIds = new Set(
      MENUS.flatMap((g) => g.items)
        .filter((i) => !i.separator && i.id && i.label)
        .map((i) => i.id as string),
    );
    const paletteIds = new Set(
      buildPaletteItems()
        .filter((i) => i.kind === "action")
        .map((i) => i.id.replace(/^action:/, "")),
    );
    for (const id of menuIds) expect(paletteIds).toContain(id);
  });
});
