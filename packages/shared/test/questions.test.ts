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
  ROW_ARITHMETIC,
  cards,
  openCards,
  ROUNDING_NOTICE,
  suggest,
  answerQuestion,
  isoDate,
  SIGNED_DATE_DIFFERS,
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

  it("an amount or count limit placed by its own row's quantity × unit price = total isn't asked, quote or not; a count found in a sentence is", () => {
    const rb = rulebook(); // the read cites no quote
    const row = (status: ValueEvidence["status"], note: string | null = ROW_ARITHMETIC) => ({ amendment: false, evidence: [{ path: "/invoiceables/0/cap/n", status, note }] });
    for (const kind of ["amount", "count"] as const) {
      rb.invoiceables[0]!.cap = cap(kind, 25);
      expect(paths(rb, row("confirmed"))).not.toContain("/invoiceables/0/cap/kind");
      // confirmed some other way (a count in a sentence can be a ratio), or the row's figure not confirmed: asked, as before
      expect(paths(rb, row("confirmed", null))).toContain("/invoiceables/0/cap/kind");
      for (const status of ["attested", "conflict", "ungrounded", "confirmed_by_math"] as const) expect(paths(rb, row(status))).toContain("/invoiceables/0/cap/kind");
      const unclear = [{ code: "AMBIGUOUS_TERM" as const, path: "/invoiceables/0/cap", message: "Ambiguous", refs: [] }];
      expect(paths(rb, { ...row("confirmed"), anomalies: unclear })).toContain("/invoiceables/0/cap/kind");
    }
    // blocks and ratios have no row figure, and a screen failure's limit is always asked
    rb.invoiceables[0]!.cap = cap("blocks_with_reauth", 25);
    expect(paths(rb, row("confirmed"))).toContain("/invoiceables/0/cap/kind");
    rb.screenFail!.cap = cap("count", 25);
    expect(paths(rb, { amendment: false, evidence: [{ path: "/screenFail/cap/n", status: "confirmed", note: ROW_ARITHMETIC }] })).toContain("/screenFail/cap/kind");
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

  it("a flag on a cap or a fee asks the interpretation fields under it, even where the figure is confirmed", () => {
    const rb = quoted();
    const sure = [{ path: "/invoiceables/0/cap/n", status: "confirmed" as const }, { path: "/siteFees/0/amountCents", status: "confirmed" as const }];
    rb.siteFees[0]!.trigger = "one_time";
    const printed = new Map([["/siteFees/0/trigger", "one-time payment"]]);
    // stated outright and confirmed: not asked
    expect(interpretations(rb, { amendment: false, evidence: sure, printed }).map((i) => i.path)).not.toEqual(expect.arrayContaining(["/invoiceables/0/cap/kind"]));
    for (const [path, field] of [["/invoiceables/0/cap", "/invoiceables/0/cap/kind"], ["/invoiceables/0", "/invoiceables/0/cap/kind"], ["/siteFees/0", "/siteFees/0/trigger"]] as const) {
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

  it("a flag on a whole list is asked once, on its own, never folded into each item's question", () => {
    const rb = quoted();
    rb.siteFees[0]!.trigger = "one_time";
    const sure = [{ path: "/siteFees/0/amountCents", status: "confirmed" as const }];
    const printed = new Map([["/siteFees/0/trigger", "one-time payment"]]);
    const a = flag("/siteFees"); // "IRB fees have no amount": about the list, not about each fee's trigger
    const items = interpretations(rb, { amendment: false, anomalies: [a] });
    for (const i of items.filter((x) => x.path?.startsWith("/siteFees/"))) {
      expect(i.reason, i.path!).toBe("INTERPRETATION");
      expect(i.question.startsWith("Ambiguous"), i.path!).toBe(false);
    }
    // a trigger printed beside its confirmed amount still goes unasked: the list's flag doesn't make each fee unclear
    expect(interpretations(rb, { amendment: false, evidence: sure, printed, anomalies: [a] }).map((i) => i.path)).not.toContain("/siteFees/0/trigger");
    expect(askedAsInterpretation(a, new Set(items.map((i) => i.path!)))).toBe(false);
    // never lost: the contract problem asks it once, blocking, with its message
    const asked = fromAnomalies([a], rb, new Set());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ reason: "AMBIGUOUS_TERM", path: "/siteFees", blocking: true });
    expect(asked[0]!.question.startsWith("Ambiguous: per subject or for the whole study.")).toBe(true);
    // a flag on one fee is still that fee's question
    expect(askedAsInterpretation(flag("/siteFees/0"), new Set(["/siteFees/0/trigger"]))).toBe(true);
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

describe("rounding the contract is silent on is a notice, not a question (owner, 2026-11-02)", () => {
  const roundingAsked = (rb: Rulebook, roundingSaid?: boolean, anomalies: ContractAnomaly[] = []) => interpretations(rb, { amendment: false, roundingSaid, anomalies }).some((i) => i.path === "/rounding/value");
  it("not asked when the read quotes nothing about it and the contract's text never mentions it", () => {
    expect(roundingAsked(rulebook(), false)).toBe(false);
  });
  it("asked when the read quotes a clause, the text mentions rounding anywhere, nothing says which, or the wording is flagged", () => {
    const quoted = rulebook();
    quoted.rounding = s("printed_amounts", "Amounts are rounded to the nearest whole dollar");
    expect(roundingAsked(quoted, false)).toBe(true);
    expect(roundingAsked(rulebook(), true)).toBe(true);
    expect(roundingAsked(rulebook(), undefined)).toBe(true);
    const flag: ContractAnomaly = { id: "AMBIGUOUS_TERM:/rounding", code: "AMBIGUOUS_TERM", severity: "warning", message: "Unclear rounding", path: "/rounding", refs: [], detail: {}, resolution: null };
    expect(roundingAsked(rulebook(), false, [flag])).toBe(true);
  });
  it("the notice says printed figures are billed to the cent, only while nothing asks or answered it, on a read contract with no quote", () => {
    const rb = rulebook();
    const none = { review: [], evidence: [] };
    expect(notices([], rb, none)).toEqual([{ id: "rounding", message: ROUNDING_NOTICE, where: [] }]);
    expect(ROUNDING_NOTICE).toMatch(/printed figures are billed to the cent/);
    expect(notices([], rb, { review: [{ path: "/rounding/value" }], evidence: [] })).toEqual([]);
    expect(notices([], rb, { review: [], evidence: [{ path: "/rounding/value" }] })).toEqual([]);
    expect(notices([], rb)).toEqual([]); // no questions given: not known
    const quoted = rulebook();
    quoted.rounding = s("cents", "rounded to the cent");
    expect(notices([], quoted, none)).toEqual([]);
    const typed = rulebook();
    typed.rounding = { value: "unspecified", prov: { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } };
    expect(notices([], typed, none)).toEqual([]);
  });
});

describe("cards: questions citing the identical quote on the same page are one card", () => {
  const q = (id: string, cites?: { page: number; quote: string }, outcome: ReviewItem["outcome"] = null): ReviewItem => ({
    id, kind: "interpretation", reason: "INTERPRETATION", path: `/${id}`, question: id, input: null, options: [], where: [], blocking: true, answer: null, outcome, compare: null, sentBack: null,
    ...(cites ? { cites: { documentId: "d1", ...cites } } : {}),
  });
  const ids = (cs: ReviewItem[][]) => cs.map((c) => c.map((i) => i.id));
  it("the screen-fail basis, cap and how it's paid, on one sentence, are one card; each keeps its own question", () => {
    const rb = rulebook();
    rb.screenFail = { ...rb.screenFail!, cap: cap("count", 5), prov: prov("Screen failures are paid $500 each, up to 5, by invoice.") };
    const items = interpretations(rb, { amendment: false });
    const card = cards(items).find((c) => c.length > 1)!;
    expect(card.map((i) => i.path)).toEqual(["/screenFail/basis", "/screenFail/cap/kind", "/screenFail/paidVia"]);
    expect(new Set(card.map((i) => i.id)).size).toBe(3);
    expect(cards(items)).toHaveLength(items.length - 2);
  });
  it("never by field name or alike wording: two clauses, the same words on another page, or no quote stay apart", () => {
    const items = [
      q("a", { page: 3, quote: "Screen failures are paid $500 each." }),
      q("b", { page: 3, quote: "Screen failures are paid $500 each, up to 5." }),
      q("c", { page: 4, quote: "Screen failures are paid $500 each." }),
      q("d", { page: 3, quote: "screen failures are paid $500 each." }),
      q("e"),
      q("f"),
      q("g", { page: 3, quote: "Screen failures  are paid\n$500 each." }),
    ];
    expect(ids(cards(items))).toEqual([["a", "g"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  });
  it("a money term's sentence joins the identical sentence's card in another document or on another page; a different sentence never", () => {
    const term = (id: string, documentId: string, page: number, quote: string): ReviewItem => ({ ...q(id), kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, where: [{ documentId, page, box: null }], term: { quote, amounts: [] } });
    const P = "Payments are made quarterly within 45 days of receipt of invoice.";
    const SF = "Screen failures are paid $500 each.";
    const items = [
      term("a", "base", 7, P),
      term("b", "amendment", 2, P), // the amendment repeats the base contract's paragraph word for word
      term("c", "amendment", 3, "Payments are made monthly within 45 days of receipt of invoice."),
      term("d", "amendment", 4, `  ${P.replace("within", "within\n")}`),
      q("e", { page: 3, quote: SF }),
      term("f", "amendment", 5, SF),
      q("g", { page: 4, quote: SF }), // the same clause cited on another page stays its own card
    ];
    expect(ids(cards(items))).toEqual([["a", "b", "d"], ["c"], ["e", "f"], ["g"]]);
  });

  it("two fees whose triggers sit in one footnote are one card; two whose own rows are quoted are two", () => {
    const rb = rulebook();
    const fee = rb.siteFees[0]!;
    rb.siteFees = [fee, { ...fee, name: "Close-out" }, { ...fee, name: "Archiving", prov: prov("Archiving fee, payable at close-out") }];
    rb.invoiceables = [];
    const byFee = cards(interpretations(rb, { amendment: false }).filter((i) => /^\/siteFees\//.test(i.path ?? "")));
    expect(byFee.map((c) => c.map((i) => i.path))).toEqual([["/siteFees/0/trigger", "/siteFees/1/trigger"], ["/siteFees/2/trigger"]]);
  });
  it("needs you counts the cards with a question open; every question is still answered on its own", () => {
    const one = { page: 3, quote: "One clause." };
    const items = [q("a", one), q("b", one, "matched"), q("c", one, "cant_tell"), q("d", { page: 3, quote: "Another." }, "chosen")];
    expect(ids(openCards(items))).toEqual([["a", "c"]]);
    // answering one question of a card leaves the other open
    const rb = rulebook();
    rb.screenFail = { ...rb.screenFail!, prov: prov("Screen failures are paid $500 each, by invoice.") };
    const review = interpretations(rb, { amendment: false });
    const d = { version: 1, byHand: false, rulebook: rb, review, evidence: [], editors: [] };
    const r = answerQuestion(d, "interpret:/screenFail/basis", { optionId: "fixed", by: "Sam" }, { isoDate, now: "2026-11-02T00:00:00Z" });
    expect(r).toMatchObject({ outcome: "matched" });
    expect(openCards(d.review).find((c) => c.some((i) => i.path === "/screenFail/paidVia"))!.map((i) => i.path)).toEqual(["/screenFail/paidVia"]);
  });
});

describe("a date tied to the last signature: the e-signature record's latest date is suggested, never written", () => {
  const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    id: "anomaly:AMBIGUOUS_TERM:/study/effectiveDate", kind: "interpretation", reason: "AMBIGUOUS_TERM", path: "/study/effectiveDate/value", question: "q", input: "date", options: [],
    where: [{ documentId: "d1", page: 21, box: null }], blocking: true, answer: null, outcome: null, compare: null, sentBack: null,
    signedOn: { date: "2023-08-16", page: 21, printed: "2023-08-16" }, ...over,
  });
  it("two dates for one term (SIGNED_DATE_DIFFERS): nothing suggested, and the pick writes the date picked", () => {
    const rb = rulebook();
    const q = item({ id: "signed:/study/effectiveDate/value", kind: "contract_problem", reason: SIGNED_DATE_DIFFERS, input: null, signedOn: undefined, options: [{ id: "2025-01-10", label: "a" }, { id: "2025-01-11", label: "b" }] });
    expect(suggest(q, { rulebook: rb, evidence: [] })).toBeNull();
    const d = { version: 1, byHand: false, rulebook: rb, review: [q], evidence: [] as ValueEvidence[], editors: [] as string[] };
    expect(answerQuestion(d, q.id, { optionId: "2025-01-11", by: "Sam" }, { isoDate, now: "2026-11-02T00:00:00Z" })).toMatchObject({ outcome: "chosen", set: { path: "/study/effectiveDate/value", before: "2025-01-10", after: "2025-01-11" } });
    expect(d.rulebook.study.effectiveDate.value).toBe("2025-01-11");
  });

  it("suggested on an open date question, with the record's page, even with no value read; nothing once settled or without a record", () => {
    const rb = rulebook();
    rb.study.effectiveDate = s(null);
    expect(suggest(item(), { rulebook: rb, evidence: [] })).toMatchObject({ value: "2023-08-16", why: expect.stringMatching(/e-signature record \(page 21\)/) });
    expect(suggest(item({ outcome: "chosen" }), { rulebook: rb, evidence: [] })).toBeNull();
    expect(suggest(item({ signedOn: undefined }), { rulebook: rb, evidence: [] })).toBeNull();
    // taking it is typing it: chosen by the person, attested, and the master holds nothing until then
    const d = { version: 1, byHand: false, rulebook: rb, review: [item()], evidence: [] as ValueEvidence[], editors: [] as string[] };
    expect(answerQuestion(d, item().id, { value: "2023-08-16", by: "Sam" }, { isoDate, now: "2026-11-02T00:00:00Z" })).toMatchObject({ outcome: "chosen" });
    expect(d.rulebook.study.effectiveDate.value).toBe("2023-08-16");
    expect(d.evidence).toEqual([expect.objectContaining({ path: "/study/effectiveDate/value", status: "attested" })]);
  });
});
