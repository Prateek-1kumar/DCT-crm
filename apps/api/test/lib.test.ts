import { describe, expect, it } from "vitest";
import { diffRulebooks } from "../src/lib/diff.js";
import { getAt, markManual, parsePointer, setAt } from "../src/lib/pointer.js";

const prov = (method = "ai") => ({ source: null, confidence: 1, method, crossCheck: "agree" });

describe("JSON pointer", () => {
  it("parses escapes and rejects bad pointers", () => {
    expect(parsePointer("/a~1b/c~0d/0")).toEqual(["a/b", "c~d", "0"]);
    expect(() => parsePointer("a/b")).toThrow();
    expect(() => parsePointer("/__proto__/x")).toThrow();
  });

  it("sets values in objects and arrays; parents must exist", () => {
    const doc = { a: { b: [1, 2] } };
    setAt(doc, ["a", "b", "1"], 5);
    setAt(doc, ["a", "b", "-"], 9);
    setAt(doc, ["a", "c"], "new");
    expect(doc).toEqual({ a: { b: [1, 5, 9], c: "new" } });
    expect(() => setAt(doc, ["x", "y"], 1)).toThrow(/does not exist/);
    expect(() => setAt(doc, ["a", "b", "7"], 1)).toThrow(/out of range/);
    expect(() => setAt(doc, [], 1)).toThrow();
    expect(getAt(doc, ["a", "b", "0"])).toBe(1);
  });

  it("marks the nearest prov as manual", () => {
    const doc = { netDays: { value: 45, prov: prov() }, grid: { prov: prov(), cells: { V1: 1 } } };
    markManual(doc, ["netDays", "value"]);
    markManual(doc, ["grid", "cells", "V1"]);
    expect(doc.netDays.prov.method).toBe("manual");
    expect(doc.grid.prov.method).toBe("manual");
  });
});

describe("diffRulebooks", () => {
  it("matches collection items by identity and labels changes for humans", () => {
    const before = {
      invoiceables: [
        { code: "A", name: "Unscheduled visit", amountWithOverheadCents: 80000, prov: prov() },
        { code: "B", name: "SAE", amountWithOverheadCents: 100, prov: prov() },
      ],
      study: { sponsor: { value: "X", prov: prov() } },
    };
    const after = {
      invoiceables: [
        { code: "C", name: "Courier", amountWithOverheadCents: 5, prov: prov() },
        { code: "A", name: "Unscheduled visit", amountWithOverheadCents: 90000, prov: prov("manual") },
      ],
      study: { sponsor: { value: "Y", prov: prov() } },
    };
    expect(diffRulebooks(before, after)).toEqual([
      { path: "/invoiceables/0", change: "added", before: null, after: after.invoiceables[0], label: "Invoiceable 'Courier'" },
      { path: "/invoiceables/1/amountWithOverheadCents", change: "changed", before: 80000, after: 90000, label: "Invoiceable 'Unscheduled visit' amountWithOverheadCents" },
      { path: "/invoiceables/1", change: "removed", before: before.invoiceables[1], after: null, label: "Invoiceable 'SAE'" },
      { path: "/study/sponsor/value", change: "changed", before: "X", after: "Y", label: "study sponsor" },
    ]);
  });

  it("is empty for identical rulebooks", () => {
    expect(diffRulebooks({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});
