import { describe, expect, it } from "vitest";
import {
  blindDetail,
  familyOf,
  interpretations,
  mask,
  pickSample,
  type ReviewItem,
  type Rulebook,
  RulebookVersionDto,
  sampleMisses,
  sampleMissWords,
  type ValueEvidence,
  withheldPaths,
} from "../src";

// The review lists that aren't flags (ADR-001 §6): interpretations picked blind, and the random blind sample.

const prov = (quote?: string) => ({ source: { documentId: "d1", page: 3, ...(quote ? { quote } : {}) }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const });
const s = <T>(value: T, quote?: string) => ({ value, prov: prov(quote) });
const cap = (kind: Rulebook["invoiceables"][number]["cap"]["kind"], n: number | null = null) => ({ kind, n, ratio: null });

function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme"), payingAgent: s(null), protocol: s("P-1"), siteName: s("Site A"), investigator: s("Dr. A"), effectiveDate: s("2025-01-10"), currency: "USD" },
    documents: [{ id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" }],
    referencedDocuments: [],
    overhead: { pct: s(25), appliesTo: s("procedures_only", "25% overhead on procedure costs") },
    payment: { visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s([]), paymentConditions: s([]) },
    budgetGrids: [],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [
      { code: null, name: "Mileage $0.67", amountCents: 67, amountWithOverheadCents: null, basis: "per_mile", frequency: "per mile", cap: cap("amount", 77700), requiresPreApproval: false, requiredDocs: [], prov: prov() },
      { code: null, name: "SAE report", amountCents: 25000, amountWithOverheadCents: null, basis: "fixed", frequency: "per SAE", cap: cap("none"), requiresPreApproval: false, requiredDocs: [], prov: prov() },
    ],
    screenFail: { amountCents: 50000, basis: "fixed", cap: cap("none"), paidVia: "invoice", requiredDocs: [], prov: prov() },
    siteFees: [{ code: null, name: "Start-up", amountCents: 500000, trigger: "agreement_execution", dueDays: 30, prov: prov("due within 30 days of execution") }],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("cents"),
    appliesFrom: s(null),
    unclassified: [],
  };
}

describe("interpretations", () => {
  it("one per field whose wording decides billing; a cap's kind only where there's a cap", () => {
    expect(interpretations(rulebook(), { amendment: false }).map((i) => [i.path, i.reason])).toEqual([
      ["/overhead/appliesTo/value", "INTERPRETATION"],
      ["/payment/visitPayment/value", "INTERPRETATION"],
      ["/siteFees/0/trigger", "INTERPRETATION"],
      ["/invoiceables/0/cap/kind", "INTERPRETATION"],
      ["/screenFail/basis", "INTERPRETATION"],
      ["/screenFail/paidVia", "INTERPRETATION"],
      ["/rounding/value", "INTERPRETATION"],
    ]);
  });

  it("asks blind: nothing preselected or answered, the field's own values, the quote and names with no figure in them", () => {
    const items = interpretations(rulebook(), { amendment: false });
    expect(items.every((i) => i.blocking && i.kind === "interpretation" && i.answer === null && i.outcome === null)).toBe(true);
    const overhead = items[0]!;
    expect(overhead.question).toBe("Which lines does the overhead apply to? The contract says: “•••% overhead on procedure costs”");
    expect(overhead.options.map((o) => o.id)).toEqual(["procedures_only", "procedures_and_staff", "all_per_patient_lines", "none", "unspecified"]);
    expect(items.find((i) => i.path === "/screenFail/basis")!.options.map((o) => o.id)).toEqual(["fixed", "per_procedure"]); // not an invoiceable's
    expect(items.find((i) => i.path === "/invoiceables/0/cap/kind")).toMatchObject({ question: "What limit does the contract put on billing “Mileage …”?", options: expect.arrayContaining([{ id: "amount", label: "A total amount at most" }]) });
    expect(items.find((i) => i.path === "/siteFees/0/trigger")!.question).toMatch(/“due within ••• days of execution”$/);
  });

  it("a holdback's scope is typed; an amendment's start date takes a date or 'prospective only'", () => {
    const rb = rulebook();
    rb.holdback = { pct: 5, appliesTo: "each visit payment", releaseConditions: [], prov: prov() };
    rb.documents.push({ id: "d2", kind: "amendment", title: "Amendment 1", date: "2026-03-01" });
    const items = interpretations(rb, { amendment: false });
    expect(items.find((i) => i.path === "/holdback/appliesTo")).toMatchObject({ input: "text", options: [] });
    expect(items.find((i) => i.path === "/appliesFrom/value")).toMatchObject({
      kind: "contract_problem",
      reason: "RETROACTIVE_NO_DATE",
      input: "date",
      options: [{ id: "prospective", label: "Prospective only: from the amendment's own date, March 1, 2026" }],
    });
    rb.documents[1]!.date = "1 March 2026"; // not a date we can write: typed only
    expect(interpretations(rb, { amendment: false }).find((i) => i.path === "/appliesFrom/value")!.options).toEqual([]);
  });

  it("an AMBIGUOUS_TERM about one of them is that question, marked, its figures blanked", () => {
    const [item] = interpretations(rulebook(), { amendment: false, anomalies: [{ code: "AMBIGUOUS_TERM", path: "/overhead/appliesTo", message: "Ambiguous: whether 25% covers stipends", refs: [{ documentId: "d1", page: 7 }] }] });
    expect(item).toMatchObject({ reason: "AMBIGUOUS_TERM", where: [{ documentId: "d1", page: 3, box: null }, { documentId: "d1", page: 7, box: null }] });
    expect(item!.question).toMatch(/^Ambiguous: whether •••% covers stipends\. Which lines/);
    expect(item!.options.map((o) => o.id)).not.toContain("unspecified");
  });
});

