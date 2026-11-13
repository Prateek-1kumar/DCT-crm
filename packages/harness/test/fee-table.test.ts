import { describe, expect, it } from "vitest";
import type { FeeTable, Rulebook } from "@dct/shared";
import { normalizeFeeTable } from "../src/agent/normalize";
import { createSession } from "../src/agent/session";
import { checks, forPerson } from "../src/checks";
import { coverage } from "../src/checks/coverage";
import { checkFeeTable } from "../src/checks/feeTable";
import { withScans } from "../src/scan";
import { parseTranscription } from "../src/scan/transcribe";
import type { LoadedDoc, Page, PageKind } from "../src/types";
import { wordsOf } from "./words";

type Term = Rulebook["terms"][number];

const page = (n: number, kind: PageKind, layout: string): Page => ({ page: n, kind, layout, raw: layout, words: wordsOf(layout), maskBoxes: [], firstLine: "", rotation: 0 });
const doc = (...pages: Page[]): LoadedDoc => ({ name: "A.pdf", path: "/x/A.pdf", sha256: "0", pages });
const scanned = (text: string) => withScans(doc(page(1, "image", "")), [{ page: 1, version: "v", rotation: 0, transcription: parseTranscription({ rotation: 0, text }) }]);

const term = (id: string, amountCents: number | null, over: Partial<Term> = {}): Term => ({
  id, category: "invoiceable", name: id, amountCents, unit: "per occurrence", billing: "invoice", trigger: null, cap: null,
  formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
  source: { doc: "A.pdf", page: 1, quote: "x" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});
const line = (name: string, totalCents: number, quantity: number | null, ...termIds: string[]) => ({ name, totalCents, quantity, termIds });
const table = (over: Partial<FeeTable> = {}): FeeTable => ({ id: "ft", name: "Site costs", doc: "A.pdf", pages: [1], totalCents: null, lines: [], ...over });
const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [], grids: [], accounted: [], questions: [], ...over,
});

// Re-consent 12 × $150.00 = $1,800.00; a pharmacy section of two fees printing only its $2,300.00 total; table total $4,100.00.
const TERMS = [term("reconsent", 15000), term("pharm-setup", 50000), term("pharm-maint", 20000)];
const LINES = [line("Re-consent", 180000, 12, "reconsent"), line("Pharmacy fees", 230000, null, "pharm-setup", "pharm-maint")];

describe("normalizeFeeTable", () => {
  it("turns printed amounts into cents and keeps a scanned total's cell", () => {
    const out = normalizeFeeTable({
      id: "ft", name: "Site costs", doc: "A.pdf", pages: [1], total: { value: "US$ 4,100.00", cell: "p1.t1.r3.c3" },
      lines: [{ name: "Re-consent", total: { value: "$1,800.00", cell: "p1.t1.r1.c3" }, quantity: "12", termIds: "reconsent" }, { name: "Pharmacy fees", total: 2300, termIds: ["a", "b"] }],
    });
    expect(out).toEqual({
      ok: true,
      value: {
        id: "ft", name: "Site costs", doc: "A.pdf", pages: [1], totalCents: 410000, totalCell: "p1.t1.r3.c3",
        lines: [{ name: "Re-consent", totalCents: 180000, quantity: 12, termIds: ["reconsent"], cell: "p1.t1.r1.c3" }, { name: "Pharmacy fees", totalCents: 230000, quantity: null, termIds: ["a", "b"] }],
      },
    });
  });

  it("refuses a line with no total, a quantity that is no number and an id with a colon", () => {
    const out = normalizeFeeTable({ id: "a:b", name: "T", doc: "A.pdf", pages: [1], lines: [{ name: "X", quantity: "many", termIds: [] }] });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.issues.join(" ")).toMatch(/line 'X': give the line's printed total.*"many" is not a number.*can't contain a colon/);
  });
});

