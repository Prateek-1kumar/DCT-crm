import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  type AnswerDraft,
  askAbout,
  type ContractAnomaly,
  diffRulebooks,
  followUps,
  isoDate,
  pickRetype,
  proofreadMarks,
  type ReviewItem,
  type Rulebook,
  SAMPLE,
  signOffRefusal,
  type ValueEvidence,
} from "../src";

// The review rules the API and the in-browser sample server both run (answer.ts, problems.ts, questions.ts, diff.ts):
// what each server passes in is the same, so one table here stands for both.

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

/** A draft whose only question is `item`, the PDF's text printing `printed` at its value's spot. */
function draft(item: (rb: Rulebook) => ReviewItem, printed: string | null = null, extra: Partial<AnswerDraft> = {}): AnswerDraft {
  const rb = rulebook();
  const i = item(rb);
  return { version: 1, byHand: false, rulebook: rb, review: [i], evidence: i.path ? [ev(i.path, i.reason === SAMPLE ? "confirmed" : "conflict", printed)] : [], editors: [], ...extra };
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
    ["a hand-typed value isn't re-typed by its typist", () => draft(reported(NET, "spot_check"), null, { byHand: true, editors: ["Sam"] }), [{ value: 45, by: " sam " }], { status: 409, message: "sam changed a value on this contract, so someone else has to re-type the rest." }],
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
    expect(r).toMatchObject({ outcome: "matched", log: { by: "Sam", action: "review.answered", detail: { version: 1, itemId: "q", outcome: "matched", note: "page 4", path: NET, before: 45, after: 30, items: [] } }, incident: undefined });
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

  it("a random spot check kept different after looking again has missed: an incident, counted, and it stays missed", () => {
    const cell = `${GRID}/procedures/0/cells/V1`;
    const d = draft((rb) => askAbout(rb, [], cell, "q", SAMPLE), "100.00");
    d.evidence.push(ev(`${GRID}/procedures/0/unitCents`, "confirmed"));
    const r = answers(d, { value: 10100 }, { value: 10100, note: "The page prints $101" });
    expect(r).toMatchObject({ outcome: "chosen", missed: true, incident: { count: 1, detail: { itemId: "q", path: cell, values: "budget grid prices", "to check": 1 } } });
    expect(d.editors).toEqual(["Sam"]); // the re-typer changed a value: an editor
    expect(answer(d, { value: 10000, by: "Ben" })).toMatchObject({ missed: false, incident: undefined });
    expect(d.review[0]!.missed).toBe(true);
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
  const ready = { version: 2, status: "draft", rulebook: {}, updatedAt: "t1", byHand: false, review: [settledItem], evidence: [ev("/x", "confirmed")], proofread: [], editors: ["Asha"] };
  const as = { asOf: "t1", by: "Ben", makerChecker: true };
  it.each([
    ["approves a draft as seen, every question settled, every number backed, by someone else", ready, as, null],
    ["not an approved version", { ...ready, status: "signed" }, as, "Version 2 is signed and immutable; changes need a new version (amendment)"],
    ["not one changed since it was opened", ready, { ...as, asOf: "t0" }, "This contract changed since you opened it. Check it again."],
    ["not typing still being done", { ...ready, byHand: true, review: [] }, as, "Typing isn't marked done yet, so nobody has re-typed the values."],
    ["not with a question left can't tell", { ...ready, review: [{ ...settledItem, outcome: "cant_tell" as const }] }, as, "1 question still needs an answer before this can be approved."],
    ["not with a number nobody backs", { ...ready, evidence: [ev("/x", "ungrounded"), ev("/y", "conflict")] }, as, "2 numbers aren't confirmed by the PDF or a person yet."],
    ["not by whoever answered, however the name is typed", ready, { ...as, by: "asha" }, "Maker-checker is on: asha answered questions on this contract, so someone else has to approve it."],
    ["by them when maker-checker is off", ready, { ...as, by: "Asha", makerChecker: false }, null],
  ])("%s", (_, v, opts, expected) => expect(signOffRefusal(v, opts)).toBe(expected));
});

describe("pickRetype", () => {
  it("draws from every kind of typed value, at most 10, as the read's sample is drawn", () => {
    const rb = rulebook();
    const typed = ["/payment/netDays/value", `${GRID}/visits/0/autopay`, "/payment/requiredReferences/value", "/overhead/appliesTo/value", "/study/sponsor/value"];
    const evidence = [...typed.map((p) => ev(p, "attested")), ev("/payment/netDaysFrom/value", "attested"), ev(`${GRID}/visits/0/totalCents`, "confirmed")];
    const pinned = () => 1 - 2 ** -32; // no shuffling: in evidence order
    expect(pickRetype(rb, evidence, pinned)).toEqual({ typed, sample: typed }); // an empty value and a read's value aren't re-typed
    expect(pickRetype(rb, evidence, pinned, 2).sample).toEqual(typed.slice(0, 2));
    expect(new Set(pickRetype(rb, evidence).sample)).toEqual(new Set(typed));
  });
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