describe("withheld while asked", () => {
  it("an interpretation's value, and a cap's figures while its kind is asked; the version still parses", () => {
    const rb = rulebook();
    const review = interpretations(rb, { amendment: false });
    const v = { status: "draft", review };
    const hidden = withheldPaths(v);
    expect(hidden).toEqual(expect.arrayContaining(["/payment/visitPayment/value", "/invoiceables/0/cap/kind", "/invoiceables/0/cap/n", "/invoiceables/0/cap/ratio"]));
    const shown = mask(rb, hidden, { evidence: [], review });
    expect([shown.payment.visitPayment.value, shown.invoiceables[0]!.cap.kind, shown.invoiceables[0]!.cap.n, shown.siteFees[0]!.trigger]).toEqual([null, null, null, null]);
    expect(JSON.stringify(shown)).not.toMatch(/auto_edc|agreement_execution|77700/);
    const dto = { version: 1, status: "draft", createdAt: "", signedBy: null, signedAt: null, appliesFrom: null, studyId: "s", rulebook: shown, anomalies: [], editors: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, evidence: [], review, pdfCheck: null, byHand: false, proofread: [], updatedAt: "", warnings: [] };
    expect(RulebookVersionDto.safeParse(dto).success).toBe(true);
  });

  it("the log withholds a skipped correction while it's asked again where its item moved (`askedAt`)", () => {
    const skipped = [{ path: "/siteFees/0/amountCents", before: 100, after: 200, reason: "item_moved", askedAt: "/siteFees/1/amountCents" }];
    const out = blindDetail("version.corrections_carried", { version: 2, skipped }, { hidden: new Set(["/siteFees/1/amountCents"]), review: [], evidence: [] });
    expect(out.skipped).toEqual([{ path: "/siteFees/0/amountCents", reason: "item_moved", askedAt: "/siteFees/1/amountCents" }]);
  });
});

const ev = (path: string, status: ValueEvidence["status"] = "confirmed"): ValueEvidence => ({ path, status, where: [], printed: null, note: null });
const cells = (n: number) => Array.from({ length: n }, (_, i) => ev(`/budgetGrids/0/procedures/${i}/cells/V1`));

describe("the blind sample", () => {
  const families = [...cells(500), ev("/budgetGrids/0/visits/0/totalCents"), ev("/budgetGrids/0/visits/1/totalCents"), ev("/siteFees/0/amountCents"), ev("/invoiceables/0/amountCents"), ev("/payment/netDays/value"), ev("/overhead/pct/value"), ev("/siteFees/0/dueDays")];

  it("10 confirmed values, spread over the kinds of value instead of all grid cells", () => {
    for (let k = 0; k < 20; k++) {
      const picked = pickSample(families, new Set());
      expect(new Set(picked).size).toBe(10);
      const by = picked.map(familyOf);
      for (const f of ["cells", "totals", "fees", "rules"] as const) expect(by.filter((x) => x === f).length, f).toBeGreaterThanOrEqual(2);
    }
  });

  it("random (cryptographic): draws differ; all of them when there are fewer; never a value asked already or not confirmed", () => {
    const draws = new Set(Array.from({ length: 10 }, () => pickSample(cells(500), new Set()).join()));
    expect(draws.size).toBeGreaterThan(1);
    const few = [ev("/payment/netDays/value"), ev("/siteFees/0/amountCents"), ev("/overhead/pct/value", "conflict"), ev("/holdback/pct", "attested")];
    expect(pickSample(few, new Set(["/siteFees/0/amountCents"])).sort()).toEqual(["/payment/netDays/value"]);
    expect(pickSample(few, new Set(), () => 0.5, 10)).toHaveLength(2);
  });

  it("a miss holds approval until every value of its kind is proofread or typed by a person", () => {
    const missed: ReviewItem = { id: "sample:x", kind: "confirm_value", reason: "SAMPLE", path: "/siteFees/0/amountCents", question: "", input: "money", options: [], where: [], blocking: true, answer: null, outcome: "chosen", compare: null, sentBack: null, missed: true };
    const evidence = [ev("/siteFees/0/amountCents", "attested"), ev("/siteFees/1/amountCents"), ev("/invoiceables/0/amountWithOverheadCents"), ev("/payment/netDays/value")];
    const [m] = sampleMisses({ review: [missed], evidence, proofread: [{ path: "/siteFees/1/amountCents", by: "Sam", at: "" }] });
    expect(m).toEqual({ family: "fees", label: "fee and invoiceable amounts", total: 3, left: ["/invoiceables/0/amountWithOverheadCents"] });
    expect(sampleMissWords(m!)).toBe("A random spot check found a wrong number among the fee and invoiceable amounts, so each of them has to be proofread before approval: 1 of 3 still to check.");
    expect(sampleMisses({ review: [{ ...missed, missed: undefined }], evidence })).toEqual([]);
  });
});
