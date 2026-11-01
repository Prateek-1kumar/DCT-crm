import { describe, expect, it } from "vitest";
import {
  askedAsInterpretation,
  calendarDay,
  type ContractAnomaly,
  fromAnomalies,
  isNotice,
  notices,
  dateField,
  interpretations,
  triggerOf,
  type ReviewItem,
  type Rulebook,
  RulebookVersionDto,
  type ValueEvidence,
  ValueEvidence as ValueEvidenceSchema,
  openPaths,
} from "../src";

// The review lists that aren't flags (ADR-001 §6): interpretations, asked only for genuine ambiguity or silence (a clause that
// states its figure, or a fee's trigger printed beside its amount, goes unasked: ADR-002 §4, ADR-003); and what a typed date must be.

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

  it("nothing preselected or answered, the field's own values, the quote and names as printed", () => {
    const items = interpretations(rulebook(), { amendment: false });
    expect(items.every((i) => i.blocking && i.kind === "interpretation" && i.answer === null && i.outcome === null)).toBe(true);
    const overhead = items[0]!;
    expect(overhead.question).toBe("Which lines does the overhead apply to? The contract says: “25% overhead on procedure costs”");
    expect(overhead.options.map((o) => o.id)).toEqual(["procedures_only", "procedures_and_staff", "all_per_patient_lines", "none", "unspecified"]);
    expect(items.find((i) => i.path === "/screenFail/basis")!.options.map((o) => o.id)).toEqual(["fixed", "per_procedure"]); // not an invoiceable's
    expect(items.find((i) => i.path === "/invoiceables/0/cap/kind")).toMatchObject({ question: "What limit does the contract put on billing “Mileage $0.67”?", options: expect.arrayContaining([{ id: "amount", label: "A total amount at most" }]) });
    expect(items.find((i) => i.path === "/siteFees/0/trigger")!.question).toMatch(/“due within 30 days of execution”$/);
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
      // the amendment's own date is typed with it, blind: the read's date of a document is checked by nothing
      options: [{ id: "prospective", label: "Prospective only: from the amendment's own date" }],
    });
    rb.documents[1]!.date = "1 March 2026"; // a date the read gives in words: offered all the same, as the date is typed
    expect(interpretations(rb, { amendment: false }).find((i) => i.path === "/appliesFrom/value")!.options.map((o) => o.id)).toEqual(["prospective"]);
  });

  it("an AMBIGUOUS_TERM about one of them is that question, marked, its message first", () => {
    const [item] = interpretations(rulebook(), { amendment: false, anomalies: [{ code: "AMBIGUOUS_TERM", path: "/overhead/appliesTo", message: "Ambiguous: whether 25% covers stipends", refs: [{ documentId: "d1", page: 7 }] }] });
    expect(item).toMatchObject({ reason: "AMBIGUOUS_TERM", where: [{ documentId: "d1", page: 3, box: null }, { documentId: "d1", page: 7, box: null }] });
    expect(item!.question).toMatch(/^Ambiguous: whether 25% covers stipends\. Which lines/);
    expect(item!.options.map((o) => o.id)).not.toContain("unspecified");
  });
});

