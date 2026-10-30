import { describe, expect, it } from "vitest";
import {
  type AnswerDraft,
  answerQuestion,
  askAbout,
  BLANK_INVOICEABLE,
  type BlankCheck,
  blankQuestions,
  blindEvidence,
  blindReview,
  type ContractAnomaly,
  followUps,
  isoDate,
  mask,
  type Rulebook,
  searchVersion,
  settled,
  signOffRefusal,
  tableQuestions,
  tableSendBackRefusal,
  type ValueEvidence,
  versionDiff,
  withheldPaths,
} from "../src";

// A table prints no price at the visits the read marks "invoiceable": one blind question per table (the blank check)
// instead of one per cell. Only a pick settles it; the read's own choice is "every scheduled visit".

const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const s = <T>(value: T) => ({ value, prov });
const visit = (code: string, name: string, order: number) => ({ code, name, order, procedureSubtotalCents: 1000, overheadCents: 0, nonProcedureCents: null, totalCents: 1000, autopay: true, prov });
const INV = "invoiceable" as const;

function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme"), payingAgent: s(null), protocol: s("P-1"), siteName: s("Site A"), investigator: s("Dr. A"), effectiveDate: s("2025-08-21"), currency: "USD" },
    documents: [{ id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" }],
    referencedDocuments: [],
    overhead: { pct: s(25), appliesTo: s("procedures_only") },
    payment: { visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s([]), paymentConditions: s([]) },
    budgetGrids: [
      {
        id: "g1", label: "Exhibit A", arm: null, statedOverheadPct: null, header: { investigator: null, siteName: null }, prov, perPatientTotals: [],
        visits: [visit("V1", "Screening", 1), visit("V2", "Week 4", 2), visit("V3", "Unscheduled", 3)],
        procedures: [
          { code: null, name: "Exam", unitCents: 400, overheadApplied: false, category: "procedure", cells: { V1: INV, V2: INV, V3: 400 }, prov },
          { code: null, name: "Labs", unitCents: 100, overheadApplied: false, category: "procedure", cells: { V1: INV, V3: 100 }, prov },
        ],
      },
    ],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [],
    screenFail: null,
    siteFees: [],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("cents"),
    appliesFrom: s(null),
    unclassified: [],
  };
}

const at = (x: number, y: number) => ({ documentId: "d1", page: 3, box: [x, y, 0.8, 0.05] as [number, number, number, number] });
const check: BlankCheck = {
  id: "blank:0:d1#3:0", grid: 0, page: 3, table: { documentId: "d1", page: 3, box: [0.1, 0.1, 0.8, 0.5] }, rows: [0, 1],
  cells: ["/budgetGrids/0/procedures/0/cells/V1", "/budgetGrids/0/procedures/0/cells/V2", "/budgetGrids/0/procedures/1/cells/V1"],
};
const row = (pi: number) => at(0.1, 0.2 + pi * 0.1);
const cell = (path: string, extra: Partial<ValueEvidence> = {}): ValueEvidence => ({ path, status: "ungrounded", where: [row(Number(/procedures\/(\d)/.exec(path)![1]))], printed: null, note: null, ...extra });
// the priced cells the table prints are confirmed; the blank ones are marked
const evidence = (): ValueEvidence[] => [
  ...check.cells.map((p) => cell(p, { blank: check.id })),
  cell("/budgetGrids/0/procedures/0/cells/V3", { status: "confirmed", printed: "4.00" }),
  cell("/budgetGrids/0/procedures/1/cells/V3", { status: "confirmed", printed: "1.00" }),
];

