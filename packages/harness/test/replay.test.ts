import type { Grid, Rulebook, Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { missedCount, pairCounts, replayCounts, transcriptionOf } from "../scripts/scan-replay";
import { parseTranscription } from "../src/scan/transcribe";

const compact = (...lines: string[]) => ({ rotation: 0, text: lines.join("\n") });
const PAGE = compact("L 0.1-0.2 | The screen failure fee is $75.00 per subject.", "T 0.3-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.31-0.32 | Exam | $100.00 | $75.00", "R 0.33-0.34 | Labs | $50.00 | $60.00{hw}");

describe("scan-replay", () => {
  it("reads every saved form of a transcription", () => {
    const parsed = parseTranscription(PAGE);
    expect(transcriptionOf(PAGE)).toEqual(parsed);
    expect(transcriptionOf({ value: PAGE, usd: 0.1 })).toEqual(parsed);
    expect(transcriptionOf({ value: parsed, usd: 0.1 })).toEqual(parsed);
    expect(() => transcriptionOf({ value: { pages: [] } })).toThrow();
  });

  it("counts the outcomes of two reads by table", () => {
    const second = compact("L 0.1-0.2 | The screen failure fee is $85.00 per subject.", "T 0.3-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.31-0.32 | Exam | $100.00 | $75.00", "R 0.33-0.34 | Labs | $50.00 | $60.00");
    expect(pairCounts(transcriptionOf(PAGE), transcriptionOf(second))).toEqual({
      t1: { agree: 3, differ: 0, marked: 1, unaligned: 0 },
      lines: { agree: 0, differ: 1, marked: 0, unaligned: 0 },
    });
  });

  it("counts the amounts only the second read found", () => {
    const more = compact("L 0.1-0.2 | The screen failure fee is $75.00 per subject.", "T 0.3-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.31-0.32 | Exam | $100.00 | $75.00", "R 0.33-0.34 | Labs | $50.00 | $60.00{hw}", "R 0.35-0.36 | ECG | $40.00 |", "L 0.6-0.7 | Archiving is paid at $300.00.");
    expect(missedCount(transcriptionOf(PAGE), transcriptionOf(PAGE))).toBe(0);
    expect(missedCount(transcriptionOf(PAGE), transcriptionOf(more))).toBe(2);
  });

  it("matches an earlier rulebook's values to cells by value and page, and counts what coverage would miss", () => {
    const page2 = compact("T 0.1-0.3 | Budget (continued)", "H | Procedure | V3", "R 0.11-0.12 | Exam | $120.00", "R 0.13-0.14 | Labs | $55.00");
    const term = (id: string, cents: number): Term => ({
      id, category: "site_fee", name: id, amountCents: cents, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
      holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: "B.pdf", page: 1, quote: "fee" }, evidence: "none", houseRuleIds: [], notes: null,
    });
    const grid: Grid = {
      id: "g1", name: "Budget", arm: null, doc: "B.pdf", pages: [1, 2], visits: ["V1", "V2", "V3"], overheadPct: null, overhead: null, additions: [], total: null,
      rows: [
        { name: "Exam", code: null, unitCostCents: null, cells: [10000, 7500, 12000], printedRowTotalCents: null },
        { name: "Bloodwork", code: null, unitCostCents: null, cells: [5000, 9900, null], printedRowTotalCents: null },
      ],
      subtotal: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
    };
    const rulebook: Rulebook = {
      study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
      terms: [term("sf", 7500), term("gone", 99999)], grids: [grid], accounted: [], questions: [],
    };
    const scans = [PAGE, page2].map((c, i) => ({ page: i + 1, version: "v", rotation: 0, transcription: parseTranscription(c) }));
    const out = replayCounts(rulebook, [{ name: "B.pdf", label: "doc1", sha256: "x", scans }]);

    // $75.00 is printed twice on p.1, so neither value citing it can cite; $99.00 and $999.99 are printed nowhere; the
    // grid's $120.00 only on p.2; $60.00 and $55.00 no value has
    expect(out.pages).toEqual({
      "doc1 p.1": { one: 3, many: 2, nowhere: 2, missingInTables: 2, missingInLines: 1 },
      "doc1 p.2": { one: 0, many: 0, nowhere: 0, missingInTables: 1, missingInLines: 0 },
    });
    expect(out.rowNames).toEqual({ total: 2, notFound: 1 });
    expect(out.multiPage).toEqual({ values: 5, elsewhere: 1 });
  });
});