describe("interpretations the clause states outright (ADR-002 §4)", () => {
  const quoted = () => {
    const rb = rulebook();
    rb.invoiceables[0]!.prov = prov("billed up to $777.00 in total");
    return rb;
  };
  const paths = (rb: Rulebook, opts: Parameters<typeof interpretations>[1]) => interpretations(rb, opts).map((i) => i.path);
  const sure = (status: ValueEvidence["status"]) => [{ path: "/invoiceables/0/cap/n", status }];

  it("an amount limit whose figure is confirmed from its quote isn't asked; its figure isn't withheld", () => {
    const rb = quoted();
    expect(paths(rb, { amendment: false })).toContain("/invoiceables/0/cap/kind"); // no evidence: asked, as before
    for (const status of ["confirmed", "confirmed_by_math"] as const) expect(paths(rb, { amendment: false, evidence: sure(status) })).not.toContain("/invoiceables/0/cap/kind");
    const review = interpretations(rb, { amendment: false, evidence: sure("confirmed") });
    expect(openPaths({ status: "draft", review, evidence: [] })).not.toEqual(expect.arrayContaining(["/invoiceables/0/cap/n"]));
  });

  it("is still asked when the figure isn't confirmed, the read cites no quote, the term is ambiguous, or the kind needs more than a figure", () => {
    const rb = quoted();
    for (const status of ["attested", "conflict", "ungrounded"] as const) expect(paths(rb, { amendment: false, evidence: sure(status) })).toContain("/invoiceables/0/cap/kind");
    const noQuote = rulebook();
    expect(paths(noQuote, { amendment: false, evidence: sure("confirmed") })).toContain("/invoiceables/0/cap/kind");
    const unclear = [{ code: "AMBIGUOUS_TERM" as const, path: "/invoiceables/0/cap/kind", message: "Ambiguous", refs: [] }];
    expect(paths(rb, { amendment: false, evidence: sure("confirmed"), anomalies: unclear })).toContain("/invoiceables/0/cap/kind");
    // a count (or blocks) reads as a bare number, which a ratio also is: never told by its figure
    rb.invoiceables[0]!.cap = cap("count", 3);
    expect(paths(rb, { amendment: false, evidence: sure("confirmed") })).toContain("/invoiceables/0/cap/kind");
    // and the kinds with no deciding figure are asked whatever is confirmed
    const everything = ["/overhead/pct/value", "/payment/netDays/value", "/siteFees/0/dueDays", "/siteFees/0/amountCents", "/screenFail/cap/n"].map((path) => ({ path, status: "confirmed" as const }));
    expect(paths(rulebook(), { amendment: false, evidence: everything })).toEqual(paths(rulebook(), { amendment: false }));
  });

  it("a ratio limit is told by its confirmed ratio", () => {
    const rb = quoted();
    rb.invoiceables[0]!.cap = { kind: "ratio_to_randomized", n: null, ratio: 0.5 };
    expect(paths(rb, { amendment: false, evidence: [{ path: "/invoiceables/0/cap/ratio", status: "confirmed" }] })).not.toContain("/invoiceables/0/cap/kind");
    expect(paths(rb, { amendment: false, evidence: sure("confirmed") })).toContain("/invoiceables/0/cap/kind");
  });

  it("a start date printed in its quote and confirmed isn't asked; one missing, unconfirmed or retroactive is", () => {
    const rb = rulebook();
    rb.documents.push({ id: "d2", kind: "amendment", title: "Amendment 1", date: "2026-03-01" });
    rb.appliesFrom = s("2026-03-01", "effective March 1, 2026");
    const date = (status: ValueEvidence["status"]) => ({ amendment: true, evidence: [{ path: "/appliesFrom/value", status }] });
    expect(paths(rb, date("confirmed"))).not.toContain("/appliesFrom/value");
    expect(paths(rb, date("conflict"))).toContain("/appliesFrom/value");
    const retro = [{ code: "RETROACTIVE_NO_DATE" as const, path: "/appliesFrom/value", message: "x", refs: [] }];
    expect(paths(rb, { ...date("confirmed"), anomalies: retro })).toContain("/appliesFrom/value");
    rb.appliesFrom = s(null);
    expect(interpretations(rb, date("confirmed")).find((i) => i.path === "/appliesFrom/value")).toMatchObject({ reason: "RETROACTIVE_NO_DATE" });
  });
});

describe("a typed date", () => {
  it("in a date field, is a day of the calendar written YYYY-MM-DD (an answer and typing by hand check it alike)", () => {
    expect(["/study/effectiveDate/value", "/appliesFrom/value", "/documents/0/date", "/referencedDocuments/2/date"].every(dateField)).toBe(true);
    expect(["/overhead/appliesTo/value", "/payment/netDays/value", "/deadlines/0/value", "/study/sponsor/value"].some(dateField)).toBe(false);
    expect(["2024-02-29", "2025-12-31"].every(calendarDay)).toBe(true);
    expect(["2025-02-29", "2025-06-31", "2025-13-01", "2025-8-22", "August 22, 2025", "", null, 20250822].some(calendarDay)).toBe(false);
  });
});


const ev = (path: string, status: ValueEvidence["status"] = "confirmed"): ValueEvidence => ({ path, status, where: [], printed: null, note: null });

describe("a fee's trigger the page prints beside its amount (ADR-003)", () => {
  it("names one trigger from a fixed phrase, or none", () => {
    expect(["one-time payment", "One time", "per year", "Annually", "per sample", "per ad campaign approved by sponsor", "at close-out", "at actual cost", "on study initiation"].map(triggerOf)).toEqual([
      "one_time", "one_time", "annual", "annual", "per_event", "per_event", "closeout", "actual_cost", "study_initiation",
    ]);
    expect(["per enrolled patient", "each visit", "per SAE report", "one time only", "upon execution of the agreement", "annually, prorated"].map(triggerOf)).toEqual([
      "per_event", "per_event", "per_event", "one_time", "agreement_execution", "annual",
    ]);
    // vague, or two triggers at once: asked
    expect(["paid per terms within the exhibit", "as agreed", "one-time payment, then per year"].map(triggerOf)).toEqual([null, null, null]);
    // fails closed (a match skips the question): a reference to a document or its terms names no event, a period the
    // triggers don't hold names none, "once" as a condition isn't a single payment, a later document's signing isn't the agreement's
    expect([
      "payable per Exhibit B", "paid per Section 4.2 below", "per protocol", "per the budget", "per site, upon activation", "each party shall bear its own costs",
      "per month", "per patient per month", "invoiced quarterly", "each week", "semi-annually",
      "paid once the IRB approves", "once the site is activated",
      "upon execution of each amendment", "on execution of every renewal",
    ].map(triggerOf)).toEqual(Array(15).fill(null));
  });

  it("isn't asked when the fee's amount is confirmed and its printed words name the read's trigger; asked otherwise", () => {
    const rb = rulebook();
    rb.siteFees[0]!.trigger = "one_time";
    const at = "/siteFees/0/trigger";
    const sure = [{ path: "/siteFees/0/amountCents", status: "confirmed" as const }];
    const asked = (opts: Partial<Parameters<typeof interpretations>[1]>) => interpretations(rb, { amendment: false, ...opts }).map((i) => i.path).includes(at);
    expect(asked({ evidence: sure, printed: new Map([[at, "one-time payment"]]) })).toBe(false);
    expect(asked({ evidence: sure, printed: new Map([[at, "per year"]]) })).toBe(true); // the page says another trigger: a person decides
    expect(asked({ evidence: sure, printed: new Map([[at, "paid per terms of the exhibit"]]) })).toBe(true); // names none
    expect(asked({ evidence: [], printed: new Map([[at, "one-time payment"]]) })).toBe(true); // the amount isn't confirmed at that row
    expect(asked({ evidence: sure })).toBe(true); // nothing printed beside it
    expect(asked({ evidence: sure, printed: new Map([[at, "one-time payment"]]), anomalies: [{ code: "AMBIGUOUS_TERM", path: at, message: "unclear", refs: [] }] })).toBe(true);
  });
});

