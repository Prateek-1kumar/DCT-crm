import { describe, expect, it } from "vitest";
import { centsToInput, formatCents, parseDollars } from "./money";
import { formatValue, inferKind } from "./format";

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

describe("formatValue / inferKind", () => {
  it("formats by field", () => {
    expect(formatValue("/invoiceables/0/amountCents", 57200)).toBe("$572.00");
    expect(formatValue("/budgetGrids/0/procedures/1/cells/V2", "invoiceable")).toBe("Invoiceable");
    expect(formatValue("/overhead/pct/value", 30)).toBe("30%");
    expect(formatValue("/payment/visitPayment/value", "auto_edc")).toBe("Automatic (from EDC)");
    expect(formatValue("/payment/netDays/value", null)).toBe("Not stated");
  });
  it("picks an editor", () => {
    expect(inferKind("/budgetGrids/0/procedures/1/cells/V2", 2500)).toBe("cell");
    expect(inferKind("/screenFail/amountCents", 61000)).toBe("money");
    expect(inferKind("/payment/netDays/value", 45)).toBe("int");
    expect(inferKind("/deadlines/0/value", 90)).toBe("int");
    expect(inferKind("/payment/frequency/value", "monthly")).toBe("enum");
    expect(inferKind("/appliesFrom/value", null)).toBe("date");
    expect(inferKind("/payment/requiredReferences/value", ["a"])).toBe("list");
  });
});
