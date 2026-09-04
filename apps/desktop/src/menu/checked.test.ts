import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "@/store";
import { isChecked, isCheckable, checkedIds } from "./checked";
import { MENU } from "./ids";

function reset() {
  useStore.setState({ panels: { rail: true, inspector: true, results: true } });
}

describe("menu checked state", () => {
  beforeEach(reset);

  it("mirrors panel visibility", () => {
    expect(isChecked(MENU.TOGGLE_RESULTS, useStore.getState())).toBe(true);
    useStore.setState({ panels: { rail: true, inspector: true, results: false } });
    expect(isChecked(MENU.TOGGLE_RESULTS, useStore.getState())).toBe(false);
  });

  it("tracks each panel independently", () => {
    useStore.setState({ panels: { rail: false, inspector: true, results: false } });
    const s = useStore.getState();
    expect(isChecked(MENU.TOGGLE_RAIL, s)).toBe(false);
    expect(isChecked(MENU.TOGGLE_INSPECTOR, s)).toBe(true);
    expect(isChecked(MENU.TOGGLE_RESULTS, s)).toBe(false);
  });

  it("marks only the panel toggles as checkable", () => {
    expect(isCheckable(MENU.TOGGLE_RAIL)).toBe(true);
    expect(isCheckable(MENU.TOGGLE_INSPECTOR)).toBe(true);
    expect(isCheckable(MENU.TOGGLE_RESULTS)).toBe(true);
    // A plain action is not a checkbox.
    expect(isCheckable(MENU.COMMAND_PALETTE)).toBe(false);
    expect(isCheckable(MENU.NEXT_TAB)).toBe(false);
  });

  it("a non-checkable id is never reported checked", () => {
    expect(isChecked(MENU.COMMAND_PALETTE, useStore.getState())).toBe(false);
  });

  it("checkedIds lists exactly the visible panels", () => {
    useStore.setState({ panels: { rail: true, inspector: false, results: true } });
    const ids = checkedIds(useStore.getState());
    expect(ids).toContain(MENU.TOGGLE_RAIL);
    expect(ids).toContain(MENU.TOGGLE_RESULTS);
    expect(ids).not.toContain(MENU.TOGGLE_INSPECTOR);
  });

  it("checkedIds is empty when every panel is hidden", () => {
    useStore.setState({ panels: { rail: false, inspector: false, results: false } });
    expect(checkedIds(useStore.getState())).toEqual([]);
  });
});