describe("unclear wording about anything the master holds is asked, never only a notice", () => {
  const flag = (path: string | null): ContractAnomaly => ({ id: `AMBIGUOUS_TERM:${path}`, code: "AMBIGUOUS_TERM", severity: "warning", message: "Ambiguous: per subject or for the whole study", path, refs: [{ documentId: "d1", page: 3 }], detail: {}, resolution: null });
  const quoted = () => {
    const rb = rulebook();
    rb.invoiceables[0]!.prov = prov("billed up to $777.00 in total");
    return rb;
  };

  it("a flag on a cap, a fee or a section asks the interpretation fields under it, even where the figure is confirmed", () => {
    const rb = quoted();
    const sure = [{ path: "/invoiceables/0/cap/n", status: "confirmed" as const }, { path: "/siteFees/0/amountCents", status: "confirmed" as const }];
    rb.siteFees[0]!.trigger = "one_time";
    const printed = new Map([["/siteFees/0/trigger", "one-time payment"]]);
    // stated outright and confirmed: not asked
    expect(interpretations(rb, { amendment: false, evidence: sure, printed }).map((i) => i.path)).not.toEqual(expect.arrayContaining(["/invoiceables/0/cap/kind"]));
    for (const [path, field] of [["/invoiceables/0/cap", "/invoiceables/0/cap/kind"], ["/invoiceables/0", "/invoiceables/0/cap/kind"], ["/siteFees/0", "/siteFees/0/trigger"], ["/siteFees", "/siteFees/0/trigger"]] as const) {
      const a = flag(path);
      expect(isNotice(a, rb), path).toBe(false);
      expect(notices([a], rb), path).toEqual([]);
      const item = interpretations(rb, { amendment: false, evidence: sure, printed, anomalies: [a] }).find((i) => i.path === field);
      expect(item, path).toMatchObject({ reason: "AMBIGUOUS_TERM", blocking: true });
      expect(item!.question.startsWith("Ambiguous: per subject or for the whole study.")).toBe(true);
      // asked once: there, not again as a contract problem
      expect(askedAsInterpretation(a, new Set([field])), path).toBe(true);
    }
    // a sibling's path isn't a parent's: "/siteFees/1" says nothing about "/siteFees/10"
    expect(askedAsInterpretation(flag("/siteFees/1"), new Set(["/siteFees/10/trigger"]))).toBe(false);
  });

  it("a flag on a {value, prov} wrapper with no interpretation field asks its value", () => {
    const rb = rulebook();
    const a = flag("/payment/netDays");
    expect(isNotice(a, rb)).toBe(false);
    expect(askedAsInterpretation(a, new Set(interpretations(rb, { amendment: false, anomalies: [a] }).map((i) => i.path!)))).toBe(false);
    expect(fromAnomalies([a], rb, new Set())).toMatchObject([{ path: "/payment/netDays/value", reason: "AMBIGUOUS_TERM", kind: "interpretation", blocking: true }]);
  });

  it("a flag on an item with no field to pick is still asked, as a contract problem", () => {
    const rb = rulebook(); // the SAE report has no cap, so no interpretation field
    const a = flag("/invoiceables/1");
    expect(isNotice(a, rb)).toBe(false);
    expect(fromAnomalies([a], rb, new Set())).toMatchObject([{ reason: "AMBIGUOUS_TERM", blocking: true }]);
  });

  it("only a flag about nothing the master holds is a notice", () => {
    const rb = rulebook();
    for (const path of [null, "/nothingHere", "/siteFees/5"]) {
      expect(isNotice(flag(path), rb), String(path)).toBe(true);
      expect(fromAnomalies([flag(path)], rb, new Set()), String(path)).toEqual([]);
    }
  });
});
