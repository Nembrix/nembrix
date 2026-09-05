import { describe, it, expect } from "vitest";
import { explainUpdateError } from "./explainUpdateError";

describe("explainUpdateError", () => {
  it("explains the real message a network blip produces", () => {
    // This exact string is what the Tauri updater surfaced to a user.
    const { summary, detail } = explainUpdateError(
      "Could not fetch a valid release JSON from the remote",
    );
    expect(summary).toMatch(/internet connection/i);
    expect(summary).not.toMatch(/release JSON/i);
    // The raw text stays available for a bug report.
    expect(detail).toBe("Could not fetch a valid release JSON from the remote");
  });

  it("tells the user NOT to retry a signature failure", () => {
    const { summary } = explainUpdateError("signature verification failed");
    expect(summary).toMatch(/signature/i);
    expect(summary).toMatch(/manually/i);
  });

  it("covers timeouts and permission errors", () => {
    expect(explainUpdateError("network timeout").summary).toMatch(/timed out/i);
    expect(explainUpdateError("Permission denied (os error 13)").summary)
      .toMatch(/permission/i);
  });

  it("falls back without swallowing the original", () => {
    const { summary, detail } = explainUpdateError("something nobody predicted");
    expect(summary).toMatch(/couldn't be completed/i);
    expect(detail).toBe("something nobody predicted");
  });

  it("matches case-insensitively", () => {
    expect(explainUpdateError("COULD NOT FETCH a valid release JSON").summary)
      .toMatch(/internet connection/i);
  });
});
