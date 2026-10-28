import { describe, expect, it } from "vitest";
import { bindEvidence, reviewFromEvidence, runContractChecks, type TextPage } from "@dct/extraction";
import { manualRulebook } from "../src/domain.js";
import { diffRulebooks, labelFor } from "../src/lib/diff.js";
import { getAt, markManual, parsePointer, setAt } from "../src/lib/pointer.js";
import { answer, askAbout, mask, reviewDraft } from "../src/review.js";

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
      { path: "/invoiceables/0", change: "added", before: null, after: after.invoiceables[0], label: "Invoiceable › Courier" },
      { path: "/invoiceables/1/amountWithOverheadCents", change: "changed", before: 80000, after: 90000, label: "Invoiceable › Unscheduled visit › Amount with overhead" },
      { path: "/invoiceables/1", change: "removed", before: before.invoiceables[1], after: null, label: "Invoiceable › SAE" },
      { path: "/study/sponsor/value", change: "changed", before: "X", after: "Y", label: "Study › Sponsor" },
    ]);
  });

  it("labels nested grid cells section first, with › separators", () => {
    const grid = (v2: number) => ({ budgetGrids: [{ id: "g1", label: "Exhibit A", procedures: [{ code: "1", name: "Spirometry", cells: { V2: v2 }, prov: prov() }] }] });
    expect(diffRulebooks(grid(9800), grid(11200))).toEqual([
      { path: "/budgetGrids/0/procedures/0/cells/V2", change: "changed", before: 9800, after: 11200, label: "Budget grid › Exhibit A › Procedures › Spirometry › V2" },
    ]);
  });

  it("is empty for identical rulebooks", () => {
    expect(diffRulebooks({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});

describe("manualRulebook", () => {
  it("is a valid blank rulebook, with one empty grid for the by-hand form, that the real contract checks accept", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: null } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    expect(rb.budgetGrids.map((g) => [g.id, g.visits.length, g.procedures.length])).toEqual([["g-hand", 1, 1]]);
    const codes = runContractChecks(rb).map((a) => `${a.code}:${a.path}`);
    expect(codes).toContain("REQUIRED_MISSING:/study/investigator/value");
    expect(codes.filter((c) => c.startsWith("LOW_CONFIDENCE"))).toEqual([]);
  });
});

describe("blind entry", () => {
  it("withholds a value and its quote; items and sections stay", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    rb.payment.netDays = { value: 45, prov: { source: { documentId: "d", page: 2, quote: "within 45 days" }, confidence: 1, method: "ai", crossCheck: "agree" } };
    const out = mask(rb, ["/payment/netDays/value", "/budgetGrids/0/header", "/study/sponsor/value"]);
    expect(out.payment.netDays).toEqual({ value: null, prov: { source: { documentId: "d", page: 2 }, confidence: 1, method: "ai", crossCheck: "agree" } });
    expect(out.study.sponsor.value).toBeNull();
    expect(out.budgetGrids[0]!.header).toEqual(rb.budgetGrids[0]!.header);
    expect(rb.payment.netDays.value).toBe(45); // a copy
  });

  it("labels a value as the web does", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    rb.budgetGrids[0]!.procedures[0]!.name = "Blood draw";
    expect(labelFor(rb, "/payment/netDays/value")).toBe("Payment › Net days");
    expect(labelFor(rb, "/budgetGrids/0/procedures/0/cells/V1")).toBe("Budget grid › Budget › Procedures › Blood draw › V1");
    expect(labelFor(rb, "/overhead/pct/value")).toBe("Overhead › Percent");
  });
});

