import { bindEvidence, gateSweep, reviewFromEvidence, solveGrids, type RowBand, type Span } from "@dct/extraction";
import type { Rulebook, ValueEvidence } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { manualRulebook } from "../src/domain.js";
import { getExtraction } from "../src/extraction/port.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { reviewDraft, solverCounts } from "../src/review.js";

// ADR-002 PR 2 in reviewDraft: the arithmetic referee (solveGrids) and the zone gate on the sweep (gateSweep).

const prov = { source: { documentId: "d", page: 1 }, confidence: 1, method: "ai", crossCheck: "not_checked" } as const;
const docs = [{ id: "d", filename: "c.pdf" }];
const at = { documentId: "d", page: 1, box: null } as const;

/** One grid in which every identity balances: two visits, a row of 10000 each, a stipend, 30% overhead on the exam. */
function balanced(): Rulebook {
  const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
  const g = rb.budgetGrids[0]!;
  g.statedOverheadPct = 30;
  g.visits = [
    { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: 2000, totalCents: 15000, autopay: true, prov },
    { code: "V2", name: "Week 1", order: 2, procedureSubtotalCents: 10000, overheadCents: 3000, nonProcedureCents: null, totalCents: 13000, autopay: true, prov },
  ];
  g.procedures = [
    { code: null, name: "Exam", unitCents: 10000, overheadApplied: true, category: "procedure", cells: { V1: 10000, V2: 10000 }, prov },
    { code: null, name: "Stipend", unitCents: 2000, overheadApplied: false, category: "non_procedure", cells: { V1: 2000 }, prov },
  ];
  g.perPatientTotals = [{ label: "Total", cents: 28000, prov }];
  return rb;
}

const GRID_PATHS = (rb: Rulebook) => {
  const g = rb.budgetGrids[0]!;
  return [
    ...g.procedures.flatMap((p, pi) => [`/budgetGrids/0/procedures/${pi}/unitCents`, ...Object.keys(p.cells).map((k) => `/budgetGrids/0/procedures/${pi}/cells/${k}`)]),
    ...g.visits.flatMap((v, vi) => ["procedureSubtotalCents", "overheadCents", "nonProcedureCents", "totalCents"].filter((f) => (v as Record<string, unknown>)[f] !== null).map((f) => `/budgetGrids/0/visits/${vi}/${f}`)),
    "/budgetGrids/0/perPatientTotals/0/cents",
  ];
};

// the unit prices are what the binder confirms from the page (and are in no identity); the rest is up to the referee
const UPGRADABLE = (rb: Rulebook) => GRID_PATHS(rb).filter((p) => !p.endsWith("/unitCents"));

/** The binder's real answer with the grid's values replaced: each unconfirmed, citing page 1 unless `noPage` lists it; the unit prices confirmed. */
const binding = (rb: Rulebook, noPage: string[] = [], unaccounted: Span[] = []) => (r: Rulebook, pages: Parameters<typeof bindEvidence>[1]) => {
  const b = bindEvidence(r, pages);
  const grid = new Set(GRID_PATHS(rb));
  const evidence = [...b.evidence.filter((e) => !grid.has(e.path)), ...GRID_PATHS(rb).map((path): ValueEvidence => ({ path, status: path.endsWith("/unitCents") ? "confirmed" : "ungrounded", where: noPage.includes(path) ? [] : [at], printed: null, note: null }))];
  return { ...b, evidence, unaccounted, rows: printedRows(rb) };
};
/** What the binder finds in a table that prints a total column: each row's printed total is the sum of its cells (the solver's row identity compares the read's cells with it). */
const printedRows = (rb: Rulebook): RowBand[] =>
  rb.budgetGrids.flatMap((g, gi) => g.procedures.map((p, pi): RowBand => ({ grid: gi, procedure: pi, documentId: "d", page: 1, box: [0, 0, 1, 0.1], cells: [], total: Object.values(p.cells).reduce<number>((a, c) => a + (typeof c === "number" ? c : 0), 0), by: "row_total", covers: null })));
const full = { reviewFromEvidence, solveGrids, gateSweep };
// the questions about values nothing confirmed
const asked = (review: { path: string | null; reason: string }[]) => new Set(review.flatMap((i) => (i.path ? [i.path] : [])));
const statusOf = (ev: ValueEvidence[], path: string) => ev.find((e) => e.path === path)?.status;