function fresh(): AnswerDraft {
  const ev = evidence();
  return { version: 1, byHand: false, rulebook: rulebook(), review: blankQuestions(ev, [check]), evidence: ev, editors: [] };
}
const ask = (d: AnswerDraft) => (p: string, id: string, reason: string) => askAbout(d.rulebook, d.evidence, p, id, reason);
const noFindings = () => [] as ContractAnomaly[];
/** What the API and the sample server do for one answer. */
function answerIt(d: AnswerDraft, body: object, checks: (rb: Rulebook) => ContractAnomaly[] = noFindings, itemId = check.id) {
  const r = answerQuestion(d, itemId, { by: "Asha", ...body }, { isoDate, now: "2026-01-01T00:00:00Z" });
  if ("refusal" in r || r.unchanged) return r;
  return { ...r, followLog: followUps({ ...d, anomalies: [] }, r, checks, ask(d)) };
}
const group = (d: AnswerDraft) => d.review.find((i) => i.reason === BLANK_INVOICEABLE)!;
const cellsOf = (d: AnswerDraft) => check.cells.map((p) => at_(d.rulebook, p));
const at_ = (rb: Rulebook, path: string) => path.split("/").slice(1).reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], rb);

describe("the blank check's question", () => {
  it("is one blocking blind pick per table, naming the page, none preselected, with the table's box and its rows' boxes", () => {
    const d = fresh();
    expect(d.review).toHaveLength(1);
    expect(group(d)).toMatchObject({
      id: check.id, kind: "confirm_value", path: null, blocking: true, input: null, answer: null, outcome: null,
      question: "On page 3, the highlighted items print no price at the scheduled visits. How are they billed?",
      options: [{ id: "printed_only", label: "Only where the contract prints a price" }, { id: "every_visit", label: "At every scheduled visit shown" }],
    });
    // the table, then each row once (three cells, two rows)
    expect(group(d).where).toEqual([check.table, row(0), row(1)]);
  });

  it("is none for a check with no cells", () => {
    expect(blankQuestions([], [])).toEqual([]);
  });
});

describe("blind entry", () => {
  it("withholds the group's cells while it's open, and only those", () => {
    const d = fresh();
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook }).sort()).toEqual([...check.cells].sort());
    expect(withheldPaths({ status: "signed", review: d.review, evidence: d.evidence, rulebook: d.rulebook })).toEqual([]);
  });

  it("shows no read choice and no group value: the master is null there, the evidence has no printed text, and nothing names the read's pick", () => {
    const d = fresh();
    const hidden = withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook });
    const masked = mask(d.rulebook, hidden, { evidence: d.evidence, review: d.review });
    for (const p of check.cells) expect(at_(masked, p), p).toBeNull();
    // the priced cells the table prints are left alone
    expect(at_(masked, "/budgetGrids/0/procedures/0/cells/V3")).toBe(400);
    expect(JSON.stringify(masked)).not.toContain(`"${INV}"`);
    const shown = JSON.stringify({ review: blindReview(d.review, hidden, d.evidence), evidence: blindEvidence(d.evidence, hidden) });
    // the question says nothing about what was read: no "expect", no read value, no "invoiceable"
    for (const word of ["expect", "read", INV]) expect(shown, word).not.toContain(`"${word}"`);
    expect(shown).not.toContain(`"${INV}"`);
  });

  it("holds the cells back from search and diff too", () => {
    const d = fresh();
    const v = { status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook };
    const hits = searchVersion(v as never, "Exam");
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).not.toContain(`"${INV}"`);
    const moved = structuredClone(d.rulebook);
    moved.budgetGrids[0]!.procedures[0]!.cells.V1 = 500;
    expect(versionDiff({ ...v, rulebook: d.rulebook }, { ...v, rulebook: moved } as never)).toEqual([]);
  });
});