describe("scan pages", () => {
  it("count a grid value as confirmed only when the contract's own totals agree to the cent; everything else is typed", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    const prov = { source: { documentId: "d", page: 1 }, confidence: 1, method: "ai", crossCheck: "not_checked" } as const;
    const g = rb.budgetGrids[0]!;
    g.visits = [
      { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: 2000, totalCents: 15000, autopay: true, prov },
      { code: "V2", name: "Week 1", order: 2, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: null, totalCents: 13100, autopay: true, prov }, // off by $1
    ];
    g.procedures = [
      { code: null, name: "Exam", unitCents: 10000, overheadApplied: true, category: "procedure", cells: { V1: 10000, V2: 10000 }, prov },
      { code: null, name: "Stipend", unitCents: 2000, overheadApplied: false, category: "non_procedure", cells: { V1: 2000 }, prov },
    ];
    g.perPatientTotals = [{ label: "Total", cents: 28100, prov }];
    rb.siteFees = [{ code: null, name: "Start-up", amountCents: 500000, trigger: "one_time", dueDays: null, prov }];
    const pages: TextPage[] = [{ documentId: "d", page: 1, width: 612, height: 792, source: "image_only", words: [], hidden: 0 }];
    const { evidence, review, pdfCheck } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], pages, [{ id: "d", filename: "scan.pdf" }]);
    expect(evidence.filter((e) => e.status === "confirmed").map((e) => e.path)).toEqual([
      "/budgetGrids/0/procedures/0/cells/V1",
      "/budgetGrids/0/procedures/0/unitCents", // the same amount as a checked cell of its row
      "/budgetGrids/0/procedures/1/cells/V1",
      "/budgetGrids/0/procedures/1/unitCents",
      ...["totalCents", "procedureSubtotalCents", "nonProcedureCents", "overheadCents"].map((f) => `/budgetGrids/0/visits/0/${f}`),
    ]);
    expect(pdfCheck).toBeNull();
    expect(review.map((i) => `${i.reason} ${i.path ?? i.where[0]!.page}`)).toEqual([
      "SCAN_VALUE /budgetGrids/0/procedures/0/cells/V2",
      ...["totalCents", "procedureSubtotalCents", "overheadCents"].map((f) => `SCAN_VALUE /budgetGrids/0/visits/1/${f}`),
      "SCAN_VALUE /budgetGrids/0/perPatientTotals/0/cents",
      "SCAN_VALUE /siteFees/0/amountCents",
      "SCAN_PAGE 1",
    ]);
  });
});

describe("picked answers", () => {
  it("an interpretation is picked from the field's own list and written; a yes/no question writes a boolean", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    rb.invoiceables = [{ code: null, name: "Courier", amountCents: 5000, amountWithOverheadCents: null, basis: "fixed", frequency: "per shipment", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: true, requiredDocs: [], prov: rb.study.sponsor.prov }];
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], []);
    const scope = review.find((i) => i.id === "anomaly:AMBIGUOUS_TERM:/overhead/appliesTo/value")!;
    expect(scope).toMatchObject({ kind: "interpretation", blocking: true, input: null, path: "/overhead/appliesTo/value" });
    expect(scope.options.map((o) => o.id)).toEqual(["procedures_only", "procedures_and_staff", "all_per_patient_lines", "none"]);
    const draft = { version: 1, byHand: false, rulebook: rb, review: [...review, askAbout(rb, [], "/invoiceables/0/requiresPreApproval", "r1", "reported")], evidence: [], editors: [] };
    expect(answer(draft, scope.id, { optionId: "procedures_only", by: "Sam" })).toMatchObject({ outcome: "chosen", set: { path: "/overhead/appliesTo/value", before: "unspecified", after: "procedures_only" } });
    expect(draft.review.at(-1)!.options).toEqual([{ id: "true", label: "Yes" }, { id: "false", label: "No" }]);
    // A reported yes/no value is checked like a typed one: a different pick differs (nothing written), picking it again settles it.
    expect(answer(draft, "r1", { optionId: "false", by: "Sam" })).toMatchObject({ outcome: "differs", set: undefined });
    expect(draft.review.at(-1)!.compare).toEqual({ typed: false, read: true, printed: null });
    expect(draft.rulebook.invoiceables[0]!.requiresPreApproval).toBe(true);
    expect(answer(draft, "r1", { optionId: "false", by: "Sam" })).toMatchObject({ outcome: "chosen" });
    expect([draft.rulebook.overhead.appliesTo.value, draft.rulebook.invoiceables[0]!.requiresPreApproval]).toEqual(["procedures_only", false]);
    // The same value picked matches.
    draft.review.push(askAbout(draft.rulebook, [], "/invoiceables/0/requiresPreApproval", "r2", "reported"));
    expect(answer(draft, "r2", { optionId: "false", by: "Sam", value: "x".repeat(1000) })).toMatchObject({ outcome: "matched" });
    expect(draft.review.at(-1)!.answer).not.toHaveProperty("value", "x".repeat(1000)); // only what was answered is kept
    expect(rb.overhead.appliesTo.value).toBe("unspecified"); // written to the draft, not the input
  });
});
