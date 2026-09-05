import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "@/store";
import { isEnabled, disabledIds } from "./availability";
import { MENU } from "./ids";

function reset() {
  useStore.setState({
    connections: [],
    status: {},
    schemas: {},
    tabs: [],
    activeTabId: null,
    selectedConnId: null,
    selectedTable: null,
  });
}

const baseConn = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Demo", engine: "postgres",
  host: "h", port: 5432, username: "u",
  database: "d", ssl_mode: "prefer",
  ssh: null, color: null,
  created_at: "", updated_at: "",
};

describe("menu availability", () => {
  beforeEach(reset);

  it("Connect / Disconnect mirror the selected connection's status", () => {
    useStore.setState({ connections: [baseConn as never], selectedConnId: baseConn.id });
    let s = useStore.getState();
    expect(isEnabled(MENU.CONNECT, s)).toBe(true);
    expect(isEnabled(MENU.DISCONNECT, s)).toBe(false);

    useStore.setState({ status: { [baseConn.id]: "connected" } });
    s = useStore.getState();
    expect(isEnabled(MENU.CONNECT, s)).toBe(false);
    expect(isEnabled(MENU.DISCONNECT, s)).toBe(true);
    expect(isEnabled(MENU.REFRESH_SCHEMA, s)).toBe(true);
    expect(isEnabled(MENU.NEW_QUERY_TAB, s)).toBe(true);
  });

  it("Run Current needs an active query tab on a connected DB", () => {
    useStore.setState({
      connections: [baseConn as never],
      selectedConnId: baseConn.id,
      status: { [baseConn.id]: "connected" },
      tabs: [{ id: "t1", connId: baseConn.id, kind: "query", title: "Q", sql: "" } as never],
      activeTabId: "t1",
    });
    expect(isEnabled(MENU.QUERY_RUN_CURRENT, useStore.getState())).toBe(true);
    // Cancel is only enabled while a query is running.
    expect(isEnabled(MENU.QUERY_CANCEL, useStore.getState())).toBe(false);

    useStore.setState({
      tabs: [{ id: "t1", connId: baseConn.id, kind: "query", title: "Q", sql: "", running: true } as never],
    });
    expect(isEnabled(MENU.QUERY_RUN_CURRENT, useStore.getState())).toBe(false);
    expect(isEnabled(MENU.QUERY_CANCEL, useStore.getState())).toBe(true);
  });

  it("Table actions need both a connected DB and a selected table", () => {
    useStore.setState({
      connections: [baseConn as never],
      selectedConnId: baseConn.id,
      status: { [baseConn.id]: "connected" },
    });
    expect(isEnabled(MENU.TABLE_RENAME, useStore.getState())).toBe(false);

    useStore.setState({ selectedTable: { schema: "public", name: "users" } });
    expect(isEnabled(MENU.TABLE_RENAME, useStore.getState())).toBe(true);
    expect(isEnabled(MENU.TABLE_DROP, useStore.getState())).toBe(true);
  });

  it("disabledIds() returns IDs that are currently not applicable", () => {
    const fresh = useStore.getState();
    const ids = disabledIds(fresh);
    expect(ids).toContain(MENU.CONNECT);   // no selected connection
    expect(ids).toContain(MENU.TABLE_RENAME);
    expect(ids).toContain(MENU.QUERY_RUN_CURRENT);
    // The Command Palette has no availability rule — never disabled.
    expect(ids).not.toContain(MENU.COMMAND_PALETTE);
  });

  it("Import / Export need a selected connection", () => {
    // Both open a dialog that reads from a connection. Without one their
    // handlers bail out silently, so the rows looked live and clicking did
    // nothing — these rules grey them out instead.
    let s = useStore.getState();
    expect(isEnabled(MENU.IMPORT, s)).toBe(false);
    expect(isEnabled(MENU.EXPORT, s)).toBe(false);

    useStore.setState({ connections: [baseConn as never], selectedConnId: baseConn.id });
    s = useStore.getState();
    expect(isEnabled(MENU.IMPORT, s)).toBe(true);
    expect(isEnabled(MENU.EXPORT, s)).toBe(true);
  });

  it("Export does not require an established connection, only a selected one", () => {
    // Deliberately connSelected rather than connected: the dialog can open and
    // show its schema picker while the session is still connecting.
    useStore.setState({
      connections: [baseConn as never],
      selectedConnId: baseConn.id,
      status: { [baseConn.id]: "connecting" },
    });
    expect(isEnabled(MENU.EXPORT, useStore.getState())).toBe(true);
  });
});