describe("answering a blank check", () => {
  it("“Only where the contract prints a price” differs from the read: every cell of the group is removed from the grid, its evidence dropped, the person is an editor, and it's logged", () => {
    const d = fresh();
    const r = answerIt(d, { optionId: "printed_only" }) as { outcome: string; log: { action: string; detail: Record<string, unknown> }; followLog: unknown[] };
    expect(r.outcome).toBe("chosen");
    expect(cellsOf(d)).toEqual([undefined, undefined, undefined]);
    // the priced cells and every other cell of the rows stay
    expect(d.rulebook.budgetGrids[0]!.procedures.map((p) => p.cells)).toEqual([{ V3: 400 }, { V3: 100 }]);
    expect(d.evidence.map((e) => e.path)).toEqual(["/budgetGrids/0/procedures/0/cells/V3", "/budgetGrids/0/procedures/1/cells/V3"]);
    expect(d.evidence.some((e) => e.blank)).toBe(false);
    expect(d.editors).toEqual(["Asha"]);
    expect(r.log).toMatchObject({ by: "Asha", action: "review.blank_removed", detail: { cells: 3, outcome: "chosen" } });
    expect(group(d)).toMatchObject({ outcome: "chosen", answer: { optionId: "printed_only", by: "Asha" } });
    // nothing is withheld any more
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook })).toEqual([]);
  });

  it("“At every scheduled visit shown” matches the read: the cells stay, attested by the person, and nothing is withheld", () => {
    const d = fresh();
    const before = JSON.stringify(d.rulebook);
    const r = answerIt(d, { optionId: "every_visit" }, noFindings) as { outcome: string; log: { action: string } };
    expect(r.outcome).toBe("matched");
    expect(JSON.stringify(d.rulebook)).toBe(before);
    for (const p of check.cells) expect(d.evidence.find((e) => e.path === p)).toMatchObject({ status: "attested", note: "Typed by Asha" });
    expect(d.evidence.some((e) => e.blank)).toBe(false);
    expect(r.log.action).toBe("review.answered");
    expect(d.editors).toEqual(["Asha"]);
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook })).toEqual([]);
  });

  it("“can't tell” makes each cell an ordinary blind question to type, closes the group's own, and leaves the master as it was", () => {
    const d = fresh();
    const before = JSON.stringify(d.rulebook);
    const r = answerIt(d, { cantTell: true }) as { outcome: string; followLog: { action: string; detail: Record<string, unknown> }[] };
    expect(r.outcome).toBe("cant_tell");
    expect(r.followLog).toEqual([{ action: "review.blank_rejected", detail: { version: 1, "prices to type": 3 } }]);
    expect(JSON.stringify(d.rulebook)).toBe(before);
    expect(d.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(d.review.map((i) => i.path)).toEqual(check.cells);
    expect(d.review.every((i) => i.reason === "BLANK_REJECTED" && i.blocking && i.input === "money" && i.outcome === null && i.answer === null)).toBe(true);
    // still not confirmed, so the sign-off waits for them; no longer marked as a group
    for (const p of check.cells) expect(d.evidence.find((e) => e.path === p)).toMatchObject({ status: "ungrounded" });
    expect(d.evidence.some((e) => e.blank)).toBe(false);
    // each is withheld as an open question's value is
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook }).sort()).toEqual([...check.cells].sort());
    // can't tell doesn't make the person an editor
    expect(d.editors).toEqual([]);
  });

  it("a settled pick is final: not changed, not sent back, by anyone; the same answer again changes nothing", () => {
    const d = fresh();
    answerIt(d, { optionId: "every_visit" });
    expect(answerIt(d, { optionId: "every_visit" })).toMatchObject({ unchanged: true });
    expect(answerIt(d, { optionId: "printed_only", by: "Ben" })).toMatchObject({ refusal: { status: 409 } });
    expect(answerIt(d, { optionId: "printed_only" })).toMatchObject({ refusal: { status: 409 } });
    expect(cellsOf(d)).toEqual([INV, INV, INV]);
    const d2 = fresh();
    answerIt(d2, { optionId: "printed_only" });
    expect(answerIt(d2, { optionId: "every_visit", by: "Ben" })).toMatchObject({ refusal: { status: 409 } });
    expect(group(d2).outcome).toBe("chosen");
  });

  it("can't be sent back, as a table's pick can't", () => {
    const d = fresh();
    expect(tableSendBackRefusal(d.review)).toMatch(/can't be sent back/);
    expect(tableSendBackRefusal([])).toBeNull();
  });

  it("only a listed pick settles it: never nothing, free text, a typed value, a note or an option that isn't there", () => {
    const d = fresh();
    const snapshot = JSON.stringify([d.review, d.evidence, d.rulebook, d.editors]);
    for (const body of [{}, { value: "only where printed" }, { value: "every_visit" }, { optionId: "every_visit", value: "x" }, { optionId: "every_visit", note: "all of them" }, { note: "every_visit" }, { value: "" }])
      expect(answerIt(d, body), JSON.stringify(body)).toMatchObject({ refusal: { status: 400 } });
    expect(answerIt(d, { optionId: "V1" })).toMatchObject({ refusal: { status: 400 } });
    expect(answerIt(d, { optionId: "" })).toMatchObject({ refusal: { status: 400 } });
    expect(JSON.stringify([d.review, d.evidence, d.rulebook, d.editors])).toBe(snapshot);
  });

  it("asks a total again when the cells removed change a grid's checks (the existing recheck and arm-conflict rules run)", () => {
    const d = fresh();
    // the runtime's checks now find a total that doesn't add up in this grid
    const total = "/budgetGrids/0/visits/0/totalCents";
    const finding: ContractAnomaly = { id: `VISIT_TOTAL_MISMATCH:${total}`, code: "VISIT_TOTAL_MISMATCH", severity: "warning", message: "Screening: printed total $10.00 ≠ parts $9.00", path: total, refs: [], detail: {}, resolution: null };
    const r = answerIt(d, { optionId: "printed_only" }, () => [finding]);
    if ("refusal" in r || r.unchanged) throw new Error("unreachable");
    expect(d.review.map((i) => i.id)).toContain(`anomaly:${finding.id}`);
    // the removal itself was reported as a write to the master, so the follow-ups ran
    expect(r.set).toMatchObject({ before: INV, after: null });
  });
});

