import { describe, expect, it } from "vitest";
import { plainDate, relativeTime } from "./format";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("counts minutes, hours and days, then falls back to a date", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("Just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(3 * 3600_000), NOW)).toBe("3 h ago");
    expect(relativeTime(ago(30 * 3600_000), NOW)).toBe("Yesterday");
    expect(relativeTime(ago(4 * 86400_000), NOW)).toBe("4 days ago");
    expect(relativeTime("2026-09-03T12:00:00Z", NOW)).toBe("Sep 3");
    expect(relativeTime("2025-09-03T12:00:00Z", NOW)).toBe("Sep 3, 2025");
  });
});

describe("plainDate", () => {
  it("writes a plain date out, and leaves anything else as typed", () => {
    expect(plainDate("2026-01-15")).toBe("Jan 15, 2026");
    expect(plainDate(" the date of last signature ")).toBe("the date of last signature");
  });
});
