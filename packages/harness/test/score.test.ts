import { expect, test } from "vitest";
import { score, type Key, type Rulebook } from "../scripts/score";

const key: Key = {
  bundle: "synthetic",
  terms: [{ id: "sf", name: "Screen failure", amountCents: 150000 }, { id: "start", name: "Start-up", amountCents: 500000 }],
  grids: [{ name: "Budget", visits: ["V1", "V2"], rows: [{ name: "Exam", cells: [10000, 10000] }, { name: "Lab", cells: [5000, null] }], total: [15000, 10000], grandTotalCents: 25000 }],
  decisions: [{ id: "sf-partial", question: "What is paid after visit 1 only?", match: "screen.fail.*(visit 1|work completed)" }],
  missedRules: [{ text: "Storage at sponsor's expense", match: "storage" }],
};

const good: Rulebook = {
  terms: [{ name: "Screen failure", amountCents: 150000 }, { name: "Start-up fee", amountCents: 500000, notes: "storage at sponsor's expense" }],
  // rows in another order still match: a visit is compared by what it holds
  grids: [{ name: "B", visits: ["V1", "V2"], rows: [{ name: "Lab", cells: [5000, null] }, { name: "Exam", cells: [10000, 10000] }], total: [15000, 10000], grandTotalCents: 25000 }],
  questions: [{ question: "For a screen failure, what is paid if only Visit 1 is done?", state: "open", blocking: true }],
};

test("a rulebook that agrees with the key has nothing missing", () => {
  const s = score(key, good);
  expect([s.valuesMissing, s.unexpectedAmounts, s.decisionsMissing, s.missedRules, s.unexpectedQuestions]).toEqual([[], [], [], [], []]);
  expect(s.gridVisitsWrong).toBe(0);
});

test("a line total stored as the amount, a wrong cell and an unasked decision are each reported", () => {
  const bad: Rulebook = {
    terms: [{ name: "Screen failure", amountCents: 6150000 }, { name: "Start-up fee", amountCents: 500000 }],
    grids: [{ ...good.grids[0]!, rows: [{ name: "Lab", cells: [5000, null] }, { name: "Exam", cells: [10000, 12000] }] }],
    questions: [{ question: "Is the start-up fee refundable?", state: "open" }],
  };
  const s = score(key, bad);
  expect(s.valuesMissing.map((v) => v.id)).toEqual(["sf"]);
  expect(s.unexpectedAmounts.map((v) => v.amountCents)).toEqual([6150000]);
  expect(s.grids[0]!.wrongVisits).toEqual(["V2"]);
  expect(s.decisionsMissing).toEqual(["sf-partial"]);
  expect(s.unexpectedQuestions).toHaveLength(1);
  expect(s.missedRules).toEqual(["Storage at sponsor's expense"]);
});
