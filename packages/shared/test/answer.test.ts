import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  at,
  type AnswerDraft,
  askAbout,
  type ContractAnomaly,
  diffRulebooks,
  followUps,
  fromAnomalies,
  notices,
  isoDate,
  proofreadMarks,
  type ReviewItem,
  type Rulebook,
  PAGE_OPTIONS,
  signOffRefusal,
  suggest,
  upgradeReview,
  type ValueEvidence,
} from "../src";

// The review rules the API runs (answer.ts, problems.ts, questions.ts, diff.ts), and the web where it shows them.

const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const s = <T>(value: T) => ({ value, prov });
const GRID = "/budgetGrids/0";

function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme"), payingAgent: s(null), protocol: s("P-1"), siteName: s("Site A"), investigator: s("Dr. A"), effectiveDate: s("2025-08-21"), currency: "USD" },
    documents: [{ id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" }],
    referencedDocuments: [],
    overhead: { pct: s(25), appliesTo: s("procedures_only") },
    payment: { visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s(["protocol number"]), paymentConditions: s([]) },
    budgetGrids: [
      {
        id: "g1", label: "Exhibit A", arm: null, statedOverheadPct: null, header: { investigator: null, siteName: null }, prov, perPatientTotals: [],
        visits: [{ code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 10000, overheadCents: 4000, nonProcedureCents: null, totalCents: 15000, autopay: true, prov }],
        procedures: [{ code: null, name: "Exam", unitCents: 10000, overheadApplied: true, category: "procedure", cells: { V1: 10000 }, prov }],
      },
    ],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [],
    screenFail: null,
    siteFees: [{ code: null, name: "Start-up", amountCents: 500000, trigger: "agreement_execution", dueDays: 30, prov }],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("cents"),
    appliesFrom: s(null),
    unclassified: [],
  };
}
const ev = (path: string, status: ValueEvidence["status"], printed: string | null = null): ValueEvidence => ({ path, status, where: [], printed, note: null });

/**
 * A draft whose only question is `item`, the PDF's text printing `printed` at its value's spot (a conflict), or nothing
 * there at all (null: a scan, a value the check didn't find).
 */
function draft(item: (rb: Rulebook) => ReviewItem, printed: string | null = null, extra: Partial<AnswerDraft> = {}): AnswerDraft {
  const rb = rulebook();
  const i = item(rb);
  return { version: 1, byHand: false, rulebook: rb, review: [i], evidence: i.path ? [ev(i.path, printed === null ? "ungrounded" : "conflict", printed)] : [], editors: [], ...extra };
}
const reported = (path: string, reason = "reported") => (rb: Rulebook) => askAbout(rb, [], path, "q", reason);
const answer = (d: AnswerDraft, body: Record<string, unknown>) => answerQuestion(d, "q", { by: "Sam", ...body }, { isoDate, now: "2026-10-29T09:00:00.000Z" });
/** Answers in turn; what the last one did. */
const answers = (d: AnswerDraft, ...bodies: Record<string, unknown>[]) => bodies.map((b) => answer(d, b)).at(-1)!;
const outcomeOf = (r: ReturnType<typeof answer>) => ("refusal" in r ? r.refusal : r.unchanged ? "unchanged" : r.outcome);

