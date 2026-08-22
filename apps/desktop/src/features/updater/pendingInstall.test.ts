import { describe, it, expect, beforeEach } from "vitest";
import {
  setPendingInstall,
  getPendingInstall,
  runPendingInstall,
} from "./pendingInstall";

describe("pendingInstall", () => {
  beforeEach(() => setPendingInstall(null));

  it("reports nothing staged by default", async () => {
    expect(getPendingInstall()).toBeNull();
    expect(await runPendingInstall()).toBe(false);
  });

  it("runs the staged install exactly once", async () => {
    let calls = 0;
    setPendingInstall({ version: "1.2.3", install: async () => { calls++; } });

    expect(await runPendingInstall()).toBe(true);
    expect(calls).toBe(1);

    // A second close event must not install again — the handle is cleared
    // as soon as it's taken.
    expect(await runPendingInstall()).toBe(false);
    expect(calls).toBe(1);
  });

  it("swallows install failures so a bad update can't trap the user", async () => {
    setPendingInstall({
      version: "1.2.3",
      install: async () => { throw new Error("disk full"); },
    });

    // Must resolve false rather than reject — the close handler awaits this
    // and a rejection would leave the window un-closable.
    await expect(runPendingInstall()).resolves.toBe(false);
    // Still cleared, so the failure doesn't retry forever on every close.
    expect(getPendingInstall()).toBeNull();
  });
});
