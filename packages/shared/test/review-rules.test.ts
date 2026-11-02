import { describe, expect, it } from "vitest";
import { type AnswerDraft, answerQuestion, appliesFromOf, askAbout, capFollowUps, interpretations, isoDate, noLimitTyped, type Rulebook, type ValueEvidence } from "../src";

// Rules once checked only through the web's in-browser copy of the API (removed 2026-11-01), now on the shared
// functions themselves.

const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const s = <T>(value: T) => ({ value, prov });
const cap = (kind: Rulebook["invoiceables"][number]["cap"]["kind"], n: number | null = null, ratio: number | null = null) => ({ kind, n, ratio });

function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme"), payingAgent: s(null), protocol: s("P-1"), siteName: s("Site A"), investigator: s("Dr. A"), effectiveDate: s("2025-08-21"), currency: "USD" },
    documents: [{ id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" }],
    referencedDocuments: [],
    overhead: { pct: s(25), appliesTo: s("procedures_only") },
    payment: { visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s([]), paymentConditions: s([]) },
    budgetGrids: [],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: ["Parking", "Re-consent"].map((name, i) => ({
      code: null, name, amountCents: 1200, amountWithOverheadCents: null, basis: "fixed" as const, frequency: "per visit",
      cap: i === 0 ? cap("amount", 500000) : cap("count", 3), requiresPreApproval: false, requiredDocs: [], prov,
    })),
    screenFail: { amountCents: 50000, basis: "fixed", cap: cap("count"), paidVia: "invoice", requiredDocs: [], prov },
    siteFees: [],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("cents"),
    appliesFrom: s(null),
    unclassified: [],
  };
}
const draft = (rb: Rulebook, review: AnswerDraft["review"], evidence: ValueEvidence[] = []): AnswerDraft => ({ version: 1, byHand: false, rulebook: rb, review, evidence, editors: [] });
const say = (d: AnswerDraft, id: string, body: Record<string, unknown>) => answerQuestion(d, id, { by: "Sam", ...body }, { isoDate, now: "2026-11-01T09:00:00.000Z" });
const outcome = (d: AnswerDraft, id: string, body: Record<string, unknown>) => {
  const r = say(d, id, body);
  return "refusal" in r ? r.refusal.status : r.unchanged ? "unchanged" : r.outcome;
};

describe("a question about one value (askAbout)", () => {
  it("names the value by its label, and asks an amount cap's limit as money, a count cap's as a number", () => {
    const rb = rulebook();
    expect(askAbout(rb, [], "/payment/netDays/value", "q", "reported")).toMatchObject({ input: "number", question: "What value is printed for Payment › Net days?" });
    expect(askAbout(rb, [], "/invoiceables/0/amountCents", "q", "reported")).toMatchObject({ input: "money", question: "What amount is printed for Invoiceable › Parking › Amount?" });
    expect(["/invoiceables/0/cap/n", "/invoiceables/1/cap/n"].map((p) => askAbout(rb, [], p, "q", "reported").input)).toEqual(["money", "number"]);
  });
});

describe("answering", () => {
  it("compares a typed date with a date the PDF prints in words, as the binder reads it", () => {
    const rb = rulebook(); // the read says 21 August; the page prints the 22nd
    const q = askAbout(rb, [], "/study/effectiveDate/value", "q", "reported");
    expect(q.input).toBe("date");
    const d = draft(rb, [q], [{ path: q.path!, status: "conflict", where: [], printed: "August 22, 2025", note: null }]);
    expect(outcome(d, "q", { value: "2025-08-22" })).toBe("matched");
  });

  it("an interpretation picked other than the read: shown with the read, needs a note, then kept as the person's", () => {
    const rb = rulebook();
    const d = draft(rb, interpretations(rb, { amendment: false }));
    const id = "interpret:/payment/visitPayment/value";
    expect(rb.payment.visitPayment.value).toBe("auto_edc"); // our reading, shown while asked
    expect(outcome(d, id, { optionId: "invoice" })).toBe("differs");
    expect(d.review.find((i) => i.id === id)!.compare).toMatchObject({ typed: "invoice", read: "auto_edc" });
    expect(outcome(d, id, { optionId: "invoice" })).toBe(400);
    expect(outcome(d, id, { optionId: "invoice", note: "§4.1: visits are invoiced" })).toBe("chosen");
    expect(d.review.find((i) => i.id === id)!.answer).toMatchObject({ noPdfText: true });
    expect(d.rulebook.payment.visitPayment.value).toBe("invoice");
  });

  it("a cap kind other than the read's asks its limit again, as the new kind counts it", () => {
    const rb = rulebook();
    const d = draft(rb, interpretations(rb, { amendment: false }));
    const id = "interpret:/screenFail/cap/kind";
    expect(outcome(d, id, { optionId: "amount" })).toBe("differs");
    const r = say(d, id, { optionId: "amount", note: "§5: at most $5,000" });
    if ("refusal" in r || r.unchanged) throw new Error("not answered");
    expect(r.outcome).toBe("chosen");
    const asked = capFollowUps(d, r.item, true, (p, qid, reason) => askAbout(d.rulebook, d.evidence, p, qid, reason));
    expect(asked).toMatchObject([{ id: "cap:/screenFail/cap/n", reason: "CAP_KIND_CHANGED", input: "money", outcome: null }]);
  });
});

describe("typing a cap by hand (noLimitTyped)", () => {
  const FIGURE = "This cap is set to “No limit”, so there's no limit to type here. If the contract does set one, change the cap's kind first.";
  const KIND = "This cap still has a limit typed, so it can't be “No limit”. Clear the limit first, or pick the kind of limit the contract sets.";
  const withCap = (c: ReturnType<typeof cap>) => {
    const rb = rulebook();
    rb.screenFail!.cap = c;
    return rb;
  };

  it("refuses a limit or ratio on “No limit”, whichever is typed second, and the cap typed whole", () => {
    expect(noLimitTyped(withCap(cap("none")), withCap(cap("none", 7)), "/screenFail/cap/n")).toBe(FIGURE);
    expect(noLimitTyped(withCap(cap("none")), withCap(cap("none", null, 0.5)), "/screenFail/cap/ratio")).toBe(FIGURE);
    expect(noLimitTyped(withCap(cap("none")), withCap(cap("none", 7)), "/screenFail")).toBe(FIGURE);
    expect(noLimitTyped(withCap(cap("count", 7)), withCap(cap("none", 7)), "/screenFail/cap/kind")).toBe(KIND);
  });

  it("allows a limit on another kind, “No limit” once the limit is cleared, and clearing an old one a figure at a time", () => {
    expect(noLimitTyped(withCap(cap("count")), withCap(cap("count", 7)), "/screenFail/cap/n")).toBeNull();
    expect(noLimitTyped(withCap(cap("count")), withCap(cap("none")), "/screenFail/cap/kind")).toBeNull();
    expect(noLimitTyped(withCap(cap("none", 7, 0.5)), withCap(cap("none", null, 0.5)), "/screenFail/cap/n")).toBeNull();
  });
});

describe("the date a version's terms apply from (appliesFromOf)", () => {
  it("is the amendment's start date, or else the contract's effective date", () => {
    const rb = rulebook();
    expect(appliesFromOf(rb)).toBe("2025-08-21");
    rb.appliesFrom = s("2026-09-01");
    expect(appliesFromOf(rb)).toBe("2026-09-01");
  });
});
