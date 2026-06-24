import { describe, expect, it } from "vitest";
import { formatBytes } from "./useTableStats";

describe("formatBytes", () => {
  it("formats bytes under 1 KB as raw bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats up to MB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats GB at scale", () => {
    expect(formatBytes(1024 * 1024 * 1024 * 5)).toBe("5.00 GB");
  });
});