describe("answerQuestion", () => {
  const NET = "/payment/netDays/value";
  const cases: [string, () => AnswerDraft, Record<string, unknown>[], unknown][] = [
    ["a typed value the PDF's text prints matches, whatever the read says", () => draft(reported(`${GRID}/procedures/0/cells/V1`), "$98.00."), [{ value: 9800 }], "matched"],
    ["one it doesn't differs", () => draft(reported(NET), "45"), [{ value: 30 }], "differs"],
    ["kept over the PDF's text, it needs a note why", () => draft(reported(NET), "45"), [{ value: 30 }, { value: 30 }], { status: 400, message: "Add a short note saying why the PDF text is wrong here." }],
    ["…and settles with one", () => draft(reported(NET), "45"), [{ value: 30 }, { value: 30, note: "§4.2 says 30" }], "chosen"],
    ["the PDF's value after a differs settles without one", () => draft(reported(NET), "45"), [{ value: 30 }, { value: 45 }], "chosen"],
    ["a date printed in words is read as the binder reads it", () => draft(reported("/study/effectiveDate/value"), "August 22, 2025."), [{ value: "2025-08-22" }], "matched"],
    ["the same settling answer again changes nothing", () => draft(reported(NET), "45"), [{ value: 45 }, { value: 45 }], "unchanged"],
    ["can't tell is left for the approver", () => draft(reported(NET), "45"), [{ cantTell: true }], "cant_tell"],
    ["a value that can't go in the field is refused", () => draft(reported(NET)), [{ value: "soon" }], { status: 400, message: "That value can't go in this field. Check what you typed." }],
    ["nothing typed is refused", () => draft(reported(NET)), [{}], { status: 400, message: "Type a value, or say you can't tell." }],
    ["nobody named is refused", () => draft(reported(NET)), [{ value: 45, by: "" }], { status: 400, message: "Say who is answering." }],
    ["a yes/no pick other than the value held differs", () => draft(reported(`${GRID}/visits/0/autopay`)), [{ optionId: "false" }], "differs"],
    ["…and the second pick needs a note saying where the page prints it", () => draft(reported(`${GRID}/visits/0/autopay`)), [{ optionId: "false" }, { optionId: "false" }], { status: 400, message: "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note." }],
    // after "differs", only the same answer again (or the PDF's) settles it: a third value is a new answer, checked again
    ["a different value after a differs is checked again, note or not", () => draft(reported(NET), "45"), [{ value: 30 }, { value: 31, note: "§4.2" }], "differs"],
    ["…and settles once it's typed again", () => draft(reported(NET), "45"), [{ value: 30 }, { value: 31, note: "§4.2" }, { value: 31, note: "§4.2" }], "chosen"],
    ["a different pick after a differs is checked again", () => draft(reported("/payment/visitPayment/value")), [{ optionId: "invoice" }, { optionId: "mixed", note: "page 4" }], "differs"],
    ["…the same pick again settles it", () => draft(reported("/payment/visitPayment/value")), [{ optionId: "invoice" }, { optionId: "invoice", note: "page 4" }], "chosen"],
  ];
  it.each(cases)("%s", (_, start, bodies, expected) => expect(outcomeOf(answers(start(), ...bodies))).toEqual(expected));

  it("an unknown question is a 404, and a refusal changes nothing", () => {
    const d = draft(reported(NET));
    const before = structuredClone(d);
    expect(answerQuestion(d, "nope", { value: 45, by: "Sam" }, { isoDate, now: "" })).toEqual({ refusal: { status: 404, message: "Question not found" } });
    expect(answer(d, { value: "soon" })).toHaveProperty("refusal");
    expect(d).toEqual(before);
  });

  it("writes what was settled, attests it, makes the answerer an editor and logs it like a correction", () => {
    const d = draft(reported(NET), "30");
    const r = answer(d, { value: 30, note: " page 4 " });
    expect([d.rulebook.payment.netDays.value, d.evidence[0]!.status, d.editors]).toEqual([30, "attested", ["Sam"]]);
    expect(r).toMatchObject({ outcome: "matched", log: { by: "Sam", action: "review.answered", detail: { version: 1, itemId: "q", outcome: "matched", note: "page 4", path: NET, before: 45, after: 30, items: [] } } });
    expect(answer(d, { value: 30 })).toMatchObject({ log: { action: "review.changed" } }); // a different note: answered again
  });

  it("lists a lost correction to bill by hand, and takes it off for any other answer", () => {
    const lost = (): ReviewItem => ({
      id: "q", kind: "unaccounted", reason: "CORRECTION_LOST", path: null, question: "Is it still in the contract?", input: null, blocking: true,
      options: [{ id: "removed", label: "No" }, { id: "bill_by_hand", label: "Yes", note: "What is billed by hand?" }],
      where: [{ documentId: "d1", page: 7, box: null }], answer: null, outcome: null, compare: null, sentBack: null,
    });
    const d = draft(lost);
    expect(answer(d, { optionId: "bill_by_hand" })).toEqual({ refusal: { status: 400, message: "Add a short note for this answer: what is billed by hand?" } });
    expect(answer(d, { optionId: "bill_by_hand", note: "Start-up, $5,000" })).toMatchObject({ listed: { added: "Page 7 of “Work order”" }, log: { detail: { billByHand: "Page 7 of “Work order”" } } });
    expect(d.rulebook.unclassified).toMatchObject([{ page: 7, note: "Start-up, $5,000", itemId: "q" }]);
    expect(answer(d, { optionId: "removed" })).toMatchObject({ listed: { removed: "Page 7 of “Work order”" } });
    expect(d.rulebook.unclassified).toEqual([]);
  });

});

