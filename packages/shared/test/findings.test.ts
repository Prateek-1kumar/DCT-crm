import { describe, expect, it } from "vitest";
import {
  type AnswerDraft,
  answerQuestion,
  armKey,
  askAbout,
  billedGrids,
  blindDetail,
  blindEvidence,
  blindReview,
  BODY_WORDS,
  bodyProblem,
  type BudgetGrid,
  capFollowUps,
  type ContractAnomaly,
  familyOf,
  followUps,
  fromAnomalies,
  gridChoice,
  gridPrices,
  interpretations,
  isoDate,
  mask,
  openItems,
  parseCents,
  parsePercent,
  placeholders,
  ReportValueBody,
  searchVersion,
  type ReviewItem,
  type Rulebook,
  RulebookVersionDto,
  SAMPLE,
  settled,
  signOffRefusal,
  typingDone,
  type ValueEvidence,
  versionDiff,
  withheldPaths,
} from "../src";

// Regression cases for the review findings of 2026-10-29: each failed before its fix. Shared code, so they hold for the
// API and the in-browser sample server alike.

const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const s = <T>(value: T) => ({ value, prov });
const V = "/budgetGrids/0/visits/0";
const TOTAL = `${V}/totalCents`;
const box = (y: number) => [{ documentId: "d1", page: 1, box: [0.1, y, 0.8, 0.02] as [number, number, number, number] }];

const grid = (id = "g1", cells: Record<string, number> = { V1: 10000 }): BudgetGrid => ({
  id, label: id === "g1" ? "Exhibit A" : "Exhibit A (revised)", arm: null, statedOverheadPct: null, header: { investigator: null, siteName: null }, prov, perPatientTotals: [],
  visits: [{ code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 10000, overheadCents: 4000, nonProcedureCents: null, totalCents: 15000, autopay: true, prov }],
  procedures: [{ code: null, name: "Exam", unitCents: 10000, overheadApplied: true, category: "procedure", cells, prov }],
});

function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme"), payingAgent: s(null), protocol: s("P-1"), siteName: s("Site A"), investigator: s("Dr. A"), effectiveDate: s("2025-08-21"), currency: "USD" },
    documents: [{ id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" }],
    referencedDocuments: [],
    overhead: { pct: s(25), appliesTo: s("procedures_only") },
    payment: { visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s([]), paymentConditions: s([]) },
    budgetGrids: [grid()],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [],
    screenFail: { amountCents: 50000, basis: "fixed", cap: { kind: "count", n: null, ratio: null }, paidVia: "invoice", requiredDocs: [], prov },
    siteFees: [{ code: null, name: "Archiving fee $250", amountCents: 25000, trigger: "closeout", dueDays: 45, prov }],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("cents"),
    appliesFrom: s(null),
    unclassified: [],
  };
}
const ev = (path: string, status: ValueEvidence["status"], printed: string | null = null, where: ValueEvidence["where"] = box(0.5)): ValueEvidence => ({ path, status, where, printed, note: null });
const draft = (review: ReviewItem[], evidence: ValueEvidence[] = [], rb = rulebook()): AnswerDraft & { anomalies: ContractAnomaly[] } => ({ version: 1, byHand: false, rulebook: rb, review, evidence, editors: [], anomalies: [] });
const say = (d: AnswerDraft, id: string, body: Record<string, unknown>) => {
  const r = answerQuestion(d, id, { by: "Sam", ...body }, { isoDate, now: "2026-10-29T09:00:00.000Z" });
  if ("refusal" in r) throw new Error(r.refusal.message);
  return r;
};
const refusal = (d: AnswerDraft, id: string, body: Record<string, unknown>) => {
  const r = answerQuestion(d, id, { by: "Sam", ...body }, { isoDate, now: "" });
  return "refusal" in r ? r.refusal : null;
};
/** The checks as the API runs them, enough for these: a visit total that isn't its parts added up. */
const checks = (rb: Rulebook): ContractAnomaly[] =>
  rb.budgetGrids.flatMap((g, gi) =>
    g.visits.flatMap((v, vi) => {
      const parts = (v.procedureSubtotalCents ?? 0) + (v.overheadCents ?? 0) + (v.nonProcedureCents ?? 0);
      const path = `/budgetGrids/${gi}/visits/${vi}/totalCents`;
      return parts === v.totalCents ? [] : [{ id: `VISIT_TOTAL_MISMATCH:${path}`, code: "VISIT_TOTAL_MISMATCH" as const, severity: "warning" as const, message: `printed total ${v.totalCents} ≠ parts ${parts}`, path, refs: [], detail: {}, resolution: null }];
    }),
  );
const ask = (d: AnswerDraft) => (p: string, id: string, reason: string) => askAbout(d.rulebook, d.evidence, p, id, reason);