describe("the arithmetic referee in reviewDraft", () => {
  it("a value the document's own sums prove becomes confirmed_by_math and asks no question; without the solver it is asked", () => {
    const rb = balanced();
    const solved = reviewDraft({ ...full, bindEvidence: binding(rb) }, rb, [], [], docs);
    for (const p of UPGRADABLE(rb)) {
      expect(statusOf(solved.evidence, p), p).toBe("confirmed_by_math");
      expect(asked(solved.review).has(p), p).toBe(false);
    }
    expect(solved.solver).toMatchObject({ mode: "guide", noPage: 0, upgraded: { total: UPGRADABLE(rb).length } });
    // the same read without the referee (as before PR 2): every one is a question
    const plain = reviewDraft({ bindEvidence: binding(rb), reviewFromEvidence }, rb, [], [], docs);
    expect(plain.solver).toBeUndefined();
    for (const p of UPGRADABLE(rb)) expect(asked(plain.review).has(p), p).toBe(true);
  });

  it("a figure that doesn't add up is asked as before, and its identity is reported by pointer, in both modes", () => {
    const rb = balanced();
    rb.budgetGrids[0]!.visits[1]!.totalCents = 13100; // $1 off: the visit total and the per-patient total stop adding up
    for (const solver of ["guide", "strict"] as const) {
      const out = reviewDraft({ ...full, bindEvidence: binding(rb) }, rb, [], [], docs, { solver });
      expect(out.solver!.mode).toBe(solver);
      expect(statusOf(out.evidence, "/budgetGrids/0/visits/1/totalCents"), solver).toBe("ungrounded");
      expect(asked(out.review).has("/budgetGrids/0/visits/1/totalCents"), solver).toBe(true);
      expect(statusOf(out.evidence, "/budgetGrids/0/procedures/0/cells/V1"), solver).toBe("confirmed_by_math");
      expect(out.solver!.failures.map((f) => f.identity)).toContain("visitTotal");
      expect(out.solver!.failures.flatMap((f) => f.paths)).toContain("/budgetGrids/0/visits/1/totalCents");
    }
  });

  it("a value that cites no page is never made math-confirmed: it stays asked, and is counted", () => {
    const rb = balanced();
    const lost = "/budgetGrids/0/procedures/0/cells/V1";
    const out = reviewDraft({ ...full, bindEvidence: binding(rb, [lost]) }, rb, [], [], docs);
    expect(statusOf(out.evidence, lost)).toBe("ungrounded");
    expect(asked(out.review).has(lost)).toBe(true);
    expect(out.solver!.noPage).toBe(1);
    expect(out.solver!.upgraded.total).toBe(UPGRADABLE(rb).length - 1);
  });

  it("the audit gets counts only", () => {
    const rb = balanced();
    const out = reviewDraft({ ...full, bindEvidence: binding(rb) }, rb, [], [], docs);
    const counts = solverCounts(out.solver!);
    expect(Object.keys(counts).sort()).toEqual(["heldWouldPass", "identities", "mode", "noPage", "upgraded"]);
    expect(JSON.stringify(counts)).not.toContain("/budgetGrids");
  });
});

describe("the sweep gate in reviewDraft", () => {
  const span = (text: string, sentence: string): Span => ({
    kind: "amount",
    where: at,
    words: [{ text, rect: [0, 0, 0, 0], dir: 0, block: 0, line: 0, hidden: false }],
    text: sentence,
    lines: [at],
    cents: 100_000_000,
  });
  const insurance = span("$1,000,000", "Commercial general liability insurance of $1,000,000 per occurrence");
  const fee = span("$250.00", "Archive fee $250.00 a year");

  it("an insurance limit is dropped and counted, never silently; a fee next to it is still asked", () => {
    const rb = balanced();
    const out = reviewDraft({ ...full, bindEvidence: binding(rb, [], [insurance, fee]) }, rb, [], [], docs);
    expect(out.sweep).toMatchObject({ insurance: 1, kept: 1 });
    const terms = out.review.filter((i) => i.reason === "UNACCOUNTED_TERM");
    expect(terms).toHaveLength(1);
    expect(terms[0]!.term?.quote).toContain("Archive fee");
    // without the gate (before PR 2) both are asked
    const plain = reviewDraft({ bindEvidence: binding(rb, [], [insurance, fee]), reviewFromEvidence }, rb, [], [], docs);
    expect(plain.sweep).toBeUndefined();
    expect(plain.review.filter((i) => i.reason === "UNACCOUNTED_TERM")).toHaveLength(2);
  });

  it("is given the solved evidence, and the triage's excluded pages are still dropped before it", () => {
    const rb = balanced();
    let seen: ValueEvidence[] = [];
    let spans = 0;
    const out = reviewDraft(
      { ...full, bindEvidence: binding(rb, [], [fee]), gateSweep: (u, ctx) => ((seen = [...ctx.evidence]), (spans = u.length), gateSweep(u, ctx)) },
      rb, [], [], docs, { excluded: [{ documentId: "d", page: 1 }] },
    );
    expect(statusOf(seen, "/budgetGrids/0/visits/0/totalCents")).toBe("confirmed_by_math");
    expect(spans).toBe(0);
    expect(out.excluded).toEqual([{ documentId: "d", page: 1, spans: 1 }]);
  });
});

describe("the port", () => {
  it("fake mode keeps the real referee and sweep gate: it fakes only the AI", async () => {
    const port = await getExtraction();
    expect(port.solveGrids).toBe(solveGrids);
    expect(port.gateSweep).toBe(gateSweep);
  });
});

describe("EXTRACTION_SOLVER", () => {
  const base = { DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_test", EXTRACTION_FAKE: "1" };
  it("defaults to strict and takes guide", () => {
    expect(parseConfig(base).extractionSolver).toBe("strict");
    expect(parseConfig({ ...base, EXTRACTION_SOLVER: "guide" }).extractionSolver).toBe("guide");
  });
  it("names the setting, never its value, when it is neither", () => {
    expect(() => parseConfig({ ...base, EXTRACTION_SOLVER: "lenient-secret" })).toThrow(ConfigError);
    try {
      parseConfig({ ...base, EXTRACTION_SOLVER: "lenient-secret" });
    } catch (e) {
      expect((e as Error).message).toContain("EXTRACTION_SOLVER must be guide or strict");
      expect((e as Error).message).not.toContain("lenient-secret");
    }
  });
});