describe("followUps", () => {
  it("asks a total that doesn't add up once its grid's last typed number is answered, with the runtime's own checks", () => {
    const total = `${GRID}/visits/0/totalCents`;
    const finding: ContractAnomaly = { id: `VISIT_TOTAL_MISMATCH:${total}`, code: "VISIT_TOTAL_MISMATCH", severity: "warning", message: "Screening: printed total $150.00 ≠ parts $140.00", path: total, refs: [], detail: {}, resolution: null };
    const d = { ...draft(reported(total), null), anomalies: [] as ContractAnomaly[] };
    const r = answer(d, { value: 15000 });
    if ("refusal" in r || r.unchanged) throw new Error("not answered");
    followUps(d, r, () => [finding], (p, id, reason) => askAbout(d.rulebook, d.evidence, p, id, reason));
    expect(d.review.map((i) => [i.id, i.options.map((o) => o.id)])).toEqual([["q", []], [`anomaly:${finding.id}`, ["printed", "sum"]]]);
  });
});

describe("signOffRefusal", () => {
  const settledItem = { ...askAbout(rulebook(), [], "/payment/netDays/value", "q", "reported"), outcome: "matched" as const };
  const ready = { version: 2, status: "draft", rulebook: rulebook(), updatedAt: "t1", byHand: false, typingDoneAt: null, review: [settledItem], evidence: [ev("/x", "confirmed")], proofread: [], editors: ["Asha"] };
  const as = { asOf: "t1", by: "Ben", makerChecker: true };
  it.each([
    ["approves a draft as seen, every question settled, every number backed, by someone else", ready, as, null],
    ["not an approved version", { ...ready, status: "signed" }, as, "Version 2 is signed and immutable; changes need a new version (amendment)"],
    ["not one changed since it was opened", ready, { ...as, asOf: "t0" }, "This contract changed since you opened it. Check it again."],
    ["not typing still being done", { ...ready, byHand: true, review: [] }, as, "Typing isn't marked done yet. Mark it done when every value is typed."],
    ["typing marked done with nothing left to ask", { ...ready, byHand: true, typingDoneAt: "t0", review: [] }, as, null],
    ["not with a question left can't tell", { ...ready, review: [{ ...settledItem, outcome: "cant_tell" as const }] }, as, "1 question still needs an answer before this can be approved."],
    ["not with a number nobody backs", { ...ready, evidence: [ev("/x", "ungrounded"), ev("/y", "conflict")] }, as, "2 numbers aren't confirmed by the PDF, the contract's own totals or a person yet."],
    ["a number the contract's own totals confirm counts as backed", { ...ready, evidence: [ev("/x", "confirmed_by_math"), ev("/y", "attested")] }, as, null],
    ["not by whoever answered, however the name is typed", ready, { ...as, by: "asha" }, "Maker-checker is on: asha answered questions on this contract, so someone else has to approve it."],
    ["by them when maker-checker is off", ready, { ...as, by: "Asha", makerChecker: false }, null],
  ])("%s", (_, v, opts, expected) => expect(signOffRefusal(v, opts)).toBe(expected));
});