describe("1. a total that doesn't add up: 'as printed' after 'the sum' puts the printed total back", () => {
  it("each answer writes its own number, whichever came first", () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 15100; // printed one dollar over its parts
    const [q] = fromAnomalies(checks(rb), rb, new Set());
    expect(q).toMatchObject({ asPrinted: 15100 });
    const d = draft([q!], [ev(TOTAL, "confirmed", "151.00")], rb);
    say(d, q!.id, { optionId: "sum", note: "Ask the sponsor" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(14000);
    say(d, q!.id, { optionId: "printed", note: "The sponsor says the printed total governs" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15100);
    say(d, q!.id, { optionId: "sum", note: "Back to the sum" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(14000);
  });

  it("its printed total is never shown while its grid holds a withheld value", () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 15100;
    const [q] = fromAnomalies(checks(rb), rb, new Set());
    expect(blindReview([q!], [TOTAL])[0]).not.toHaveProperty("asPrinted");
  });
});

describe("2. a money term whose sentence runs over lines quotes a withheld value on another line", () => {
  // the fee's due days on line 1 (y 0.10), the term's 1.5% on line 2 (y 0.13): one sentence
  const quote = "SC003 Administrative fee $12,000.00 due within 45 days of initiation, and late payments accrue interest at 1.5% per month.";
  const term = (answer: ReviewItem["answer"] = null): ReviewItem => ({
    id: "u1", kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, question: `Page 1 has a payment term that the invoicing master doesn't have: "${quote}". How should it be handled?`,
    input: null, options: [{ id: "bill_by_hand", label: "Bill by hand" }], where: box(0.13), quoted: [...box(0.1), ...box(0.13)], blocking: true,
    answer, outcome: answer ? "chosen" : null, compare: null, sentBack: answer ? null : { by: "Ben", note: "45 days, check it", at: "" }, term: { quote, amounts: [], pct: 1.5 },
  });
  const hidden = ["/siteFees/0/dueDays"];
  const evidence = [ev("/siteFees/0/dueDays", "confirmed", "45", box(0.1))];

  it("blanks the question, the term, every note on it, the bill-by-hand entry and the log", () => {
    const [shown] = blindReview([term()], hidden, evidence);
    expect(JSON.stringify(shown)).not.toMatch(/45|12,000|1\.5/);
    const listed = term({ optionId: "bill_by_hand", note: "Interest at 1.5%, next to the 45 days", by: "Asha", at: "" });
    const rb = { ...rulebook(), unclassified: [{ label: "SC003 Administrative fee $12,000.00 due within 45…", quote, page: 1, amounts: [], pct: 1.5, note: "Interest at 1.5%", prov: { ...prov, method: "manual" as const }, itemId: "u1" }] };
    expect(JSON.stringify(mask(rb, hidden, { evidence, review: [listed] }).unclassified)).not.toMatch(/45|12,000|1\.5/);
    const logged = { version: 1, itemId: "u1", question: listed.question, note: listed.answer!.note, billByHand: rb.unclassified[0]!.label };
    expect(JSON.stringify(blindDetail("review.answered", logged, { hidden: new Set(hidden), evidence, review: [listed] }))).not.toMatch(/45|12,000|1\.5/);
    // its figures' own line alone (an item stored before `quoted`) holds nothing withheld: shown as it was
    const { quoted: _, ...old } = term();
    expect(blindReview([old], hidden, evidence)[0]!.question).toMatch(/45 days/);
  });
});

describe("3. a 'bill by hand' answer whose note changes", () => {
  it("puts the new note on the master", () => {
    const page: ReviewItem = {
      id: "page:d1:1", kind: "unaccounted", reason: "SCAN_PAGE", path: null, question: "Page 1 is a scan…", input: null, blocking: true, where: [{ documentId: "d1", page: 1, box: null }],
      options: [{ id: "none", label: "No" }, { id: "bill_by_hand", label: "Yes", note: "What on this page is billed by hand?" }], answer: null, outcome: null, compare: null, sentBack: null,
    };
    const d = draft([page]);
    say(d, page.id, { optionId: "bill_by_hand", note: "Parking, $12 a visit" });
    const r = say(d, page.id, { optionId: "bill_by_hand", note: "Parking, $120 a visit" });
    expect(d.rulebook.unclassified.map((u) => u.note)).toEqual(["Parking, $120 a visit"]);
    expect(r.log?.detail).toMatchObject({ billByHand: "Page 1 of “Work order”", note: "Parking, $120 a visit" });
  });
});

describe("4. a settled total is asked again once its answer no longer holds", () => {
  const setUp = () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 15100;
    const [q] = fromAnomalies(checks(rb), rb, new Set());
    const overhead = askAbout(rb, [], `${V}/overheadCents`, "reported:1", "reported");
    const d = draft([q!, overhead], [ev(TOTAL, "confirmed", "151.00"), ev(`${V}/overheadCents`, "confirmed", "40.00")], rb);
    return { d, q: q! };
  };
  const answerAndFollow = (d: ReturnType<typeof setUp>["d"], id: string, body: Record<string, unknown>) => followUps(d, say(d, id, body), checks, ask(d));

  it("'the sum' after one of its parts is corrected", () => {
    const { d, q } = setUp();
    expect(answerAndFollow(d, q.id, { optionId: "sum", note: "Ask the sponsor" })).toEqual([]);
    expect(d.review.find((i) => i.id === q.id)!.outcome).toBe("chosen");
    expect(answerAndFollow(d, "reported:1", { value: 5000 })).toEqual([]);
    // asked again, and said so: the runtime logs what followUps returns
    expect(answerAndFollow(d, "reported:1", { value: 5000, note: "the page prints $50.00" })).toEqual([{ action: "review.reopened", detail: { version: 1, itemId: q.id, path: TOTAL, question: q.question } }]);
    const again = d.review.find((i) => i.id === q.id)!;
    expect(again).toMatchObject({ outcome: null, answer: null, asPrinted: 15100 });
    expect(openItems(d.review).map((i) => i.id)).toEqual([q.id]);
    // and "as printed" still means the total the contract prints, not the sum written since
    answerAndFollow(d, q.id, { optionId: "printed", note: "Ask the sponsor" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15100);
  });

  it("'as printed' after another answer rewrites the total itself: that answer is what's printed now", () => {
    const { d, q } = setUp();
    answerAndFollow(d, "reported:1", { value: 4000 });
    answerAndFollow(d, q.id, { optionId: "printed", note: "Ask the sponsor" });
    d.review.push(askAbout(d.rulebook, d.evidence, TOTAL, "reported:2", "reported"));
    answerAndFollow(d, "reported:2", { value: 15200 });
    answerAndFollow(d, "reported:2", { value: 15200, note: "the page prints $152.00" });
    expect(d.review.find((i) => i.id === q.id)).toMatchObject({ outcome: null, asPrinted: 15200 });
  });

  it("nothing asked again while the answer still holds", () => {
    const { d, q } = setUp();
    answerAndFollow(d, q.id, { optionId: "printed", note: "Ask the sponsor" });
    expect(answerAndFollow(d, "reported:1", { value: 4000 })).toEqual([]);
    expect(d.review.find((i) => i.id === q.id)!.outcome).toBe("chosen");
  });
});

describe("5. the blind sample measures the PDF check: it shows nothing of it", () => {
  const cell = "/budgetGrids/0/procedures/0/cells/V1";
  const sampled = () => {
    const rb = rulebook();
    const evidence = [ev(cell, "confirmed", "100.00"), ev("/budgetGrids/0/procedures/0/unitCents", "confirmed")];
    return draft([askAbout(rb, evidence, cell, "q", SAMPLE)], evidence, rb);
  };

  it("points at its page, never at the spot the check bound it to; the question names row and column", () => {
    const d = sampled();
    expect(d.review[0]!.where).toEqual([{ documentId: "d1", page: 1, box: null }]);
    expect(d.review[0]!.question).toBe("What amount is printed for Budget grid › Exhibit A › Procedures › Exam › V1?");
    // other questions still point at their value's spot
    expect(askAbout(d.rulebook, d.evidence, cell, "r", "reported").where).toEqual(box(0.5));
  });

  it("a differing answer shows nothing and is typed again blind: the confirmed value again is a typo, settled", () => {
    const d = sampled();
    expect(say(d, "q", { value: 10100 })).toMatchObject({ outcome: "differs" });
    expect(d.review[0]!.compare).toBeNull();
    expect(say(d, "q", { value: 10000 })).toMatchObject({ outcome: "matched", missed: false });
  });

  it("anything else the second time is a miss, whatever it is: nothing to try until it matches, no note asked", () => {
    const d = sampled();
    say(d, "q", { value: 10100 });
    const r = say(d, "q", { value: 10200 });
    expect(r).toMatchObject({ outcome: "chosen", missed: true, incident: { count: 1 } });
    expect(d.rulebook.budgetGrids[0]!.procedures[0]!.cells.V1).toBe(10200);
  });
});

describe("6. 'prospective only' never writes the read's date of the amendment as a person's", () => {
  const amended = () => {
    const rb = rulebook();
    rb.documents.push({ id: "d2", kind: "amendment", title: "Amendment 1", date: "2026-03-01" });
    const items = interpretations(rb, { amendment: true, anomalies: [{ code: "RETROACTIVE_NO_DATE", path: "/appliesFrom/value", message: "x", refs: [] }] });
    return draft(items, [], rb);
  };
  const Q = "interpret:/appliesFrom/value";

  it("doesn't show the date, and needs it typed", () => {
    const d = amended();
    expect(d.review.find((i) => i.id === Q)!.options).toEqual([{ id: "prospective", label: "Prospective only: from the amendment's own date" }]);
    expect(JSON.stringify(d.review.find((i) => i.id === Q))).not.toMatch(/2026|March/);
    expect(refusal(d, Q, { optionId: "prospective" })).toEqual({ status: 400, message: "Type the amendment's own date, as it's printed on the amendment." });
  });

  it("the typed date is checked against the read's: the same matches, another differs and shows both", () => {
    const d = amended();
    expect(say(d, Q, { optionId: "prospective", value: "2026-03-01" })).toMatchObject({ outcome: "matched", set: { after: "2026-03-01" } });
    expect(d.evidence).toEqual([expect.objectContaining({ path: "/appliesFrom/value", status: "attested", note: "Typed by Sam" })]);
    const e = amended();
    expect(say(e, Q, { optionId: "prospective", value: "2026-03-02" })).toMatchObject({ outcome: "differs", set: undefined });
    expect(e.review.find((i) => i.id === Q)!.compare).toEqual({ typed: "2026-03-02", read: "2026-03-01", printed: null });
    expect(e.rulebook.appliesFrom.value).toBeNull();
  });
});

describe("7. a cap whose kind needs a figure the master doesn't have", () => {
  it("asks it once the kind is settled, confirmed as read or not", () => {
    const rb = rulebook(); // screen failures: at most a count, its limit not read
    const d = draft(interpretations(rb, { amendment: false }), [], rb);
    const r = say(d, "interpret:/screenFail/cap/kind", { optionId: "count" });
    expect(r.outcome).toBe("matched");
    expect(capFollowUps(d, r.item, false, ask(d)).map((i) => [i.id, i.reason])).toEqual([["cap:/screenFail/cap/n", "REQUIRED_MISSING"]]);
  });
});

describe("8. amounts and percentages, read one way everywhere", () => {
  it.each([
    ["$7,455.00.", 745500],
    ["(1,500.00)", -150000],
    ["($500.00", 50000], // a bracket closed elsewhere opens a remark, not a credit
    ["US$ 98", 9800],
    ["-12.05", -1205],
    ["12.", 1200],
    ["1,23", null],
    ["0.585", null], // a fraction of a cent: never rounded into a match
    ["abc", null],
  ])("parseCents(%s) is %s", (t, cents) => expect(parseCents(t)).toBe(cents));
  it("a bracket restating words isn't a credit", () => expect(parseCents("($3,000.00)", { restates: true })).toBe(300000));
  it.each([["1.5%.", 1.5], ["40 percent", 40], ["%", null], ["4,5", null], ["1,000", 1000]])("parsePercent(%s) is %s", (t, n) => expect(parsePercent(t)).toBe(n));
});

describe("9. two grids for one arm are never both billed", () => {
  it("the same prices: one is billed, and says the other prices the same; a single cell apart: none until one is chosen", () => {
    const rb = { ...rulebook(), budgetGrids: [grid("g1"), grid("g2")] };
    expect(billedGrids(rb).map((g) => g.id)).toEqual(["g1"]);
    expect(gridChoice(rb, rb.budgetGrids[1]!)).toMatchObject({ billed: false, instead: { id: "g1" }, same: true });
    const apart = { ...rb, budgetGrids: [grid("g1"), grid("g2", { V1: 9000 })] };
    expect(billedGrids(apart)).toEqual([]);
    expect(gridChoice(apart, apart.budgetGrids[0]!)).toEqual({ billed: false, instead: null, same: false });
    expect(billedGrids({ ...apart, governingGridIds: ["g2"] }).map((g) => g.id)).toEqual(["g2"]);
  });
});

describe("10. what a withheld interpretation decides, row by row, is withheld with it", () => {
  it("each visit's 'paid automatically' with how visits are paid, each row's overhead with its scope; the version still parses", () => {
    const rb = rulebook();
    const review = interpretations(rb, { amendment: false });
    const v = { status: "draft", review, rulebook: rb };
    const hidden = withheldPaths(v);
    expect(hidden).toEqual(expect.arrayContaining(["/payment/visitPayment/value", `${V}/autopay`, "/overhead/appliesTo/value", "/budgetGrids/0/procedures/0/overheadApplied"]));
    const shown = mask(rb, hidden, { evidence: [], review });
    expect([shown.budgetGrids[0]!.visits[0]!.autopay, shown.budgetGrids[0]!.procedures[0]!.overheadApplied]).toEqual([null, null]);
    const dto = { version: 1, status: "draft" as const, createdAt: "", signedBy: null, signedAt: null, appliesFrom: null, studyId: "s", rulebook: shown, anomalies: [], editors: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, evidence: [], review, pdfCheck: null, byHand: false, proofread: [], updatedAt: "", warnings: [] };
    expect(RulebookVersionDto.safeParse(dto).success).toBe(true);
    // a contract problem's numbers in that grid aren't blanked for them
    const problem = { id: `anomaly:VISIT_TOTAL_MISMATCH:${TOTAL}`, kind: "contract_problem" as const, reason: "VISIT_TOTAL_MISMATCH", path: null, question: "printed total $151.00 ≠ $140.00", input: null, options: [], where: [], blocking: false, answer: null, outcome: null, compare: null, sentBack: null };
    expect(blindReview([problem], [`${V}/autopay`])[0]!.question).toMatch(/151/);
    // nor are its rows hidden from a search by amount: a yes/no is never matched by one
    const searched = { ...v, evidence: [] };
    expect(searchVersion(searched, "150.00").map((h) => h.path)).toEqual([V]);
    expect(searchVersion({ ...searched, review: [...review, askAbout(rb, [], TOTAL, "r", "reported")] }, "150.00")).toEqual([]);
  });
});

describe("11. typing by hand asks every default nobody chose", () => {
  const blank = (): Rulebook => ({ ...rulebook(), screenFail: null, siteFees: [], budgetGrids: [{ ...grid(), visits: [{ ...grid().visits[0]!, totalCents: 0 }] }] });

  it("a yes/no or fixed-list value nobody typed or picked is asked, as a blind pick", () => {
    const rb = blank();
    const typed = [ev(TOTAL, "attested"), ev("/payment/netDays/value", "attested")];
    const asked = placeholders(rb, typed);
    for (const p of [`${V}/autopay`, "/budgetGrids/0/procedures/0/overheadApplied", "/budgetGrids/0/procedures/0/category", "/payment/visitPayment/value"]) expect(asked).toContain(p);
    expect(asked).not.toContain(TOTAL);
    const q = askAbout(rb, typed, `${V}/autopay`, "missing:x", "REQUIRED_MISSING");
    expect([q.input, q.options.map((o) => o.id)]).toEqual([null, ["true", "false"]]);
    expect(askAbout(rb, typed, "/budgetGrids/0/procedures/0/category", "m", "REQUIRED_MISSING").options.map((o) => o.id)).toEqual(["procedure", "non_procedure"]);
  });

  it("marking typing done: the re-type sample by its path, the checks on what was typed, and the questions counted", () => {
    const rb = blank();
    const d = { version: 1, status: "draft", byHand: true, rulebook: rb, review: [], evidence: [ev("/payment/netDays/value", "attested")] };
    const done = typingDone(d, { random: () => 0.5, checks });
    if ("refusal" in done) throw new Error(done.refusal.message);
    expect(done.review[0]).toMatchObject({ id: "spot:/payment/netDays/value", reason: "spot_check" });
    expect(done.anomalies.map((a) => a.code)).toEqual(["VISIT_TOTAL_MISMATCH"]);
    expect(done.detail).toEqual({ version: 1, typed: 1, "re-type": 1, questions: done.review.length - 1 });
    expect(typingDone({ ...d, review: done.review }, { random: () => 0.5, checks })).toEqual({ refusal: { status: 409, message: "Typing is already marked done." } });
  });
});

describe("12. the log shows no amount a withheld value's label names", () => {
  it("blanks amounts in `value` while its question is open", () => {
    const rb = rulebook();
    const q = askAbout(rb, [], "/siteFees/0/amountCents", "reported:1", "reported");
    const entry = { version: 1, path: "/siteFees/0/amountCents", value: "Site fee › Archiving fee $250 › Amount", note: "check" };
    expect(blindDetail("number.reported", entry, { hidden: new Set(["/siteFees/0/amountCents"]), review: [q], evidence: [] }).value).toBe("Site fee › Archiving fee ••• › Amount");
  });
});

describe("13. 'needs you' and the gate agree", () => {
  it("a can't tell on a question not needed to approve still needs you", () => {
    const q = { ...askAbout(rulebook(), [], "/payment/netDays/value", "q", "reported"), blocking: false, outcome: "cant_tell" as const };
    expect(openItems([q])).toEqual([q]);
  });
});

describe("15. lows", () => {
  it("a grid's stated overhead is checked with the percentages", () => expect(familyOf("/budgetGrids/0/statedOverheadPct")).toBe("rules"));

  it("a money term's send-back note has its numbers blanked while it quotes a withheld value's line", () => {
    const t: ReviewItem = {
      id: "u1", kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, question: "Page 1 has an amount: \"Fee $100.00\".", input: null, options: [], where: box(0.5), blocking: true,
      answer: null, outcome: null, compare: null, sentBack: { by: "Ben", note: "It's $100, not $10", at: "" },
    };
    expect(blindReview([t], ["/siteFees/0/amountCents"], [ev("/siteFees/0/amountCents", "conflict", "$100.00")])[0]!.sentBack!.note).toBe("It's $•••, not $•••");
  });

  it("a typed date is a day of the calendar", () => {
    const d = draft([askAbout(rulebook(), [], "/study/effectiveDate/value", "q", "reported")]);
    for (const value of ["next tuesday", "2025-02-30", "2025-8-1"]) expect(refusal(d, "q", { value })).toEqual({ status: 400, message: "That isn't a date. Pick the day the contract gives." });
    expect(say(d, "q", { value: "2025-08-21" }).outcome).toBe("matched");
  });

  it("'No limit' closes a question still open about the cap's figures", () => {
    const rb = rulebook();
    const d = draft(interpretations(rb, { amendment: false }), [], rb);
    followUps(d, say(d, "interpret:/screenFail/cap/kind", { optionId: "count" }), checks, ask(d));
    expect(d.review.some((i) => i.id === "cap:/screenFail/cap/n" && !settled(i))).toBe(true);
    say(d, "interpret:/screenFail/cap/kind", { optionId: "none" }); // other than the read: confirmed with a note
    say(d, "interpret:/screenFail/cap/kind", { optionId: "none", note: "§5 sets no limit" });
    expect(d.review.some((i) => i.id === "cap:/screenFail/cap/n")).toBe(false);
    expect(d.rulebook.screenFail!.cap).toEqual({ kind: "none", n: null, ratio: null });
  });

  it("a refused body says what's missing, field by field", () => {
    const r = ReportValueBody.safeParse({ path: "/x", by: "Sam" });
    expect(!r.success && bodyProblem(r.error, BODY_WORDS.report)).toBe("Add a short note saying what looks wrong.");
    const nobody = ReportValueBody.safeParse({ path: "/x", note: "n" });
    expect(!nobody.success && bodyProblem(nobody.error, BODY_WORDS.report)).toBe("Say who is reporting.");
    expect(refusal(draft([askAbout(rulebook(), [], "/payment/netDays/value", "q", "reported")]), "q", { by: "Sam", optionId: 3 })).toEqual({ status: 400, message: "Pick one of the options." });
  });
});

describe("16. the sample server's diff is the API's", () => {
  it("refuses a version with no master, and masks both sides alike", () => {
    const v = { status: "draft", review: [], evidence: [], rulebook: rulebook() };
    expect(versionDiff({ ...v, rulebook: null }, v)).toEqual({ refusal: { status: 409, message: "Both versions need an extracted rulebook to diff" } });
    const after = { ...v, rulebook: { ...rulebook(), payment: { ...rulebook().payment, netDays: s(30) } }, review: [askAbout(rulebook(), [], "/payment/netDays/value", "q", "reported")] };
    expect(versionDiff({ ...v, status: "signed" }, after)).toEqual([]);
  });
});

// ---- The second review of 2026-10-29: each `it` failed before its fix. ----

/** The arithmetic check and the grid check, as the API runs them: grids for one arm that price anything differently. */
const withGrids = (rb: Rulebook): ContractAnomaly[] => {
  const arms = new Map<string, number[]>();
  rb.budgetGrids.forEach((g, i) => arms.set(armKey(g), [...(arms.get(armKey(g)) ?? []), i]));
  const grids = [...arms.values()].flatMap((idxs): ContractAnomaly[] =>
    new Set(idxs.map((i) => gridPrices(rb.budgetGrids[i]!))).size < 2 ? [] : [{ id: `GRID_CONFLICT:/budgetGrids/${idxs[0]}`, code: "GRID_CONFLICT", severity: "blocker", message: "grids disagree", path: `/budgetGrids/${idxs[0]}`, refs: [], detail: { gridIds: idxs.map((i) => rb.budgetGrids[i]!.id) }, resolution: null }],
  );
  return [...checks(rb), ...grids];
};
const answerAndFollow = (d: ReturnType<typeof draft>, id: string, body: Record<string, unknown>, by = "Sam") => {
  const r = answerQuestion(d, id, { by, ...body }, { isoDate, now: "" });
  if ("refusal" in r) throw new Error(r.refusal.message);
  return { r, logged: r.unchanged ? [] : followUps(d, r, withGrids, ask(d)) };
};
const approvable = (d: ReturnType<typeof draft>) => signOffRefusal({ ...d, status: "draft", updatedAt: "t" }, { asOf: "t", by: "Ben", makerChecker: false });

describe("C1. two grids for one arm that an answer makes differ", () => {
  const CELL = "/budgetGrids/1/procedures/0/cells/V1";
  // their visits add up, so nothing else is asked
  const twin = (id: string) => ({ ...grid(id), visits: grid(id).visits.map((v) => ({ ...v, totalCents: 14000 })) });
  const twins = () => {
    const rb = { ...rulebook(), budgetGrids: [twin("g1"), twin("g2")] };
    return draft([askAbout(rb, [], CELL, "reported:1", "reported")], [ev(CELL, "confirmed", "100.00")], rb);
  };

  it("asks which grid to bill once a typed number makes them differ, and approval waits for it", () => {
    const d = twins();
    expect(billedGrids(d.rulebook).map((g) => g.id)).toEqual(["g1"]);
    answerAndFollow(d, "reported:1", { value: 9000 });
    answerAndFollow(d, "reported:1", { value: 9000, note: "the signed page prints $90.00" });
    const q = d.review.find((i) => i.reason === "GRID_CONFLICT")!;
    expect(q).toMatchObject({ id: "anomaly:GRID_CONFLICT:/budgetGrids/0", outcome: null, options: [{ id: "g1" }, { id: "g2" }] });
    expect(approvable(d)).toBe("1 question still needs an answer before this can be approved.");
    // asked once: another number written in the grid doesn't ask it again
    d.review.push(askAbout(d.rulebook, d.evidence, "/budgetGrids/1/procedures/0/unitCents", "reported:2", "reported"));
    answerAndFollow(d, "reported:2", { value: 10000 });
    expect(d.review.filter((i) => i.reason === "GRID_CONFLICT")).toHaveLength(1);
    answerAndFollow(d, q.id, { optionId: "g2" });
    expect([billedGrids(d.rulebook).map((g) => g.id), approvable(d)]).toEqual([["g2"], null]);
  });

  it("approval names the arm that bills no grid, however the master got there", () => {
    const d = draft([], [], { ...rulebook(), budgetGrids: [grid("g1"), grid("g2", { V1: 9000 })] });
    expect(approvable(d)).toBe("Choose which budget grid to bill for this contract.");
    d.rulebook.budgetGrids = d.rulebook.budgetGrids.map((g) => ({ ...g, arm: "Arm A" }));
    expect(approvable(d)).toBe("Choose which budget grid to bill for Arm A.");
    d.rulebook.governingGridIds = ["g1"];
    expect(approvable(d)).toBeNull();
  });
});

describe("H1. the blind sample's final answer can't be reset", () => {
  const cell = "/budgetGrids/0/procedures/0/cells/V1";
  const sampled = () => {
    const rb = rulebook();
    const evidence = [ev(cell, "confirmed", "100.00"), ev("/budgetGrids/0/procedures/0/unitCents", "confirmed")];
    return draft([askAbout(rb, evidence, cell, "q", SAMPLE)], evidence, rb);
  };

  it("through can't tell: the next answer still stands, and a wrong one is a miss", () => {
    const d = sampled();
    expect(say(d, "q", { value: 10100 })).toMatchObject({ outcome: "differs" });
    expect(say(d, "q", { cantTell: true })).toMatchObject({ outcome: "cant_tell" });
    expect(d.review[0]).toMatchObject({ retyped: true });
    expect(approvable(d)).toBe("1 question still needs an answer before this can be approved."); // unresolved: approval waits
    expect(say(d, "q", { value: 10200 })).toMatchObject({ outcome: "chosen", missed: true, incident: { count: 1 } });
  });

  it("through a send-back, a repeat and a changed answer", () => {
    const d = sampled();
    say(d, "q", { value: 10100 });
    // the approver sends it back (the route clears the answer)
    Object.assign(d.review[0]!, { outcome: null, answer: null, compare: null, sentBack: { by: "Ben", note: "look again", at: "" } });
    expect(say(d, "q", { value: 10200 })).toMatchObject({ outcome: "chosen", missed: true });
    const e = sampled();
    say(e, "q", { value: 10100 });
    expect(say(e, "q", { value: 10000 })).toMatchObject({ outcome: "matched", missed: false }); // a typo, settled
    expect(say(e, "q", { value: 10000 }).unchanged).toBe(true);
    expect(say(e, "q", { value: 10300, note: "changed my mind" })).toMatchObject({ outcome: "chosen", missed: true });
  });

  it("an item stored before the mark: its 'differs' is the mark", () => {
    const d = sampled();
    Object.assign(d.review[0]!, { outcome: "differs", answer: { value: 10100, by: "Sam", at: "" } });
    expect(say(d, "q", { cantTell: true }).item.retyped).toBeUndefined();
    Object.assign(d.review[0]!, { outcome: "differs" });
    expect(say(d, "q", { value: 10200 })).toMatchObject({ outcome: "chosen", missed: true });
  });
});

describe("M1. a withheld value's spot on the page", () => {
  it("is its page only, with nothing printed; other values keep theirs", () => {
    const evidence = [ev("/a", "confirmed", "100.00"), ev("/b", "confirmed", "5.00")];
    expect(blindEvidence(evidence, ["/a"])).toEqual([{ ...evidence[0]!, printed: null, where: [{ documentId: "d1", page: 1, box: null }] }, evidence[1]]);
  });
});

describe("M2. the amendment's own date while the start date is typed blind", () => {
  it("is withheld with it, and the version still parses", () => {
    const rb = rulebook();
    rb.documents.push({ id: "d2", kind: "amendment", title: "Amendment 1", date: "2026-03-15" });
    const review = interpretations(rb, { amendment: true });
    const v = { status: "draft", review, rulebook: rb };
    expect(withheldPaths(v)).toEqual(expect.arrayContaining(["/appliesFrom/value", "/documents/1/date"]));
    expect(withheldPaths(v)).not.toContain("/documents/0/date"); // the work order's date isn't what it's checked against
    const shown = mask(rb, withheldPaths(v), { evidence: [], review });
    expect(shown.documents.map((d) => d.date)).toEqual(["2025-01-10", null]);
    const dto = { version: 2, status: "draft" as const, createdAt: "", signedBy: null, signedAt: null, appliesFrom: null, studyId: "s", rulebook: shown, anomalies: [], editors: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, evidence: [], review, pdfCheck: null, byHand: false, proofread: [], updatedAt: "", warnings: [] };
    expect(RulebookVersionDto.safeParse(dto).success).toBe(true);
  });
});

describe("M3. the log while an amount of the same item is re-typed blind", () => {
  it("blanks amounts in another value's label and typed text of that item, not of another item", () => {
    const rb = rulebook();
    const open = { hidden: new Set(["/siteFees/0/amountCents"]), review: [askAbout(rb, [], "/siteFees/0/amountCents", "spot:/siteFees/0/amountCents", "spot_check")], evidence: [] };
    const typed = { version: 1, path: "/siteFees/0/name", value: "Site fee › Archiving fee $250 › Name", before: "", after: "Archiving fee $250" };
    expect(blindDetail("value.typed", typed, open)).toEqual({ ...typed, value: "Site fee › Archiving fee ••• › Name", after: "Archiving fee •••" });
    const other = { ...typed, path: "/siteFees/1/name" };
    expect(blindDetail("value.typed", other, open)).toEqual(other);
  });
});

describe("M4. 'as printed' on a total asked before its printed value was kept", () => {
  const old = (path = TOTAL) => {
    const rb = rulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 15100;
    const found = checks(rb).map((a) => ({ ...a, detail: { expected: 14000, actual: 15100 } }));
    const [q] = fromAnomalies(found, rb, new Set());
    const { asPrinted: _, ...stored } = q!;
    return { ...draft([{ ...stored, id: `anomaly:VISIT_TOTAL_MISMATCH:${path}` }], [ev(TOTAL, "confirmed", "151.00")], rb), anomalies: path === TOTAL ? found : [] };
  };

  it("puts back what the read's check found printed", () => {
    const d = old();
    const id = d.review[0]!.id;
    say(d, id, { optionId: "sum", note: "Ask the sponsor" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(14000);
    say(d, id, { optionId: "printed", note: "The sponsor says the printed total governs" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15100);
  });

  it("with nothing to say what's printed, refuses it, and “This looks wrong” asks it again with the total typed", () => {
    const d = old("/elsewhere");
    const id = d.review[0]!.id;
    expect(refusal(d, id, { optionId: "printed", note: "?" })).toMatchObject({ status: 409, message: expect.stringMatching(/^This question was asked before the app kept the total as printed/) });
    expect(d.review[0]!.outcome).toBeNull(); // the refusal changes nothing
    answerAndFollow(d, id, { optionId: "sum", note: "Ask the sponsor" });
    d.review.push(askAbout(d.rulebook, d.evidence, TOTAL, "reported:1", "reported"));
    answerAndFollow(d, "reported:1", { value: 15100 });
    answerAndFollow(d, "reported:1", { value: 15100, note: "the page prints $151.00" });
    expect(d.review[0]).toMatchObject({ outcome: null, asPrinted: 15100 });
    answerAndFollow(d, id, { optionId: "printed", note: "As printed" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15100);
  });
});

describe("M5. a withheld value found only by its page", () => {
  const term = (id: string, page: number, quote: string): ReviewItem => ({
    id, kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, question: `Page ${page} has a payment term: "${quote}".`, input: null, options: [], blocking: true,
    where: [{ documentId: "d1", page, box: [0.1, 0.2, 0.5, 0.02] }], answer: null, outcome: null, compare: null, sentBack: null, term: { quote, amounts: [], days: 37 },
  });
  const terms = [term("u1", 1, "Sponsor shall pay each invoice within 37 days."), term("u2", 2, "Parking is paid at $12.00 a visit.")];
  const NET = "/payment/netDays/value";

  it("blanks every money term on its page, none on another", () => {
    const [p1, p2] = blindReview(terms, [NET], [ev(NET, "ungrounded", null, [{ documentId: "d1", page: 1, box: null }])]);
    expect(JSON.stringify(p1)).not.toMatch(/37/);
    expect(p2).toEqual(terms[1]);
  });

  it("with no page at all, blanks every money term", () => {
    expect(JSON.stringify(blindReview(terms, [NET], [ev(NET, "ungrounded", null, [])]))).not.toMatch(/37|12\.00/);
  });
});

describe("L1. a percentage in brackets", () => {
  it.each([["(15%)", 15], ["15%).", 15], ["fifteen percent (15%)", 15], ["(1.5%", 1.5], ["30 days (15%)", null]])("parsePercent(%s) is %s", (t, n) => expect(parsePercent(t)).toBe(n));
});

describe("L2. a cap answered 'No limit'", () => {
  it("closes every open question about its figures, logged, and refuses a figure there after", () => {
    const rb = rulebook();
    rb.screenFail!.cap = { kind: "count", n: 7, ratio: null };
    const d = draft(interpretations(rb, { amendment: false }), [ev("/screenFail/cap/n", "confirmed", "7")], rb);
    answerAndFollow(d, "interpret:/screenFail/cap/kind", { optionId: "count" });
    d.review.push({ ...askAbout(d.rulebook, d.evidence, "/screenFail/cap/n", "reported:1", "reported"), reported: { by: "Ben", note: "?", at: "" } });
    answerAndFollow(d, "interpret:/screenFail/cap/kind", { optionId: "none" });
    const { logged } = answerAndFollow(d, "interpret:/screenFail/cap/kind", { optionId: "none", note: "§3 sets no limit" });
    expect(d.review.some((i) => i.id === "reported:1")).toBe(false);
    expect(logged).toEqual([{ action: "review.closed", detail: expect.objectContaining({ itemId: "reported:1", path: "/screenFail/cap/n" }) }]);
    expect(d.rulebook.screenFail!.cap).toEqual({ kind: "none", n: null, ratio: null });
    d.review.push(askAbout(d.rulebook, d.evidence, "/screenFail/cap/n", "reported:2", "reported"));
    expect(refusal(d, "reported:2", { value: 9 })).toMatchObject({ status: 409 });
    expect(d.rulebook.screenFail!.cap).toEqual({ kind: "none", n: null, ratio: null });
  });
});
