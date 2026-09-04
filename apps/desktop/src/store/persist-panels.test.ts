import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "@/store";

// The module reconnects sessions on hydrate; stub the IPC so these tests stay
// about panel persistence rather than the connection handshake.
vi.mock("@/ipc/commands", () => ({
  listConnections: vi.fn(async () => []),
  connect: vi.fn(async () => {}),
  introspect: vi.fn(async () => ({ databases: [] })),
}));

const KEY = "nembrix.tabs.v1";

// The suite runs in vitest's `node` environment, which has no localStorage.
// A tiny in-memory stand-in keeps this test about the hydrate logic without
// pulling jsdom in for the whole project.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

async function hydrate() {
  const { hydrateTabsFromStorage } = await import("./persist");
  hydrateTabsFromStorage();
}

function seed(panels: unknown) {
  localStorage.setItem(
    KEY,
    JSON.stringify({ tabs: [], activeTabId: null, selectedConnId: null, panels }),
  );
}

describe("panel visibility persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ panels: { rail: true, inspector: true, results: true } });
  });

  it("restores a hidden results pane across a reload", async () => {
    seed({ rail: true, inspector: true, results: false });
    await hydrate();
    expect(useStore.getState().panels.results).toBe(false);
    expect(useStore.getState().panels.rail).toBe(true);
  });

  it("defaults to visible when no panels were persisted (legacy state)", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ tabs: [], activeTabId: null, selectedConnId: null }),
    );
    await hydrate();
    expect(useStore.getState().panels).toEqual({
      rail: true,
      inspector: true,
      results: true,
    });
  });

  it("fills missing keys with visible rather than dropping the whole object", async () => {
    // A truncated entry must not cost the user the one flag it did record.
    seed({ results: false });
    await hydrate();
    expect(useStore.getState().panels).toEqual({
      rail: true,
      inspector: true,
      results: false,
    });
  });

  it("ignores non-boolean values so corrupt state can't strand a pane", async () => {
    seed({ rail: "nope", inspector: null, results: 0 });
    await hydrate();
    expect(useStore.getState().panels).toEqual({
      rail: true,
      inspector: true,
      results: true,
    });
  });
});
