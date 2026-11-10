import { describe, expect, it } from "vitest";
import { centsToInput, formatCents, parseDollars, plainAmount } from "./money";

describe("formatCents", () => {
  it("formats integer cents as USD", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-80000)).toBe("−$800.00");
    expect(formatCents(900719925474099)).toBe("$9,007,199,254,740.99");
    expect(formatCents(null)).toBe("—");
  });
  it("rejects float money", () => {
    expect(() => formatCents(10.5)).toThrow();
  });
});

describe("parseDollars", () => {
  it("parses typed amounts to integer cents without float math", () => {
    expect(parseDollars("1,234.56")).toBe(123456);
    expect(parseDollars("$0.1")).toBe(10);
    expect(parseDollars("12")).toBe(1200);
    expect(parseDollars(".99")).toBe(99);
    expect(parseDollars("-3.05")).toBe(-305);
    expect(parseDollars("1.005")).toBeNaN(); // sub-cent is a typo, not rounding
    expect(parseDollars("abc")).toBeNaN();
    expect(parseDollars("  ")).toBeNull();
  });
  it("round-trips through the editor format", () => {
    for (const c of [0, 1, 99, 100, 745500, -305]) expect(parseDollars(centsToInput(c))).toBe(c);
  });
});

describe("plainAmount", () => {
  it("strips the dollar sign and commas from one amount, and leaves anything else as written", () => {
    expect([plainAmount("$1,234.56"), plainAmount("−$0.05"), plainAmount("$85.00 per hour"), plainAmount("Net 45")]).toEqual(["1234.56", "-0.05", "$85.00 per hour", "Net 45"]);
  });
});