describe("checkFeeTable", () => {
  it("proves a line by quantity × amount and the table by its lines adding up", () => {
    expect(checkFeeTable(table({ totalCents: 410000, lines: LINES }), TERMS)).toEqual({ problems: [], proven: ["reconsent"], refuted: [] });
  });

  it("fails a line total stored as the term's amount", () => {
    const r = checkFeeTable(table({ lines: [line("Screen failures", 1800000, 12, "sf")] }), [term("sf", 1800000, { name: "Screen failure" })]);
    expect(r.refuted).toEqual(["sf"]);
    expect(r.problems).toEqual([
      "line 'Screen failures': 12 × $18,000.00 (the amount of 'Screen failure') comes to $216,000.00 but the printed line total is $18,000.00. The amount is the line's total, not the payment for one. Re-read the table and correct the line, the quantity or the term's amount.",
    ]);
  });

  it("says by how much the lines miss the printed total", () => {
    const [short] = checkFeeTable(table({ totalCents: 410000, lines: LINES.slice(0, 1) }), TERMS).problems;
    expect(short).toContain("the lines add up to $1,800.00 but the printed total is $4,100.00, $2,300.00 short: a line is missing or misread.");
    const [over] = checkFeeTable(table({ totalCents: 410000, lines: [...LINES, LINES[0]!] }), TERMS).problems;
    expect(over).toContain("$1,800.00 over: a line is misread or listed twice.");
  });

  it("has no product to check on a section of several terms, a line with no quantity, a term with no amount or a person's answer", () => {
    const lines = [line("Pharmacy fees", 230000, 5, "pharm-setup", "pharm-maint"), line("Re-consent", 999, null, "reconsent"), line("Travel", 999, 3, "travel"), line("Audit", 999, 3, "audit")];
    const terms = [...TERMS, term("travel", null), term("audit", 100, { evidence: "person" })];
    expect(checkFeeTable(table({ lines }), terms)).toEqual({ problems: [], proven: [], refuted: [] });
  });

  it("rounds only a fractional quantity", () => {
    const hours = (quantity: number, totalCents: number) => checkFeeTable(table({ lines: [line("Audit", totalCents, quantity, "audit")] }), [term("audit", 3333)]).problems.length;
    expect(hours(1.5, 5000)).toBe(0);
    expect(hours(3, 10000)).toBe(1);
  });

  it("reports a term the rulebook doesn't have", () => {
    expect(checkFeeTable(table({ lines: [line("Re-consent", 180000, 12, "gone")] }), TERMS).problems[0]).toContain("line 'Re-consent' lists a fee ('gone') that is not in the rulebook.");
  });
});

describe("fee tables in the whole check", () => {
  const text = "Re-consent 12 150.00 US$ 1,800.00\nPharmacy set-up 500.00\nPharmacy maintenance 200.00\nPharmacy fees total US$ 2,300.00\nTOTAL NOT TO EXCEED US$ 4,100.00";
  const docs = [doc(page(1, "text", text))];
  const quoted = TERMS.map((t) => ({ ...t, source: { doc: "A.pdf", page: 1, quote: "Pharmacy" } }));
  const full = table({ totalCents: 410000, lines: LINES });

  it("counts a fee table's line totals and table total as accounted for, and nothing else", () => {
    expect(checks.runChecks(rulebook({ terms: quoted }), docs).unaccounted.map((u) => u.amountCents)).toEqual([180000, 230000, 410000]);
    expect(checks.runChecks(rulebook({ terms: quoted, feeTables: [full] }), docs).problems).toEqual([]);
    const amounts = coverage(rulebook({ terms: quoted, feeTables: [full] }), docs).pages[0]!.amounts;
    expect(amounts.find((a) => a.cents === 180000)).toMatchObject({ status: "captured", ref: { target: "term", id: "reconsent" } });
    expect(amounts.find((a) => a.cents === 410000)).toMatchObject({ status: "captured", ref: null });
  });

  it("stops a whole page being set aside once a fee table takes amounts from it", () => {
    const aside = { doc: "A.pdf", pages: [1], reason: "superseded" };
    expect(checks.runChecks(rulebook({ accounted: [aside] }), docs).unaccounted).toEqual([]);
    expect(checks.runChecks(rulebook({ accounted: [aside], feeTables: [table({ lines: LINES })] }), docs).unaccounted.map((u) => u.amountCents)).toEqual([15000, 50000, 20000, 410000]);
  });

  it("reports a refuted term once, in the fee table's words, with a version for the accountant", () => {
    const sf = term("sf", 1800000, { name: "Screen failure", category: "screen_failure", unit: "per screen failure", formula: "$1,500.00 each", cap: { kind: "count", value: 12, period: null, text: "max 12" }, source: { doc: "A.pdf", page: 1, quote: "Screen failure" } });
    const page1 = [doc(page(1, "text", "Screen failure 12 $1,500.00 $18,000.00"))];
    expect(checks.runChecks(rulebook({ terms: [sf] }), page1).problems.map((p) => p.check)).toEqual(["amount"]);
    const problems = checks.runChecks(rulebook({ terms: [sf], feeTables: [table({ lines: [line("Screen failure", 1800000, 12, "sf")] })] }), page1).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ check: "fee_table", id: "ft", doc: "A.pdf", page: 1 });
    expect(forPerson(problems[0]!)).toBe(
      "In the fee table 'Site costs': line 'Screen failure': 12 × $18,000.00 (the amount of 'Screen failure') comes to $216,000.00 but the printed line total is $18,000.00. The amount is the line's total, not the payment for one. Start the read again.",
    );
  });
});