describe("the gate", () => {
  const signed = (d: AnswerDraft) => signOffRefusal({ version: 1, status: "draft", rulebook: d.rulebook, updatedAt: "t", byHand: false, review: d.review, evidence: d.evidence, editors: d.editors }, { asOf: "t", by: "Ben", makerChecker: true });

  it("refuses sign-off while the group is open, and not after a pick settles it", () => {
    const d = fresh();
    expect(signed(d)).toMatch(/1 question still needs an answer/);
    answerIt(d, { optionId: "printed_only" });
    expect(signed(d)).toBeNull();
    const e = fresh();
    answerIt(e, { optionId: "every_visit" });
    expect(signed(e)).toBeNull();
  });

  it("refuses sign-off after “can't tell” until each cell is answered", () => {
    const d = fresh();
    answerIt(d, { cantTell: true });
    expect(signed(d)).toMatch(/3 questions still need an answer/);
  });

  it("refuses it for the person who answered (they're an editor)", () => {
    const d = fresh();
    answerIt(d, { optionId: "printed_only" });
    expect(signOffRefusal({ version: 1, status: "draft", rulebook: d.rulebook, updatedAt: "t", byHand: false, review: d.review, evidence: d.evidence, editors: d.editors }, { asOf: "t", by: "asha", makerChecker: true })).toMatch(/Maker-checker/);
  });
});

