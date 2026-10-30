import { describe, expect, it } from "vitest";
import {
  type AnswerDraft,
  answerQuestion,
  askAbout,
  at,
  blindEvidence,
  blindReview,
  followUps,
  isoDate,
  mask,
  type ReviewItem,
  type Rulebook,
  searchVersion,
  shownAppliesFrom,
  signOffRefusal,
  TABLE_CHECK,
  type TableCheck,
  tableQuestions,
  tableSendBackRefusal,
  type ValueEvidence,
  versionDiff,
  withheldPaths,
} from "../src";

// A scanned table whose headers don't match the read's visit names is held for one blind confirmation of its columns
// (the table check): two picks, "which visit is the highlighted column", and the table's prices wait for them.

const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const s = <T>(value: T) => ({ value, prov });
const visit = (code: string, name: string, order: number) => ({ code, name, order, procedureSubtotalCents: 1000, overheadCents: 0, nonProcedureCents: null, totalCents: 1000, autopay: true, prov });

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
        visits: [visit("V1", "Screening", 1), visit("V2", "Week 4", 2), visit("V3", "Week 8", 3)],
        procedures: [
          { code: null, name: "Exam", unitCents: 400, overheadApplied: false, category: "procedure", cells: { V1: 400, V2: 500, V3: 600 }, prov },
          { code: null, name: "Labs", unitCents: 100, overheadApplied: false, category: "procedure", cells: { V1: 100, V2: 200 }, prov },
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

const box = (x: number): TableCheck["columns"][number]["box"] => ({ documentId: "d1", page: 3, box: [x, 0.1, 0.1, 0.5] });
const check: TableCheck = { id: "t1", grid: 0, page: 3, columns: [{ box: box(0.2), visit: "V1" }, { box: box(0.4), visit: "V2" }, { box: box(0.6), visit: "V3" }] };
// V3 has a price too, but it isn't held (the scan's reading there already agreed)
const HELD = ["/budgetGrids/0/procedures/0/cells/V1", "/budgetGrids/0/procedures/0/cells/V2", "/budgetGrids/0/procedures/1/cells/V1", "/budgetGrids/0/procedures/1/cells/V2"];
const held = (): ValueEvidence[] => HELD.map((path) => ({ path, status: "ungrounded", where: [], printed: null, note: null, held: "t1" }));
const noShuffle = () => 0.999;

function fresh(): AnswerDraft {
  const rb = rulebook();
  const evidence = held();
  return { version: 1, byHand: false, rulebook: rb, review: tableQuestions(rb, evidence, [check], noShuffle), evidence, editors: [] };
}
const ask = (d: AnswerDraft) => (p: string, id: string, reason: string) => askAbout(d.rulebook, d.evidence, p, id, reason);
/** What the API and the sample server do for one answer. */
function answerIt(d: AnswerDraft, itemId: string, optionId: string, by = "Asha") {
  const r = answerQuestion(d, itemId, { optionId, by }, { isoDate, now: "2026-01-01T00:00:00Z" });
  if ("refusal" in r) return r;
  if (r.unchanged) return r;
  const log = followUps({ ...d, anomalies: [] }, r, () => [], ask(d));
  return { ...r, followLog: log };
}
const picks = (d: AnswerDraft) => d.review.filter((i) => i.reason === TABLE_CHECK);

describe("the table check's questions", () => {
  it("are two blind picks of different visits, among the grid's visits in order, none preselected, with the column's box", () => {
    const d = fresh();
    const qs = picks(d);
    expect(qs).toHaveLength(2);
    expect(new Set(qs.map((q) => q.table!.expect)).size).toBe(2);
    for (const q of qs) {
      expect(q).toMatchObject({ kind: "confirm_value", path: null, blocking: true, input: null, answer: null, outcome: null, question: "Which visit is the highlighted column of the table on page 3?" });
      expect(q.options).toEqual([{ id: "V1", label: "Screening" }, { id: "V2", label: "Week 4" }, { id: "V3", label: "Week 8" }]);
      expect(q.where).toEqual([check.columns.find((c) => c.visit === q.table!.expect)!.box]);
    }
  });

  it("prefer columns that have held prices", () => {
    // V3 has no held price: whatever the draw, it is never picked while two columns with held prices remain
    for (const r of [0, 0.3, 0.6, 0.999]) expect(tableQuestions(rulebook(), held(), [check], () => r).map((q) => q.table!.expect)).not.toContain("V3");
  });

  it("take what columns there are when a table has fewer than two different visits", () => {
    const one: TableCheck = { ...check, columns: [check.columns[0]!, { box: box(0.5), visit: "V1" }] };
    expect(tableQuestions(rulebook(), held(), [one], noShuffle)).toHaveLength(1);
    expect(tableQuestions(rulebook(), held(), [{ ...check, columns: [] }], noShuffle)).toEqual([]);
  });

  it("never send the visit the read gave the column: blindReview takes it out, whatever else is withheld", () => {
    const d = fresh();
    for (const hidden of [[], ["/budgetGrids/0/procedures/0/cells/V1"]]) {
      const shown = blindReview(d.review, hidden, d.evidence);
      for (const q of shown) expect(q, JSON.stringify(q)).not.toHaveProperty("table");
      expect(JSON.stringify(shown)).not.toContain("expect");
    }
    // the stored questions keep it: the answer is compared with it on the server
    expect(picks(d).every((q) => q.table)).toBe(true);
  });
});

describe("answering a table check", () => {
  it("every pick right: the held prices are confirmed, noted as checked by those who picked, and logged", () => {
    const d = fresh();
    const [a, b] = picks(d);
    expect(answerIt(d, a!.id, a!.table!.expect)).toMatchObject({ outcome: "matched" });
    expect(d.evidence.every((e) => e.held === "t1" && e.status === "ungrounded")).toBe(true); // one pick isn't enough
    const r = answerIt(d, b!.id, b!.table!.expect, "Ben") as { followLog: { action: string; detail: Record<string, unknown> }[] };
    expect(d.evidence.every((e) => e.status === "confirmed" && e.held === undefined && /^Checked by Asha, Ben: the table's columns were confirmed/.test(e.note!))).toBe(true);
    expect(r.followLog).toEqual([{ action: "review.table_confirmed", detail: { prices: 4, by: "Asha, Ben" } }]);
    expect(d.review.every((i) => i.outcome === "matched")).toBe(true);
  });

  it("a pick that differs rejects the columns: every held price becomes a blind question to type, the hold ends, and the other pick closes", () => {
    const d = fresh();
    const [a, b] = picks(d);
    const wrong = ["V1", "V2", "V3"].find((v) => v !== a!.table!.expect)!;
    const r = answerIt(d, a!.id, wrong) as { outcome: string; followLog: { action: string; detail: Record<string, unknown> }[] };
    expect(r.outcome).toBe("chosen"); // settled: it isn't asked again
    expect(r.followLog).toEqual([{ action: "review.table_rejected", detail: { "prices to type": 4, "picks closed": 1 } }]);
    expect(d.evidence.some((e) => e.held)).toBe(false);
    expect(d.evidence.every((e) => e.status === "ungrounded")).toBe(true);
    expect(d.review.find((i) => i.id === b!.id)).toBeUndefined();
    const typed = d.review.filter((i) => i.reason === "TABLE_REJECTED");
    expect(typed.map((i) => i.path)).toEqual(HELD);
    expect(typed.every((i) => i.blocking && i.input === "money" && i.outcome === null && i.answer === null)).toBe(true);
    // the rejecting answer is final, from anyone
    expect(answerIt(d, a!.id, a!.table!.expect, "Ben")).toMatchObject({ refusal: { status: 409 } });
    expect(answerIt(d, a!.id, wrong, "Ben")).toMatchObject({ refusal: { status: 409 } });
  });

  it("a confirmed table's picks can't be changed or sent back either", () => {
    const d = fresh();
    for (const q of picks(d)) answerIt(d, q.id, q.table!.expect);
    const [a] = picks(d);
    expect(answerIt(d, a!.id, "V3", "Ben")).toMatchObject({ refusal: { status: 409 } });
    expect(tableSendBackRefusal(picks(d))).toMatch(/can't be sent back/);
    expect(tableSendBackRefusal(d.review.filter((i) => !i.table))).toBeNull();
  });

  it("“can't tell” rejects the mapping like a wrong pick: the prices are asked blind, and nothing is left held or open", () => {
    const d = fresh();
    const [a] = picks(d);
    const r = answerIt(d, a!.id, "") as never;
    expect(r).toMatchObject({ refusal: { status: 400 } }); // not a pick
    const c = answerQuestion(d, a!.id, { cantTell: true, by: "Asha" }, { isoDate, now: "t" });
    expect(c).toMatchObject({ outcome: "cant_tell" });
    if ("refusal" in c || c.unchanged) throw new Error("unreachable");
    const log = followUps({ ...d, anomalies: [] }, c, () => [], ask(d));
    expect(log).toEqual([{ action: "review.table_rejected", detail: { "prices to type": 4, "picks closed": 2 } }]);
    expect(d.evidence.some((e) => e.held)).toBe(false);
    expect(picks(d)).toEqual([]);
    expect(d.review.filter((i) => i.reason === "TABLE_REJECTED").map((i) => i.path)).toEqual(HELD);
  });

  it("only a real pick settles it: never nothing, free text, a value, a note, an option that isn't listed, or a question with no expected visit", () => {
    const d = fresh();
    const [a] = picks(d);
    const snapshot = JSON.stringify([d.review, d.evidence, d.editors]);
    const answerWith = (body: object, id = a!.id) => answerQuestion(d, id, { by: "Asha", ...body }, { isoDate, now: "t" });
    for (const body of [{}, { value: "V2" }, { value: a!.table!.expect }, { optionId: a!.table!.expect, value: "x" }, { optionId: a!.table!.expect, note: "it's this one" }, { note: "V1" }])
      expect(answerWith(body), JSON.stringify(body)).toMatchObject({ refusal: { status: 400 } });
    expect(answerWith({ optionId: "V9" })).toMatchObject({ refusal: { status: 400 } });
    // a placeholder with no expected visit (what the binder asks) settles nothing
    const placeholder: ReviewItem = { ...a!, id: "t1", table: undefined, options: a!.options };
    d.review.push(placeholder);
    expect(answerWith({ optionId: "V1" }, "t1")).toMatchObject({ refusal: { status: 409 } });
    d.review.pop();
    expect(JSON.stringify([d.review, d.evidence, d.editors])).toBe(snapshot);
  });

  it("whoever picks is an editor, so maker-checker keeps them from approving", () => {
    const d = fresh();
    const [a] = picks(d);
    answerIt(d, a!.id, a!.table!.expect, "Asha");
    expect(d.editors).toEqual(["Asha"]);
  });
});

describe("blind entry while a table is held", () => {
  const nowDraft = (d: AnswerDraft) => ({ ...d, status: "draft" });

  it("every held price is withheld, masked in the master, and its evidence goes out without printed text at its page only", () => {
    const d = fresh();
    const ev = d.evidence.map((e) => ({ ...e, printed: "400.00", where: [{ documentId: "d1", page: 3, box: [0.2, 0.2, 0.1, 0.1] as [number, number, number, number] }] }));
    const hidden = withheldPaths({ ...nowDraft(d), evidence: ev });
    expect(hidden).toEqual(expect.arrayContaining(HELD));
    // the price outside the table isn't held, so it shows
    expect(hidden).not.toContain("/budgetGrids/0/procedures/0/cells/V3");
    const shown = mask(d.rulebook, hidden, { evidence: ev, review: d.review });
    for (const p of HELD) expect(at(shown, p)).toBeNull();
    expect(at(shown, "/budgetGrids/0/procedures/0/cells/V3")).toBe(600);
    for (const e of blindEvidence(ev, hidden).filter((x) => HELD.includes(x.path))) expect(e).toMatchObject({ printed: null, where: [{ box: null }] });
    // and nothing else shows them: not the sign-off diff, nor a search for a held amount
    const view = { ...nowDraft(d), evidence: ev, updatedAt: "x", appliesFrom: null };
    expect(shownAppliesFrom(view)).toBeNull();
    expect(searchVersion(view as never, "4.00").map((h) => h.path)).not.toContain("/budgetGrids/0/procedures/0");
    const diff = versionDiff({ ...nowDraft(d), evidence: ev }, { ...nowDraft(d), rulebook: { ...d.rulebook, budgetGrids: [{ ...d.rulebook.budgetGrids[0]!, procedures: [{ ...d.rulebook.budgetGrids[0]!.procedures[0]!, cells: { V1: 1, V2: 2, V3: 600 } }, d.rulebook.budgetGrids[0]!.procedures[1]!] }] }, evidence: ev });
    expect(Array.isArray(diff) ? diff.filter((e) => HELD.includes(e.path)) : null).toEqual([]);
  });

  it("a settled-right table shows its prices again; a rejected one keeps them blind, asked one by one", () => {
    const right = fresh();
    for (const q of picks(right)) answerIt(right, q.id, q.table!.expect);
    expect(withheldPaths({ ...nowDraft(right) })).toEqual([]);

    const d = fresh();
    const [a] = picks(d);
    answerIt(d, a!.id, ["V1", "V2", "V3"].find((v) => v !== a!.table!.expect)!);
    // the questions are open, so the same paths stay withheld, and their questions carry no value
    expect(withheldPaths(nowDraft(d))).toEqual(expect.arrayContaining(HELD));
    for (const q of d.review.filter((i) => i.reason === "TABLE_REJECTED")) {
      expect(q.question).toMatch(/^What amount is printed for /);
      expect(q.question).not.toMatch(/\d{3}/);
    }
  });

  it("the pick ids and their order say nothing about which visit a column is", () => {
    const first = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      let x = seed; // a small seeded generator: different draws, repeatable
      const qs = tableQuestions(rulebook(), held(), [check], () => (x = (x * 16807) % 2147483647) / 2147483647);
      expect(qs.map((q) => q.id)).toEqual(["table:t1:0", "table:t1:1"]);
      first.add(qs[0]!.table!.expect);
    }
    // under different draws the first pick is a different column
    expect(first.size).toBeGreaterThan(1);
  });
});

describe("sign-off with a table check", () => {
  const view = (d: AnswerDraft) => ({ ...d, status: "draft", updatedAt: "now", proofread: [] });
  const gate = (d: AnswerDraft) => signOffRefusal(view(d), { asOf: "now", by: "Ben", makerChecker: false });

  it("is refused while a table check is open, and while any price is still held", () => {
    const d = fresh();
    expect(gate(d)).toMatch(/2 questions still need an answer/);
    // even with every question settled, a held price isn't confirmed
    for (const q of d.review) Object.assign(q, { outcome: "matched" });
    expect(gate(d)).toMatch(/4 numbers aren't confirmed/);
  });

  it("is refused after a rejection until each price is typed, then allowed", () => {
    const d = fresh();
    const [a] = picks(d);
    answerIt(d, a!.id, ["V1", "V2", "V3"].find((v) => v !== a!.table!.expect)!);
    expect(gate(d)).toMatch(/4 questions still need an answer/);
    // typed as the page prints them
    for (const q of d.review.filter((i) => i.reason === "TABLE_REJECTED")) {
      const r = answerQuestion(d, q.id, { value: at(d.rulebook, q.path!), by: "Asha" }, { isoDate, now: "t" });
      expect(r).toMatchObject({ outcome: "matched" });
    }
    expect(gate(d)).toBeNull();
  });

  it("is allowed once every pick is right", () => {
    const d = fresh();
    for (const q of picks(d)) answerIt(d, q.id, q.table!.expect);
    // the rest of the grid's prices (V3) are confirmed as any other
    expect(gate(d)).toBeNull();
  });
});
