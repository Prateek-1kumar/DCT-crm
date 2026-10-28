import { describe, expect, it } from "vitest";
import { bindEvidence, isoDate, reviewFromEvidence, runContractChecks, type TextPage } from "@dct/extraction";
import { manualRulebook } from "../src/domain.js";
import { failure } from "../src/jobs.js";
import { diffRulebooks, labelFor } from "../src/lib/diff.js";
import { getAt, markManual, parsePointer, setAt } from "../src/lib/pointer.js";
import type { Rulebook } from "@dct/shared";
import { answer, askAbout, mask, recheck, reviewDraft } from "../src/review.js";

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
    const out = mask(rb, ["/payment/netDays/value", "/budgetGrids/0/header", "/study/sponsor/value"], { evidence: [], review: [] });
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
    const pages: TextPage[] = [{ documentId: "d", page: 1, width: 612, height: 792, source: "image_only", words: [], hidden: 0, largePicture: false }];
    const { evidence, review, pdfCheck } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], pages, [{ id: "d", filename: "scan.pdf" }]);
    expect(evidence.filter((e) => e.status === "confirmed").map((e) => e.path)).toEqual([
      "/budgetGrids/0/procedures/0/cells/V1",
      "/budgetGrids/0/procedures/0/unitCents", // the same amount as a checked cell of its row
      "/budgetGrids/0/procedures/1/cells/V1",
      "/budgetGrids/0/procedures/1/unitCents",
      ...["totalCents", "procedureSubtotalCents", "nonProcedureCents", "overheadCents"].map((f) => `/budgetGrids/0/visits/0/${f}`),
    ]);
    expect(pdfCheck).toBeNull();
    expect(review.filter((i) => i.reason !== "SAMPLE").map((i) => `${i.reason} ${i.path ?? i.where[0]!.page}`)).toEqual([
      "SCAN_VALUE /budgetGrids/0/procedures/0/cells/V2",
      ...["totalCents", "procedureSubtotalCents", "overheadCents"].map((f) => `SCAN_VALUE /budgetGrids/0/visits/1/${f}`),
      "SCAN_VALUE /budgetGrids/0/perPatientTotals/0/cents",
      "SCAN_VALUE /siteFees/0/amountCents",
      ...["/overhead/appliesTo/value", "/payment/visitPayment/value", "/siteFees/0/trigger", "/rounding/value"].map((p) => `INTERPRETATION ${p}`),
      "SCAN_PAGE 1",
    ]);
    // fewer than 10 values confirmed (here by the totals): every one of them re-typed blind
    expect(review.filter((i) => i.reason === "SAMPLE").map((i) => i.path).sort()).toEqual(evidence.filter((e) => e.status === "confirmed").map((e) => e.path).sort());
  });
});