describe("diffRulebooks", () => {
  it("matches array items by identity and escapes keys in the path", () => {
    const before = rulebook();
    const after = rulebook();
    after.siteFees.unshift({ ...after.siteFees[0]!, name: "Archiving", amountCents: 1000 });
    after.budgetGrids[0]!.procedures[0]!.cells["W/4"] = 2000;
    expect(diffRulebooks(before, after).map((e) => [e.change, e.path, e.label])).toEqual([
      ["added", `${GRID}/procedures/0/cells/W~14`, "Budget grid › Exhibit A › Procedures › Exam › W/4"],
      ["added", "/siteFees/0", "Site fee › Archiving"],
    ]);
  });
});

describe("isoDate and proofreadMarks", () => {
  it("reads a date only when it's one date, one way", () => {
    expect(["2025-08-22", "Aug. 22nd, 2025", "22 August 2025", "8/22/2025", "8/9/2025", "the 22nd day of August, 2025", "soon"].map(isoDate)).toEqual(["2025-08-22", "2025-08-22", "2025-08-22", "2025-08-22", null, "2025-08-22", null]);
  });
  it("a value proofread again by the same person changes nothing", () => {
    const marks = proofreadMarks([], ["/a"], "Sam", "t1")!;
    expect([proofreadMarks(marks, ["/a"], "Sam", "t2"), proofreadMarks(marks, ["/a"], "Ben", "t2")]).toEqual([null, [{ path: "/a", by: "Ben", at: "t2" }]]);
  });
});

describe("suggest (ADR-003): what we suggest is shown, and taking it settles the question", () => {
  const NET = "/payment/netDays/value"; // the read holds 45
  const take = (d: AnswerDraft) => {
    const g = suggest(d.review[0]!, d)!;
    return outcomeOf(answer(d, g.optionId !== undefined ? { optionId: g.optionId } : { value: g.value }));
  };

  it("the PDF's printed text where it differs from our reading, and taking it matches", () => {
    const d = draft(reported(NET), "30");
    expect(suggest(d.review[0]!, d)).toEqual({ value: 30, why: "What the PDF's text prints at this spot. Our reading was different." });
    expect(take(d)).toBe("matched");
  });

  it("our reading where the PDF's text agrees or prints nothing, and taking it matches", () => {
    expect(suggest(draft(reported(NET), "45").review[0]!, draft(reported(NET), "45"))).toMatchObject({ value: 45, why: "What we read, and what the PDF's text prints here." });
    const scan = draft(reported(NET));
    expect(suggest(scan.review[0]!, scan)).toMatchObject({ value: 45, why: expect.stringMatching(/^What we read on the page\. The PDF has no text here/) });
    expect(take(scan)).toBe("matched");
  });

  it("the read's own pick on an interpretation or a yes/no", () => {
    const d = draft((rb) => ({ ...askAbout(rb, [], "/payment/visitPayment/value", "q", "reported"), kind: "interpretation" as const }));
    expect(suggest(d.review[0]!, d)).toEqual({ optionId: "auto_edc", why: "How we read the clause." });
    expect(take(d)).toBe("matched");
    const yes = draft(reported(`${GRID}/visits/0/autopay`));
    expect(suggest(yes.review[0]!, yes)).toMatchObject({ optionId: String(at(yes.rulebook, `${GRID}/visits/0/autopay`)), why: "What we read." });
  });

  it("nothing to take where the PDF's text contradicts our reading with no one figure, and our reading never matches there", () => {
    // the binder's conflict when the page prints several figures, none of them ours: no printed value, or one that won't parse
    for (const printed of [null, "$3,000.00 $4,500.00"]) {
      const FEE = "/siteFees/0/amountCents"; // the read holds $5,000.00
      const d = draft(reported(FEE));
      d.evidence = [ev(FEE, "conflict", printed)];
      expect(suggest(d.review[0]!, d)).toBeNull();
      expect(outcomeOf(answer(d, { value: 500000 }))).toBe("differs");
      expect(answer(d, { value: 500000 })).toEqual({ refusal: { status: 400, message: "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note." } });
      const r = answer(d, { value: 500000, note: "Clause 4, first figure" });
      expect([outcomeOf(r), d.review[0]!.answer?.noPdfText, d.evidence[0]!.status]).toEqual(["chosen", true, "attested"]);
    }
  });

  it("nothing for a missing value, or a question already settled", () => {
    const missing = draft((rb) => askAbout(rb, [], NET, "q", "REQUIRED_MISSING"));
    expect(suggest(missing.review[0]!, missing)).toBeNull();
    const d = draft(reported(NET), "45");
    answer(d, { value: 45 });
    expect(suggest(d.review[0]!, d)).toBeNull();
  });
});