describe("fee tables on a scanned page", () => {
  const scan = scanned(["T 0.1-0.5 | Site costs", "H | Item | Quantity | Rate | Total", "R 0.11-0.12 | Re-consent | 12 | $150.00 | $1,800.00", "R 0.13-0.14 | Total not to exceed | | | $1,800.00"].join("\n"));
  const reconsent = { id: "reconsent", category: "invoiceable", name: "Re-consent", amount: "$150.00", unit: "per occurrence", billing: "invoice", source: { doc: "A.pdf", page: 1, quote: "Re-consent 12 $150.00 $1,800.00", cell: "p1.t1.r1.c2" } };
  const feeTable = (lineCell: string | undefined) => ({
    id: "ft", name: "Site costs", doc: "A.pdf", pages: [1], total: { value: "$1,800.00", cell: "p1.t1.r2.c3" },
    lines: [{ name: "Re-consent", total: lineCell ? { value: "$1,800.00", cell: lineCell } : "$1,800.00", quantity: 12, termIds: ["reconsent"] }],
  });
  const study = { protocol: "P-1", sponsor: "Acme", siteEntity: "Site LLC", documents: [{ doc: "A.pdf", role: "cta" }] };

  it("refuses a total with no cell or the wrong cell, and counts the cited cells as accounted for", async () => {
    const session = createSession([scan], 3);
    await session.run("put_study", { study });
    expect((await session.run("put_terms", { terms: [reconsent] })).isError).toBe(false);
    expect(String((await session.run("finish", {})).content)).toContain("UNACCOUNTED: $1,800.00");

    const uncited = await session.run("put_fee_table", { feeTable: feeTable(undefined) });
    expect(uncited.isError).toBe(true);
    expect(String(uncited.content)).toContain("the total of line 'Re-consent' is on a scanned page, so it has to cite the cell");
    expect(String((await session.run("put_fee_table", { feeTable: feeTable("p1.t1.r1.c2") })).content)).toContain('cell p1.t1.r1.c2 prints "$150.00"');

    expect(String((await session.run("put_fee_table", { feeTable: feeTable("p1.t1.r1.c3") })).content)).toBe("PROVEN: the lines add up to the printed total; quantity × amount is the line total for term reconsent.");
    expect(session.rulebook().feeTables).toHaveLength(1);
    expect(String((await session.run("finish", {})).content)).toContain("ALL CHECKS PASS");
  });
});

describe("put_fee_table on a text page", () => {
  it("returns the arithmetic at once and finish repeats what is still wrong", async () => {
    const session = createSession([doc(page(1, "text", "Screen failure 12 1,500.00 US$ 18,000.00"))], 3);
    await session.run("put_study", { study: { protocol: "P-1", sponsor: "Acme", siteEntity: "Site LLC", documents: [{ doc: "A.pdf", role: "cta" }] } });
    const sf = (amount: string) => ({ id: "sf", category: "screen_failure", name: "Screen failure", amount, unit: "per screen failure", billing: "invoice", source: { doc: "A.pdf", page: 1, quote: "Screen failure 12" } });
    const feeTable = { id: "ft", name: "Site costs", doc: "A.pdf", pages: [1], lines: [{ name: "Screen failure", total: "US$ 18,000.00", quantity: 12, termIds: ["sf"] }] };
    await session.run("put_terms", { terms: [sf("US$ 18,000.00")] });
    expect(String((await session.run("put_fee_table", { feeTable })).content)).toContain("12 × $18,000.00 (the amount of 'Screen failure') comes to $216,000.00");
    expect(String((await session.run("finish", {})).content)).toContain("FEE_TABLE ft: fee table 'Site costs': line 'Screen failure': 12 × $18,000.00");
    await session.run("put_terms", { terms: [sf("1,500.00")] });
    expect(String((await session.run("finish", {})).content)).toContain("ALL CHECKS PASS");
  });
});