describe("picked answers", () => {
  it("an interpretation is picked from the field's own list and written; a yes/no question writes a boolean", () => {
    const s = { sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0];
    const rb = manualRulebook(s, []);
    rb.invoiceables = [{ code: null, name: "Courier", amountCents: 5000, amountWithOverheadCents: null, basis: "fixed", frequency: "per shipment", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: true, requiredDocs: [], prov: rb.study.sponsor.prov }];
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], []);
    // the read says the contract doesn't state it: asked once, as the interpretation, marked unclear
    const scope = review.find((i) => i.path === "/overhead/appliesTo/value")!;
    expect(review.filter((i) => i.path === "/overhead/appliesTo/value")).toHaveLength(1);
    expect(scope).toMatchObject({ id: "interpret:/overhead/appliesTo/value", kind: "interpretation", reason: "AMBIGUOUS_TERM", blocking: true, input: null });
    expect(scope.options.map((o) => o.id)).toEqual(["procedures_only", "procedures_and_staff", "all_per_patient_lines", "none"]);
    const draft = { version: 1, byHand: false, rulebook: rb, review: [...review, askAbout(rb, [], "/invoiceables/0/requiresPreApproval", "r1", "reported")], evidence: [], editors: [] };
    expect(answer(draft, scope.id, { optionId: "procedures_only", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen", set: { path: "/overhead/appliesTo/value", before: "unspecified", after: "procedures_only" } });
    expect(draft.review.at(-1)!.options).toEqual([{ id: "true", label: "Yes" }, { id: "false", label: "No" }]);
    // A reported yes/no value is checked like a typed one: a different pick differs (nothing written), picking again
    // settles it, with a note saying where the page prints it (a pick is never in the PDF's text).
    expect(answer(draft, "r1", { optionId: "false", by: "Sam" }, isoDate)).toMatchObject({ outcome: "differs", set: undefined });
    expect(draft.review.at(-1)!.compare).toEqual({ typed: false, read: true, printed: null });
    expect(draft.rulebook.invoiceables[0]!.requiresPreApproval).toBe(true);
    expect(() => answer(draft, "r1", { optionId: "false", by: "Sam" }, isoDate)).toThrow("Add a short note saying where the page prints this value.");
    expect(draft.review.at(-1)!.outcome).toBe("differs");
    expect(answer(draft, "r1", { optionId: "false", note: "Exhibit B, page 4: “no pre-approval needed”", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen" });
    expect(draft.review.at(-1)!.answer).toMatchObject({ optionId: "false", noPdfText: true });
    expect([draft.rulebook.overhead.appliesTo.value, draft.rulebook.invoiceables[0]!.requiresPreApproval]).toEqual(["procedures_only", false]);
    // The same value picked matches.
    draft.review.push(askAbout(draft.rulebook, [], "/invoiceables/0/requiresPreApproval", "r2", "reported"));
    expect(answer(draft, "r2", { optionId: "false", by: "Sam", value: "x".repeat(1000) }, isoDate)).toMatchObject({ outcome: "matched" });
    expect(draft.review.at(-1)!.answer).not.toHaveProperty("value", "x".repeat(1000)); // only what was answered is kept
    expect(rb.overhead.appliesTo.value).toBe("unspecified"); // written to the draft, not the input
  });
});

describe("what a question asks a person to type", () => {
  it("a cap's limit is an amount when its kind caps an amount, else a count", () => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    const inv = { code: null, name: "Travel", amountCents: 5000, amountWithOverheadCents: null, basis: "fixed" as const, frequency: "per visit", cap: { kind: "amount" as const, n: 50000, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov: rb.study.sponsor.prov };
    rb.invoiceables = [inv, { ...inv, cap: { kind: "count", n: 3, ratio: null } }];
    rb.screenFail = { amountCents: 10000, basis: "fixed", cap: { kind: "blocks_with_reauth", n: 7, ratio: null }, paidVia: "invoice", requiredDocs: [], prov: rb.study.sponsor.prov };
    const input = (path: string) => askAbout(rb, [], path, "r", "reported").input;
    expect([input("/invoiceables/0/cap/n"), input("/invoiceables/1/cap/n"), input("/screenFail/cap/n"), input("/invoiceables/0/amountCents")]).toEqual(["money", "number", "number", "money"]);
  });
});

describe("contract problems are never dropped", () => {
  const CELL = "/budgetGrids/0/procedures/0/cells/V2";
  const TOTAL = "anomaly:VISIT_TOTAL_MISMATCH:/budgetGrids/0/visits/1/totalCents";
  const LABEL = "anomaly:OVERHEAD_LABEL_MISMATCH:/budgetGrids/0/statedOverheadPct";
  /** One grid whose Week 1 total is printed $1 over its parts, and whose label says 40% where the amounts compute to 30%. */
  function grid(): Rulebook {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    const prov = { source: { documentId: "d", page: 1 }, confidence: 1, method: "ai", crossCheck: "not_checked" } as const;
    const g = rb.budgetGrids[0]!;
    g.statedOverheadPct = 40;
    g.visits = [
      { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: 2000, totalCents: 15000, autopay: true, prov },
      { code: "V2", name: "Week 1", order: 2, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: null, totalCents: 13100, autopay: true, prov },
    ];
    g.procedures = [
      { code: null, name: "Exam", unitCents: 10000, overheadApplied: true, category: "procedure", cells: { V1: 10000, V2: 10000 }, prov },
      { code: null, name: "Stipend", unitCents: 2000, overheadApplied: false, category: "non_procedure", cells: { V1: 2000 }, prov },
    ];
    g.perPatientTotals = [{ label: "Total", cents: 28100, prov }];
    return rb;
  }
  /** A read where the PDF's text backs every value but `asked`. */
  const read = (rb: Rulebook, asked: string[]) => {
    const evidence = asked.map((path) => ({ path, status: "ungrounded" as const, where: [], printed: null, note: null }));
    const anomalies = runContractChecks(rb);
    const bind = (() => ({ evidence, unaccounted: [] })) as unknown as typeof bindEvidence;
    return { anomalies, ...reviewDraft({ bindEvidence: bind, reviewFromEvidence }, rb, anomalies, [], []) };
  };
  const gridIds = (items: { id: string }[]) => items.map((i) => i.id).filter((id) => id.includes("budgetGrids"));

  it("a total that doesn't add up is held back only while a number in its visits, rows or totals is typed; an overhead label never", () => {
    expect(gridIds(read(grid(), ["/budgetGrids/0/statedOverheadPct"]).review)).toEqual(["confirm:/budgetGrids/0/statedOverheadPct", TOTAL, LABEL]);
    expect(gridIds(read(grid(), [CELL]).review)).toEqual([`confirm:${CELL}`, LABEL]);
  });

  it("held back is asked on the typed numbers once the grid's last number is answered; what was asked isn't asked twice", () => {
    const checks = (rb: Rulebook) => runContractChecks(rb);
    const rb = grid();
    const r = read(rb, [CELL]);
    const draft = { version: 1, byHand: false, rulebook: rb, review: r.review, evidence: r.evidence, editors: [] as string[] };
    const again = (v = draft) => recheck(checks, { ...v, anomalies: r.anomalies }, CELL);
    expect(again()).toEqual([]); // the cell is still being typed
    answer(draft, `confirm:${CELL}`, { value: 10000, by: "Sam" }, isoDate);
    const asked = again();
    expect(asked.map((i) => [i.id, i.kind])).toEqual([[TOTAL, "contract_problem"]]); // blocking as its severity says, as at read
    draft.review.push(...asked);
    expect(again()).toEqual([]); // asked once
    expect(again({ ...draft, byHand: true })).toEqual([]); // a contract typed by hand never ran the checks

    // A correction draft: the live version asked about this total on these numbers, so it isn't asked again; a typed
    // number that changes the arithmetic is.
    const fix = { version: 2, byHand: false, rulebook: grid(), review: [askAbout(grid(), [], CELL, "reported:1", "reported")], evidence: [], editors: [] as string[] };
    answer(fix, "reported:1", { value: 10000, by: "Sam" }, isoDate);
    expect(again(fix)).toEqual([]);
    answer(fix, "reported:1", { value: 10050, by: "Sam" }, isoDate);
    answer(fix, "reported:1", { value: 10050, note: "page 9, Week 1 column", by: "Sam" }, isoDate);
    expect(again(fix).map((i) => i.id)).toEqual(["anomaly:VISIT_TOTAL_MISMATCH:/budgetGrids/0/visits/1/procedureSubtotalCents"]);
  });
});

describe("a failed job", () => {
  it("says what happened in plain words and keeps the technical reason for the team; never SQL or values", () => {
    const api = (status: number, message: string) => Object.assign(new Error(message), { status });
    class ExtractionLimitError extends Error {}
    class LlmError extends Error {}
    const db = Object.assign(new Error('Failed query: update "rulebook_versions" set "rulebook" = $1 params: {"cents":848900}'), {
      query: 'update "rulebook_versions" set "rulebook" = $1',
      cause: { code: "40001", message: "could not serialize access" },
    });
    expect(failure(db)).toEqual({ error: "A database error stopped this. Try again; if it keeps happening, tell the team.", detail: "Database error 40001" });
    const limit = "Study.pdf has 140 pages; the limit is 100 per document. Split it into smaller PDFs.";
    expect(failure(new ExtractionLimitError(limit))).toEqual({ error: limit, detail: null }); // written for people already
    const plain = (err: unknown) => failure(err).error;
    expect(plain(api(529, '529 {"type":"error","error":{"type":"overloaded_error"}}'))).toMatch(/^The reading service is busy/);
    expect(plain(api(401, "401 invalid x-api-key"))).toMatch(/^Reading isn't set up correctly/);
    expect(plain(new Error("ANTHROPIC_API_KEY is not set. Set it in .env"))).toMatch(/^Reading isn't set up correctly/);
    expect(plain(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toMatch(/^We couldn't reach the reading service/);
    expect(plain(new LlmError('The OpenAI answer for "terms" is incomplete (max_output_tokens).'))).toMatch(/^The reading came back incomplete/);
    expect(plain(new RangeError("Page 3 needs 40 tiles; only 12 are left for this read."))).toMatch(/^This PDF couldn't be read/);
    expect(failure("boom")).toEqual({ error: "Something went wrong while reading. Try again; if it keeps happening, tell the team.", detail: "boom" });
    expect(failure(new LlmError("incomplete")).detail).toBe("LlmError: incomplete");
    for (const e of [db, api(500, "x"), new Error("weird")]) expect(failure(e).error).not.toMatch(/\$1|848900|select|update|params/i);
  });
});