describe("no question with one possible answer (ADR-003 C3)", () => {
  const anomaly = (code: ContractAnomaly["code"], path: string | null, message: string, severity: ContractAnomaly["severity"] = "blocker"): ContractAnomaly =>
    ({ id: `${code}:${path ?? ""}`, code, severity, message, path, refs: [{ documentId: "d1", page: 7 }], detail: {}, resolution: null });
  const found = [
    anomaly("HEADER_MISMATCH", `${GRID}/header/investigator`, 'Exhibit A: grid header names PI "Dr. B", contract PI is "Dr. A"'),
    // no path: nothing the master holds (one on "/siteFees" asks the fees' triggers: questions.test.ts)
    anomaly("AMBIGUOUS_TERM", null, "Ambiguous: site cost amounts may or may not include overhead", "warning"),
    anomaly("UNREADABLE_PAGE", null, "Page 7 of document d1 could not be read; enter its values manually if it has any"),
  ];

  it("a header that names someone else, and unclear wording nothing holds, are notices, never asked", () => {
    const rb = rulebook();
    const asked = fromAnomalies(found, rb, new Set());
    expect(asked.map((i) => i.reason)).toEqual(["UNREADABLE_PAGE"]);
    expect(notices(found, rb)).toEqual([
      { id: found[0]!.id, message: 'Exhibit A: grid header names PI "Dr. B", contract PI is "Dr. A".', where: [{ documentId: "d1", page: 7, box: null }] },
      { id: found[1]!.id, message: "Ambiguous: site cost amounts may or may not include overhead.", where: [{ documentId: "d1", page: 7, box: null }] },
    ]);
    // unclear wording a field holds is still that field's question
    expect(fromAnomalies([anomaly("AMBIGUOUS_TERM", "/payment/netDays/value", "Ambiguous: net days")], rb, new Set()).map((i) => i.reason)).toEqual(["AMBIGUOUS_TERM"]);
  });

  it("every question a check asks offers more than one answer", () => {
    const rb = rulebook();
    const codes: ContractAnomaly["code"][] = ["HEADER_MISMATCH", "AMBIGUOUS_TERM", "UNREADABLE_PAGE", "REQUIRED_MISSING", "DUPLICATE_ITEM", "MISSING_REFERENCED_DOC", "OVERHEAD_LABEL_MISMATCH"];
    for (const i of fromAnomalies(codes.map((c) => anomaly(c, null, `${c} found`)), rb, new Set())) expect(i.input !== null || i.options.length > 1, i.reason).toBe(true);
  });

  it("an unreadable page is asked like a scanned one: a billable term on it is listed to bill by hand", () => {
    const rb = rulebook();
    const [page] = fromAnomalies([found[2]!], rb, new Set());
    expect(page).toMatchObject({ kind: "unaccounted", question: "Page 7 couldn't be read, so it can't be searched for money terms. Does it have any that the invoicing master doesn't hold?" });
    const d: AnswerDraft = { version: 1, byHand: false, rulebook: rb, review: [{ ...page!, id: "q" }], evidence: [], editors: [] };
    expect(answer(d, { optionId: "bill_by_hand", note: "Courier, $95 per pickup" })).toMatchObject({ outcome: "chosen", listed: { added: "Page 7 of “Work order”" } });
  });
});