describe("a blank check on a table whose columns are held", () => {
  const colBox = (x: number) => ({ documentId: "d1", page: 3, box: [x, 0.1, 0.1, 0.5] as [number, number, number, number] });
  const columns = { id: "t1", grid: 0, page: 3, columns: [{ box: colBox(0.2), visit: "V1" }, { box: colBox(0.4), visit: "V2" }, { box: colBox(0.6), visit: "V3" }] };
  const HELD = ["/budgetGrids/0/procedures/0/cells/V3", "/budgetGrids/0/procedures/1/cells/V3"];
  function waiting(): AnswerDraft {
    const ev = [...evidence().filter((e) => !HELD.includes(e.path)), ...HELD.map((p) => cell(p, { held: "t1" }))];
    return { version: 1, byHand: false, rulebook: rulebook(), review: [...tableQuestions(rulebook(), ev, [columns], () => 0.999), ...blankQuestions(ev, [{ ...check, after: "t1" }])], evidence: ev, editors: [] };
  }
  const picks = (d: AnswerDraft) => d.review.filter((i) => i.table);
  const pickIt = (d: AnswerDraft, id: string, optionId: string) => {
    const r = answerQuestion(d, id, { optionId, by: "Asha" }, { isoDate, now: "t" });
    if ("refusal" in r || r.unchanged) return r;
    return { ...r, followLog: followUps({ ...d, anomalies: [] }, r, noFindings, ask(d)) };
  };

  it("is refused with what to do first while the table's columns are open, and nothing changes", () => {
    const d = waiting();
    expect(group(d).after).toBe("t1");
    const snapshot = JSON.stringify([d.review, d.evidence, d.rulebook, d.editors]);
    for (const body of [{ optionId: "printed_only" }, { optionId: "every_visit" }, { cantTell: true }])
      expect(answerIt(d, body), JSON.stringify(body)).toMatchObject({ refusal: { status: 409, message: expect.stringMatching(/^Confirm the table's columns first/) } });
    expect(JSON.stringify([d.review, d.evidence, d.rulebook, d.editors])).toBe(snapshot);
    // still withheld
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook })).toEqual(expect.arrayContaining(check.cells));
  });

  it("becomes answerable once every column pick is right, and not before", () => {
    const d = waiting();
    const [a, b] = picks(d);
    pickIt(d, a!.id, a!.table!.expect);
    expect(group(d).after).toBe("t1");
    expect(answerIt(d, { optionId: "printed_only" })).toMatchObject({ refusal: { status: 409 } });
    pickIt(d, b!.id, b!.table!.expect);
    expect(group(d).after).toBeUndefined();
    expect(answerIt(d, { optionId: "printed_only" })).toMatchObject({ outcome: "chosen" });
    expect(cellsOf(d)).toEqual([undefined, undefined, undefined]);
    // the table's own held prices were confirmed by the picks
    expect(d.evidence.filter((e) => HELD.includes(e.path)).every((e) => e.status === "confirmed")).toBe(true);
  });

  it.each(["a wrong pick", "can't tell"])("is rejected with the table (%s): its cells become blind questions to type, as the held prices do", (how) => {
    const d = waiting();
    const [a] = picks(d);
    let log: { action: string; detail: Record<string, unknown> }[];
    if (how === "a wrong pick") log = (pickIt(d, a!.id, ["V1", "V2", "V3"].find((v) => v !== a!.table!.expect)!) as { followLog: typeof log }).followLog;
    else {
      const c = answerQuestion(d, a!.id, { cantTell: true, by: "Asha" }, { isoDate, now: "t" });
      if ("refusal" in c || c.unchanged) throw new Error("unreachable");
      log = followUps({ ...d, anomalies: [] }, c, noFindings, ask(d));
    }
    expect(log[0]).toMatchObject({ action: "review.table_rejected", detail: { "prices to type": HELD.length + check.cells.length } });
    expect(d.review.some((i) => i.reason === BLANK_INVOICEABLE || (i.table && !settled(i)))).toBe(false);
    expect(d.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path)).toEqual(check.cells);
    expect(d.review.filter((i) => i.reason === "TABLE_REJECTED").map((i) => i.path)).toEqual(HELD);
    expect(d.evidence.some((e) => e.blank || e.held)).toBe(false);
    for (const p of check.cells) expect(d.evidence.find((e) => e.path === p)).toMatchObject({ status: "ungrounded" });
    // the master is untouched and every one of them is withheld by its own question
    expect(cellsOf(d)).toEqual([INV, INV, INV]);
    expect(withheldPaths({ status: "draft", review: d.review, evidence: d.evidence, rulebook: d.rulebook }).sort()).toEqual([...check.cells, ...HELD].sort());
  });

  it("is untouched on a table whose columns were agreed (no check): answerable at once", () => {
    const d = fresh();
    expect(group(d).after).toBeUndefined();
    expect(answerIt(d, { optionId: "every_visit" })).toMatchObject({ outcome: "matched" });
  });
});
