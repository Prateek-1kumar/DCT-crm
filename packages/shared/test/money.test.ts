import { describe, expect, it } from "vitest";
import { parseCents, parsePercent } from "../src/index.js";

describe("parseCents", () => {
  it("reads amounts as contracts print them", () => {
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("1234.5")).toBe(123450);
    expect(parseCents("US$ 98")).toBe(9800);
    expect(parseCents("USD 0.05")).toBe(5);
    expect(parseCents("$7,455.00.")).toBe(745500); // the sentence's full stop isn't part of it
  });

  it("reads minus signs and brackets as credits", () => {
    expect(parseCents("-12.05")).toBe(-1205);
    expect(parseCents("(1,500.00)")).toBe(-150000);
    expect(parseCents("(-1,500.00)")).toBe(150000);
    expect(parseCents("(1,500.00")).toBe(150000); // a bracket on one side only isn't a credit
    expect(parseCents("(3,000.00)", { restates: true })).toBe(300000); // brackets that restate an amount in words
  });

  it("is null for anything else, a third decimal included", () => {
    for (const bad of ["", "abc", "$", "1,23", "12.345", "(500.00 per visit)", "--5", "12.34.56"]) expect(parseCents(bad), bad).toBeNull();
    expect(parseCents("99999999999999999999")).toBeNull(); // past a safe integer of cents
  });
});

describe("parsePercent", () => {
  it("reads percentages and plain numbers", () => {
    expect(parsePercent("1.5%")).toBe(1.5);
    expect(parsePercent("1.5%.")).toBe(1.5);
    expect(parsePercent("40 percent")).toBe(40);
    expect(parsePercent("45")).toBe(45);
    expect(parsePercent("1,000")).toBe(1000);
    expect(parsePercent("(15%)")).toBe(15);
    expect(parsePercent("fifteen percent (15%)")).toBe(15);
  });

  it("is null when it isn't one: never NaN, never 0 for nothing", () => {
    for (const bad of ["", "%", "abc", "4,5"]) expect(parsePercent(bad), bad).toBeNull();
  });
});
