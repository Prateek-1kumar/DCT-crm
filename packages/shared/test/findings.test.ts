import { describe, expect, it } from "vitest";
import {
  type AnswerDraft,
  answerQuestion,
  armKey,
  askAbout,
  billedGrids,
  BODY_WORDS,
  bodyProblem,
  type BudgetGrid,
  capFollowUps,
  type ContractAnomaly,
  followUps,
  fromAnomalies,
  gridChoice,
  gridPrices,
  interpretations,
  isoDate,
  openItems,
  parseCents,
  parsePercent,
  placeholders,
  ReportValueBody,
  searchVersion,
  type ReviewItem,
  type Rulebook,
  RulebookVersionDto,
  settled,
  signOffRefusal,
  typingDone,
  type ValueEvidence,
  versionDiff,
  openPaths,
} from "../src";

// Regression cases for the review findings of 2026-10-29: each failed before its fix. Shared code, so they hold for the
// API and the web alike.

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

  it("marking typing done: the checks on what was typed, what nobody typed asked, and the questions counted; nothing re-typed", () => {
    const rb = blank();
    const d = { version: 1, status: "draft", byHand: true, rulebook: rb, review: [], evidence: [ev("/payment/netDays/value", "attested")] };
    const done = typingDone(d, { checks });
    if ("refusal" in done) throw new Error(done.refusal.message);
    expect(done.review.some((i) => i.path === "/payment/netDays/value")).toBe(false);
    expect(done.anomalies.map((a) => a.code)).toEqual(["VISIT_TOTAL_MISMATCH"]);
    expect(done.detail).toEqual({ version: 1, typed: 1, questions: done.review.length });
    expect(typingDone({ ...d, review: done.review, typingDoneAt: "t" }, { checks })).toEqual({ refusal: { status: 409, message: "Typing is already marked done." } });
  });

  it("a contract typed in full, with nothing left to ask, can still be approved: done is its own mark, never “has questions”", () => {
    const rb = blank();
    const typed = placeholders(rb, []).map((p) => ev(p, "attested"));
    const d = { version: 1, status: "draft", byHand: true, typingDoneAt: null, rulebook: rb, review: [], evidence: typed, updatedAt: "t", editors: ["Asha"] };
    const done = typingDone(d, { checks: () => [] });
    if ("refusal" in done) throw new Error(done.refusal.message);
    expect(done.review).toEqual([]);
    // the caller marks it done (the API's typing_done_at): approvable, and done only once
    const after = { ...d, review: done.review, typingDoneAt: "2026-11-01T00:00:00.000Z" };
    expect(signOffRefusal(after, { asOf: "t", by: "Ben", makerChecker: true })).toBeNull();
    expect(typingDone(after, { checks: () => [] })).toEqual({ refusal: { status: 409, message: "Typing is already marked done." } });
    expect(signOffRefusal(d, { asOf: "t", by: "Ben", makerChecker: true })).toBe("Typing isn't marked done yet. Mark it done when every value is typed.");
  });
});

describe("13. 'needs you' and the gate agree", () => {
  it("a can't tell on a question not needed to approve still needs you", () => {
    const q = { ...askAbout(rulebook(), [], "/payment/netDays/value", "q", "reported"), blocking: false, outcome: "cant_tell" as const };
    expect(openItems([q])).toEqual([q]);
  });
});

describe("15. lows", () => {
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

describe("16. the diff, one rule (versionDiff)", () => {
  it("refuses a version with no master, and shows a change in full (nothing is withheld, ADR-003)", () => {
    const v = { rulebook: rulebook() };
    expect(versionDiff({ rulebook: null }, v)).toEqual({ refusal: { status: 409, message: "Both versions need an extracted rulebook to diff" } });
    const after = { rulebook: { ...rulebook(), payment: { ...rulebook().payment, netDays: s(30) } } };
    expect(versionDiff(v, after)).toEqual([expect.objectContaining({ path: "/payment/netDays/value", change: "changed", after: 30 })]);
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

// ---- The third review of 2026-10-29: each `it` failed before its fix. ----

describe("F1. 'as printed' after a total is typed while its recheck waits", () => {
  const CELL = "/budgetGrids/0/procedures/0/cells/V1";
  // printed one dollar over its parts; a cell of its grid is asked, so the recheck waits for it
  const setUp = (keep = true) => {
    const rb = rulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 15100;
    const found = checks(rb).map((a) => ({ ...a, detail: { expected: 14000, actual: 15100 } }));
    const [q] = fromAnomalies(found, rb, new Set());
    const { asPrinted: _, ...old } = q!;
    const evidence = [ev(TOTAL, "confirmed", "151.00"), ev(CELL, "confirmed", "100.00")];
    const d = { ...draft([keep ? q! : old, askAbout(rb, evidence, CELL, `reported:${CELL}`, "reported")], evidence, rb), anomalies: found };
    return { d, id: q!.id };
  };

  it.each([["kept on the question", true], ["from the read's check, for a question asked before it was kept", false]])(
    "is what a person typed for the total last, whichever answer runs the recheck (printed value %s)",
    (_, keep) => {
      const { d, id } = setUp(keep);
      answerAndFollow(d, id, { optionId: "sum", note: "Ask the sponsor" });
      expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(14000);
      // "This looks wrong" on the total, typed while the question in its grid is still open
      d.review.push(askAbout(d.rulebook, d.evidence, TOTAL, "reported:1", "reported"));
      answerAndFollow(d, "reported:1", { value: 15200 });
      answerAndFollow(d, "reported:1", { value: 15200, note: "the signed page prints $152.00" });
      expect(d.review.find((i) => i.id === id)).toMatchObject({ asPrinted: 15200 });
      // the cell's answer runs the recheck: "the sum" doesn't hold any more, so it's asked again
      const { logged } = answerAndFollow(d, `reported:${CELL}`, { value: 10000 });
      expect(logged).toEqual([expect.objectContaining({ action: "review.reopened", detail: expect.objectContaining({ itemId: id }) })]);
      expect(d.review.find((i) => i.id === id)).toMatchObject({ outcome: null, asPrinted: 15200 });
      // "as printed" puts back what the person typed, never the old printed total over it
      answerAndFollow(d, id, { optionId: "printed", note: "The sponsor says the printed total governs" });
      expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15200);
    },
  );

  it("'the sum' never becomes what's printed", () => {
    const { d, id } = setUp();
    answerAndFollow(d, `reported:${CELL}`, { value: 10000 });
    answerAndFollow(d, id, { optionId: "sum", note: "Ask the sponsor" });
    expect(d.review.find((i) => i.id === id)).toMatchObject({ asPrinted: 15100 });
    answerAndFollow(d, id, { optionId: "printed", note: "Back to the printed total" });
    expect(d.rulebook.budgetGrids[0]!.visits[0]!.totalCents).toBe(15100);
  });
});