describe("upgradeReview: a draft saved before ADR-003 is asked by today's rules", () => {
  const CELL = `${GRID}/procedures/0/cells/V1`;
  const UNIT = `${GRID}/procedures/0/unitCents`;
  const NET = "/payment/netDays/value";
  const page7 = [{ documentId: "d1", page: 7, box: null }];
  const answered = { by: "Asha", at: "t" };
  // the shapes as they were stored: a sample miss, an open sample and re-type, a one-click "go ahead" page, a header question
  const old = () => {
    const rb = rulebook();
    const evidence = [ev(CELL, "attested"), ev(UNIT, "confirmed", "$100.00"), ev(NET, "confirmed", "45")];
    const review = [
      { ...askAbout(rb, evidence, CELL, `sample:${CELL}`, "SAMPLE"), outcome: "chosen" as const, answer: { value: 9800, note: "page 3", ...answered }, missed: true, retyped: true },
      askAbout(rb, evidence, NET, `sample:${NET}`, "SAMPLE"),
      askAbout(rb, evidence, NET, `spot:${NET}`, "spot_check"),
      { id: "anomaly:UNREADABLE_PAGE:", kind: "contract_problem" as const, reason: "UNREADABLE_PAGE", path: null, question: "Page 7 could not be read. Go ahead with the contract as printed?", input: null, options: [{ id: "as_printed", label: "Yes, go ahead as printed" }], where: page7, blocking: true, answer: { optionId: "as_printed", ...answered }, outcome: "chosen" as const, compare: null, sentBack: null },
      { id: "anomaly:HEADER_MISMATCH:x", kind: "contract_problem" as const, reason: "HEADER_MISMATCH", path: `${GRID}/header/investigator`, question: "The grid names Dr. B. Go ahead?", input: null, options: [{ id: "as_printed", label: "Yes" }], where: page7, blocking: true, answer: null, outcome: null, compare: null, sentBack: null },
    ] as ReviewItem[];
    return { version: 1, status: "draft", rulebook: rb, updatedAt: "t", byHand: false, review, evidence, proofread: [] as { path: string; by: string; at: string }[], editors: ["Asha"] };
  };
  const gate = (v: ReturnType<typeof old>) => signOffRefusal(v, { asOf: "t", by: "Ben", makerChecker: true });

  it("a sample miss asks each value of its kind still only checked by machine; a page is asked again; a notice isn't asked", () => {
    const v = old();
    expect(gate({ ...v, review: [v.review[0]!] })).toBeNull(); // before: a miss approved without the proofread the old rule required
    const review = upgradeReview(v);
    expect(review.map((i) => [i.id, i.reason, i.outcome])).toEqual([
      [`sample:${CELL}`, "SAMPLE", "chosen"],
      ["anomaly:UNREADABLE_PAGE:", "UNREADABLE_PAGE", null],
      [`miss:${UNIT}`, "SAMPLE_MISS", null],
    ]);
    expect(review[1]).toMatchObject({ kind: "unaccounted", options: PAGE_OPTIONS, answer: null, where: page7 });
    expect(review[2]).toMatchObject({ path: UNIT, blocking: true, answer: null });
    expect(gate({ ...v, review })).toBe("2 questions still need an answer before this can be approved.");
    // the same on every load, and nothing asked of a value already proofread
    expect(upgradeReview({ ...v, review })).toEqual(review);
    expect(upgradeReview({ ...v, proofread: [{ path: UNIT, by: "Ben", at: "t" }] }).map((i) => i.id)).not.toContain(`miss:${UNIT}`);
  });

  it("a sample whose first answer differed counts as a miss; a signed version is never changed", () => {
    const v = old();
    const evidence = [ev(CELL, "confirmed", "$100.00"), ...v.evidence.slice(1)];
    const differing = { ...askAbout(v.rulebook, evidence, CELL, `sample:${CELL}`, "SAMPLE"), outcome: "differs" as const, answer: { value: 9800, ...answered }, retyped: true } as ReviewItem;
    expect(upgradeReview({ ...v, evidence, review: [differing] }).map((i) => i.id)).toEqual([`sample:${CELL}`, `miss:${UNIT}`]);
    expect(upgradeReview({ ...v, status: "signed" })).toBe(v.review);
  });
});
