import type { Rulebook, ValueEvidence } from "@dct/shared";
import { describe, expect, it } from "vitest";
import type { RowBand } from "../src/binder";
import { solveGrids } from "../src/solver";
import { makeRulebook, prov } from "./helpers";

type Row = { unit: number | null; cells: Record<string, number>; applied?: boolean; category?: "procedure" | "non_procedure" };

/** A grid whose every figure is consistent: visit sums, 40% overhead on the rows that carry it, totals, per-patient total. */
function grid(rows: Row[]): Rulebook {
  const rb = structuredClone(makeRulebook());
  const g = rb.budgetGrids[0]!;
  g.procedures = structuredClone(rows).map((r, i) => ({ code: `P${i}`, name: `Row ${i}`, unitCents: r.unit, overheadApplied: r.applied ?? true, category: r.category ?? "procedure", cells: r.cells, prov }));
  g.visits = g.visits.map((v) => {
    const at = (f: (r: Row) => boolean) => rows.filter(f).reduce((a, r) => a + (r.cells[v.code] ?? 0), 0);
    const proc = at((r) => (r.category ?? "procedure") === "procedure");
    const non = at((r) => r.category === "non_procedure");
    const oh = Math.round(at((r) => r.applied ?? true) * 0.4);
    return { ...v, procedureSubtotalCents: proc, nonProcedureCents: non, overheadCents: oh, totalCents: proc + oh + non };
  });
  g.perPatientTotals = [{ label: "Total", cents: g.visits.reduce((a, v) => a + v.totalCents, 0), prov }];
  return rb;
}

/** Two flat-priced rows over two visits: every identity balances. */
const FLAT: Row[] = [
  { unit: 30000, cells: { V1: 30000, V2: 30000 } },
  { unit: 20000, cells: { V1: 20000, V2: 20000 } },
  { unit: 10000, cells: { V1: 10000, V2: 10000 }, category: "non_procedure" },
];

/**
 * What the binder finds in a table that prints a total column: one band per row, its total the sum of the cells AS THE PAGE
 * prints them (so build it from the true grid, before a test plants an error in the read). `skip`: rows whose table prints none.
 */
function pageRows(rb: Rulebook, skip: number[] = []): RowBand[] {
  return rb.budgetGrids.flatMap((g, gi) =>
    g.procedures.map((p, pi): RowBand => ({
      grid: gi,
      procedure: pi,
      documentId: "d1",
      page: 1,
      box: [0, 0.1 * pi, 1, 0.1],
      cells: [],
      total: skip.includes(pi) ? null : Object.values(p.cells).reduce<number>((a, c) => a + (typeof c === "number" ? c : 0), 0),
      by: skip.includes(pi) ? null : "row_total",
      covers: null,
    })),
  );
}

/** Twelve whole-dollar rows: enough figures that one with stray cents is a misread, not a grid that prints cents. */
const BIG: Row[] = Array.from({ length: 12 }, (_, i) => ({ unit: 10000 + 500 * i, cells: { V1: 10000 + 500 * i, V2: 10000 + 500 * i } }));

const cell = (r: number, v: string) => `/budgetGrids/0/procedures/${r}/cells/${v}`;

/** One entry for every figure the identities can touch. `units`: the status of the unit prices (they are in no identity: math never upgrades one). */
function evidence(rb: Rulebook, status: ValueEvidence["status"] = "ungrounded", printed: string | null = null, units: ValueEvidence["status"] = "confirmed"): ValueEvidence[] {
  const paths = rb.budgetGrids.flatMap((g, gi) => [
    ...g.procedures.flatMap((p, pi) => [`/budgetGrids/${gi}/procedures/${pi}/unitCents`, ...Object.keys(p.cells).map((k) => `/budgetGrids/${gi}/procedures/${pi}/cells/${k}`)]),
    ...g.visits.flatMap((_, vi) => ["procedureSubtotalCents", "overheadCents", "nonProcedureCents", "totalCents"].map((f) => `/budgetGrids/${gi}/visits/${vi}/${f}`)),
    ...g.perPatientTotals.map((_, ti) => `/budgetGrids/${gi}/perPatientTotals/${ti}/cents`),
  ]);
  return paths.map((path) => ({ path, status: path.endsWith("/unitCents") ? units : status, where: [], printed, note: null }));
}

const statusOf = (ev: ValueEvidence[], path: string) => ev.find((e) => e.path === path)?.status;
const upgradedPaths = (before: ValueEvidence[], after: ValueEvidence[]) => after.filter((e, i) => e.status !== before[i]!.status).map((e) => e.path);
const MODES = ["guide", "strict"] as const;

describe("solveGrids", () => {
  it("a balanced grid upgrades its cells, in both modes", () => {
    const rb = grid(FLAT);
    for (const mode of MODES) {
      const ev = evidence(rb);
      const { evidence: out, report } = solveGrids(rb, ev, { mode, rows: pageRows(rb) });
      expect(report.mode).toBe(mode);
      expect(report.failures).toEqual([]);
      expect(statusOf(out, cell(0, "V1"))).toBe("confirmed_by_math");
      expect(statusOf(out, cell(2, "V2"))).toBe("confirmed_by_math");
      // the unit prices are in no identity (the page's row total is compared with the cells, never with the read's own unit price)
      expect(statusOf(out, "/budgetGrids/0/procedures/0/unitCents")).toBe("confirmed");
      expect(statusOf(out, "/budgetGrids/0/visits/0/totalCents")).toBe("confirmed_by_math");
      expect(statusOf(out, "/budgetGrids/0/perPatientTotals/0/cents")).toBe("confirmed_by_math");
      expect(out.every((e) => e.status === (e.path.endsWith("/unitCents") ? "confirmed" : "confirmed_by_math"))).toBe(true);
      expect(report.upgraded).toEqual({ total: ev.length - 3, ungrounded: ev.length - 3, conflict: 0 });
      expect(Object.entries(report.identities).filter(([k]) => k !== "rowUnit").every(([, t]) => t.checked > 0 && t.failed === 0)).toBe(true);
      expect(report.identities.row.checked).toBe(3);
    }
  });

  it("defaults to guide mode", () => {
    expect(solveGrids(grid(FLAT), []).report.mode).toBe("guide");
  });

  it("the unit prices stay as they were whatever their status: math upgrades none", () => {
    const rb = grid(FLAT);
    for (const units of ["ungrounded", "conflict"] as const) {
      const out = solveGrids(rb, evidence(rb, "ungrounded", null, units), { rows: pageRows(rb) }).evidence;
      expect(statusOf(out, "/budgetGrids/0/procedures/0/unitCents")).toBe(units);
      // a row's cells need no backed unit price now: the printed total is the page's, not the read's
      expect(statusOf(out, cell(0, "V1"))).toBe("confirmed_by_math");
    }
  });

  describe("the row identity is the page's printed total", () => {
    it("a table that prints no row total or quantity has no row identity: no visit cell is confirmed by math, visit values still are", () => {
      const rb = grid(FLAT);
      for (const mode of MODES) {
        const { evidence: out, report } = solveGrids(rb, evidence(rb), { mode });
        expect(report.identities.row.checked, mode).toBe(0);
        expect(statusOf(out, cell(0, "V1")), mode).toBe("ungrounded");
        // a column sum alone can't say which row a number belongs to; the unit x count of the read's own cells proves nothing either
        expect(out.filter((e) => e.path.includes("/cells/")).every((e) => e.status === "ungrounded"), mode).toBe(true);
        expect(statusOf(out, "/budgetGrids/0/visits/0/totalCents"), mode).toBe("confirmed_by_math");
        expect(statusOf(out, "/budgetGrids/0/perPatientTotals/0/cents"), mode).toBe("confirmed_by_math");
        expect(report.upgraded.total, mode).toBeGreaterThan(0);
      }
    });

    it("a row the table prints no total for has none: only the rows with one are checked", () => {
      const rb = grid(FLAT);
      const { evidence: out, report } = solveGrids(rb, evidence(rb), { rows: pageRows(rb, [1]) });
      expect(report.identities.row.checked).toBe(2);
      expect(statusOf(out, cell(0, "V1"))).toBe("confirmed_by_math");
      expect(statusOf(out, cell(1, "V1"))).toBe("ungrounded");
    });

    it("compares the read's cells with the page's total, not with the read's own sum: a cell the read got wrong fails its row", () => {
      const rb = grid(FLAT);
      const rows = pageRows(rb);
      rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 31000; // the page prints 600.00 for the row; the read's cells now add to 610.00
      for (const mode of MODES) {
        const { evidence: out, report } = solveGrids(rb, evidence(rb), { mode, rows });
        expect(report.failures.filter((f) => f.identity === "row").map((f) => f.paths), mode).toEqual([[cell(0, "V1"), cell(0, "V2")]]);
        expect([cell(0, "V1"), cell(0, "V2")].map((p) => statusOf(out, p)), mode).toEqual(["ungrounded", "ungrounded"]);
      }
    });

    it("a cell the read missed fails its row, though the read's remaining cells still balance their own unit price", () => {
      const rb = grid(FLAT);
      const rows = pageRows(rb);
      delete rb.budgetGrids[0]!.procedures[0]!.cells.V2; // 600.00 printed, 300.00 read; unit x count (300 x 1) matches the cells
      const { report } = solveGrids(rb, evidence(rb), { rows });
      expect(report.identities.row.failed).toBe(1);
    });

    it("a row with an invoiceable cell has no row identity (its printed total includes a price the read holds as a word)", () => {
      const rb = grid(FLAT);
      rb.budgetGrids[0]!.procedures[0]!.cells = { V1: 30000, V2: "invoiceable" };
      const { report } = solveGrids(rb, evidence(rb), { rows: pageRows(grid(FLAT)) });
      expect(report.identities.row.checked).toBe(2);
    });

    it("ignores a band of another grid or a procedure the read doesn't have", () => {
      const rb = grid(FLAT);
      const stray = pageRows(rb).map((r, i) => ({ ...r, grid: i === 0 ? 5 : r.grid, procedure: i === 1 ? 9 : r.procedure }));
      expect(solveGrids(rb, evidence(rb), { rows: stray }).report.identities.row.checked).toBe(1);
    });
  });

  it("one wrong cell fails its row, column and overhead identity and is never confirmed", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 31000;
    for (const mode of MODES) {
      const { evidence: out, report } = solveGrids(rb, evidence(rb), { mode, rows });
      expect(statusOf(out, cell(0, "V1"))).toBe("ungrounded");
      const failed = report.failures.filter((f) => f.paths.includes(cell(0, "V1")));
      expect(failed.map((f) => f.identity).sort()).toEqual(["column", "overhead", "row"]);
      expect(report.identities.row.failed).toBe(1);
      expect(report.identities.column.failed).toBe(1);
      // the visit total doesn't read the cells, so it still balances on its own parts
      expect(statusOf(out, "/budgetGrids/0/visits/0/totalCents")).toBe("confirmed_by_math");
      // its row-mate (the row fails) and its column-mate (the column fails): neither is confirmed, in either mode
      expect(statusOf(out, cell(0, "V2"))).toBe("ungrounded");
      expect(statusOf(out, cell(1, "V1"))).toBe("ungrounded");
    }
  });

  // Owner-accepted tradeoff (ADR-002 §3b): arithmetic can't see errors that cancel in the row AND in the column. A row error
  // that cancels inside the row is still caught by its column, and the other way round.
  it("compensating errors in a row (+10 and -10): the columns catch them in both modes; cancelled in the columns too, they pass", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    const g = rb.budgetGrids[0]!;
    g.procedures[0]!.cells = { V1: 31000, V2: 29000 };
    const wrong = [cell(0, "V1"), cell(0, "V2")];

    for (const mode of MODES) {
      const r = solveGrids(rb, evidence(rb), { mode, rows });
      expect(wrong.map((p) => statusOf(r.evidence, p)), mode).toEqual(["ungrounded", "ungrounded"]);
      expect(r.report.identities.row.failed, mode).toBe(0);
      expect(r.report.identities.column.failed, mode).toBe(2);
    }

    // cancelled in the columns too by an opposite error in another row: every sum balances (the residual the owner accepted)
    g.procedures[2]!.cells = { V1: 9000, V2: 11000 };
    for (const mode of MODES) {
      const both = solveGrids(rb, evidence(rb), { mode, rows });
      expect(both.report.failures, mode).toEqual([]);
      expect(wrong.map((p) => statusOf(both.evidence, p)), mode).toEqual(["confirmed_by_math", "confirmed_by_math"]);
    }
  });

  it("two cells swapped within a row: the row balances, the columns don't, so both modes reject", () => {
    const read = grid([{ unit: 20000, cells: { V1: 10000, V2: 30000 } }, { unit: 5000, cells: { V1: 5000, V2: 5000 }, category: "non_procedure" }]);
    const rows = pageRows(read);
    const swapped = structuredClone(read);
    swapped.budgetGrids[0]!.procedures[0]!.cells = { V1: 30000, V2: 10000 };
    const paths = [cell(0, "V1"), cell(0, "V2")];

    for (const mode of MODES) {
      expect(solveGrids(read, evidence(read), { mode, rows }).report.failures, mode).toEqual([]);
      const r = solveGrids(swapped, evidence(swapped), { mode, rows });
      expect(r.report.identities.row.failed, mode).toBe(0);
      expect(paths.map((p) => statusOf(r.evidence, p)), mode).toEqual(["ungrounded", "ungrounded"]);
      expect(r.report.identities.column.failed, mode).toBe(2);
    }
  });

  describe("tolerance depends on the operation and on what the figures print", () => {
    /** The same grid with cents in it: prices of 300.50, 200.25 and 100.75, every sum exact. */
    const CENTS: Row[] = [
      { unit: 30050, cells: { V1: 30050, V2: 30050 } },
      { unit: 20025, cells: { V1: 20025, V2: 20025 } },
      { unit: 10075, cells: { V1: 10075, V2: 10075 }, category: "non_procedure" },
    ];
    const total = "/budgetGrids/0/visits/0/totalCents";

    it("addition on a whole-dollar grid is exact: 3 cents off fails, in both modes", () => {
      const rb = grid(BIG);
      rb.budgetGrids[0]!.visits[0]!.totalCents += 3;
      for (const mode of MODES) {
        const r = solveGrids(rb, evidence(rb), { mode });
        expect(statusOf(r.evidence, total), mode).toBe("ungrounded");
        expect(r.report.failures.some((f) => f.identity === "visitTotal" && f.paths.includes(total)), mode).toBe(true);
      }
    });

    it("addition on a grid that prints cents allows 5 cents, not 6, in both modes", () => {
      for (const [off, ok] of [[3, true], [5, true], [6, false]] as const) {
        const rb = grid(CENTS);
        rb.budgetGrids[0]!.visits[0]!.totalCents += off;
        for (const mode of MODES) expect(statusOf(solveGrids(rb, evidence(rb), { mode }).evidence, total) === "confirmed_by_math", `${off} ${mode}`).toBe(ok);
      }
    });

    it("a row and a column are additions too: 3 cents off passes on a cents grid and fails on a dollar grid", () => {
      for (const [rows, ok] of [[CENTS, true], [BIG, false]] as const) {
        const rb = grid(rows);
        const printed = pageRows(rb);
        const c = Object.keys(rb.budgetGrids[0]!.procedures[0]!.cells)[0]!;
        rb.budgetGrids[0]!.procedures[0]!.cells[c] = (rb.budgetGrids[0]!.procedures[0]!.cells[c] as number) + 3;
        // the page's row total and subtotal are the true ones: the read's cell is 3 cents off both
        const r = solveGrids(rb, evidence(rb), { rows: printed });
        expect(r.report.identities.row.failed === 0).toBe(ok);
        expect(r.report.identities.column.failed === 0).toBe(ok);
      }
    });

    it("a row's tolerance follows the page's printed totals, so a misread cell with stray cents can't loosen it", () => {
      const rb = grid(FLAT); // a small grid: one stray figure would read as a cents grid by its own values
      const printed = pageRows(rb);
      rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 30003;
      expect(solveGrids(rb, evidence(rb), { rows: printed }).report.identities.row.failed).toBe(1);
    });

    it("one grid may print cents where another prints dollars: each has its own addition tolerance", () => {
      const rb = grid(BIG);
      const second = structuredClone(grid(CENTS).budgetGrids[0]!);
      second.id = "g2";
      rb.budgetGrids.push(second);
      rb.budgetGrids[0]!.visits[0]!.totalCents += 3;
      rb.budgetGrids[1]!.visits[0]!.totalCents += 3;
      const r = solveGrids(rb, []);
      expect(r.report.failures.filter((f) => f.identity === "visitTotal").map((f) => f.paths[0]!.split("/")[2])).toEqual(["0"]);
      expect(r.report.identities.visitTotal).toEqual({ checked: 4, passed: 3, failed: 1 });
    });

    it("a figure the integer-cent model holds rounded (a printed raw float) makes its grid a cents grid: 5 cents", () => {
      // 14.2666667 per visit is held as 14.27: the sums drift by a cent or two, and the grid has cents, so it keeps 5 cents
      const rb = grid([{ unit: 1427, cells: { V1: 1427, V2: 1427 } }, { unit: 20000, cells: { V1: 20000, V2: 20000 } }]);
      rb.budgetGrids[0]!.visits[0]!.totalCents += 2;
      expect(statusOf(solveGrids(rb, evidence(rb)).evidence, total)).toBe("confirmed_by_math");
    });

    it("one misread figure with stray cents among many whole-dollar ones doesn't loosen the grid", () => {
      const rb = grid(BIG);
      rb.budgetGrids[0]!.procedures[0]!.cells.V2 = 10003; // one stray figure in 45: under one in twenty
      // the page's subtotal is whole dollars, so the column is 3 cents off
      rb.budgetGrids[0]!.visits[1]!.procedureSubtotalCents = rb.budgetGrids[0]!.procedures.reduce((a, p) => a + (p.cells.V2 as number), 0) - 3;
      const { report } = solveGrids(rb, []);
      expect(report.identities.column.failed).toBe(1);
    });

    it("overhead on a visit is a multiplication: 5 cents where the overhead column prints cents, a dollar where it prints dollars", () => {
      // 40% of V1's 600.00 is 240.00
      const set = (rb: Rulebook, v1: number, v2 = 24000) => {
        rb.budgetGrids[0]!.visits[0]!.overheadCents = v1;
        rb.budgetGrids[0]!.visits[1]!.overheadCents = v2;
        return solveGrids(rb, []).report.identities.overhead;
      };
      // whole dollars: 241.00 is within a dollar of 240.00, 242.00 is not
      expect(set(grid(FLAT), 24100).failed).toBe(0);
      expect(set(grid(FLAT), 23900).failed).toBe(0);
      expect(set(grid(FLAT), 24200).failed).toBe(1);
      // cents (both overhead figures have cents): 240.03 passes, 240.08 does not
      expect(set(grid(FLAT), 24003, 24001).failed).toBe(0);
      expect(set(grid(FLAT), 24008, 24001).failed).toBe(1);
    });

    it("a whole-dollar overhead column is compared after rounding the expected figure to the dollar", () => {
      // 40% of 125.50 is 50.20: printed as 50 (rounds to 50.00), and 51 is a dollar off
      const rb = grid([{ unit: 12550, cells: { V1: 12550, V2: 12550 } }]);
      const g = rb.budgetGrids[0]!;
      g.visits.forEach((v) => (v.overheadCents = 5000));
      expect(solveGrids(rb, []).report.identities.overhead.failed).toBe(0);
      g.visits.forEach((v) => (v.overheadCents = 5100));
      expect(solveGrids(rb, []).report.identities.overhead.failed).toBe(0); // 51.00 against 50.00: exactly a dollar
      g.visits.forEach((v) => (v.overheadCents = 5200));
      expect(solveGrids(rb, []).report.identities.overhead.failed).toBe(2);
    });
  });

  it("a clean-price conflict stays a conflict in both modes; one printed as something unreadable is overridden", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    const clean = evidence(rb, "conflict", "$300.00");
    const unreadable = evidence(rb, "conflict", "3O0.0");
    // a read that copies one price into every cell would balance its row against itself: what the page prints as a whole price wins
    for (const mode of MODES) {
      const r = solveGrids(rb, clean, { mode, rows });
      expect(r.evidence, mode).toEqual(clean);
      expect(r.report.upgraded.total, mode).toBe(0);
      // text that isn't a price proves nothing against the sums
      const ug = solveGrids(rb, unreadable, { mode, rows });
      expect(ug.report.upgraded.conflict, mode).toBe(unreadable.length - 3);
    }
  });

  it("never touches confirmed, attested or held entries, and counts the held ones that would have passed", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    const ev = evidence(rb);
    const heldPaths = [cell(0, "V2"), cell(1, "V1")];
    const mixed: ValueEvidence[] = ev.map((e) => (e.path === cell(0, "V1") ? { ...e, status: "attested", note: "typed" } : heldPaths.includes(e.path) ? { ...e, held: "chk1" } : e));
    const untouched = (e: ValueEvidence) => e.path === cell(0, "V1") || heldPaths.includes(e.path) || e.path.endsWith("/unitCents");
    for (const mode of MODES) {
      const { evidence: out, report } = solveGrids(rb, mixed, { mode, rows });
      expect(out.filter(untouched)).toEqual(mixed.filter(untouched));
      expect(report.heldWouldPass).toBe(2);
      expect(report.upgraded.total).toBe(ev.length - 3 - 3); // not the confirmed unit prices, the attested cell, the two held
      expect(out.filter((e) => !untouched(e)).every((e) => e.status === "confirmed_by_math")).toBe(true);
    }
    // a failing identity: the held cell wouldn't pass, so it isn't counted
    const bad = structuredClone(rb);
    bad.budgetGrids[0]!.procedures[0]!.cells.V1 = 31000;
    const held = evidence(bad).map((e) => (e.path === cell(0, "V1") ? { ...e, held: "chk1" } : e));
    expect(solveGrids(bad, held, { mode: "strict", rows }).report.heldWouldPass).toBe(0);
  });

  it("leaves every other field of an upgraded entry as it was, and never mutates its input", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    const box = { documentId: "d1", page: 3, box: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number] };
    const ev: ValueEvidence[] = evidence(rb).map((e) => ({ ...e, status: "conflict", where: [box], printed: "300.00x", note: "n" }));
    const rbBefore = JSON.stringify(rb);
    const evBefore = JSON.stringify(ev);
    const rowsBefore = JSON.stringify(rows);
    deepFreeze(rb);
    deepFreeze(ev);
    deepFreeze(rows);
    const { evidence: out } = solveGrids(rb, ev, { mode: "guide", rows });
    expect(JSON.stringify(rb)).toBe(rbBefore);
    expect(JSON.stringify(ev)).toBe(evBefore);
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    expect(out).not.toBe(ev);
    for (const [i, e] of out.entries()) expect({ ...e, status: "x" }).toEqual({ ...ev[i]!, status: "x" });
    // the unit prices (in no identity) stay as they were
    expect(upgradedPaths(ev, out)).toHaveLength(ev.length - 3);
  });

  it("missing totals upgrade nothing for that identity and don't crash", () => {
    const rb = grid(FLAT);
    const rows = pageRows(rb);
    const g = rb.budgetGrids[0]!;
    g.visits = g.visits.map((v) => ({ ...v, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null }));
    g.perPatientTotals = [];
    for (const mode of MODES) {
      const { evidence: out, report } = solveGrids(rb, evidence(rb), { mode, rows });
      expect(report.identities.column.checked + report.identities.visitTotal.checked + report.identities.patientTotal.checked + report.identities.overhead.checked).toBe(0);
      // the visit total has nothing to be checked against; the cells balance their rows but no column: a visit cell needs both
      expect(statusOf(out, "/budgetGrids/0/visits/0/totalCents")).toBe("ungrounded");
      expect(statusOf(out, cell(0, "V1"))).toBe("ungrounded");
    }
    const bare = grid([{ unit: null, cells: { V1: 100 } }]);
    bare.budgetGrids[0]!.visits = bare.budgetGrids[0]!.visits.map((v) => ({ ...v, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null }));
    bare.budgetGrids[0]!.perPatientTotals = [];
    expect(solveGrids(bare, evidence(bare), { rows: pageRows(bare) }).report.upgraded.total).toBe(0);
    expect(() => solveGrids(bare, [])).not.toThrow();
  });

  it("an unreferenced entry, and an entry in no identity, stays as it was", () => {
    const rb = grid(FLAT);
    const ev: ValueEvidence[] = [{ path: "/payment/netDays/value", status: "ungrounded", where: [], printed: null, note: null }];
    expect(solveGrids(rb, ev).evidence).toEqual(ev);
  });

  it("overhead identity on an invoiceable: price x (1 + rate); guide also accepts an unmarked price, strict doesn't", () => {
    const rb = grid(FLAT);
    const inv = rb.invoiceables[0]!;
    inv.amountCents = 6000;
    inv.amountWithOverheadCents = 8400; // 40%
    const paths = ["/invoiceables/0/amountCents", "/invoiceables/0/amountWithOverheadCents"];
    const ev = paths.map((path): ValueEvidence => ({ path, status: "ungrounded", where: [], printed: null, note: null }));
    for (const mode of MODES) expect(solveGrids(rb, ev, { mode }).evidence.map((e) => e.status)).toEqual(["confirmed_by_math", "confirmed_by_math"]);
    // a "$60" read as "660" breaks it
    inv.amountCents = 66000;
    expect(solveGrids(rb, ev, { mode: "guide" }).report.identities.overhead.failed).toBe(1);
    expect(solveGrids(rb, ev, { mode: "guide" }).evidence.map((e) => e.status)).toEqual(["ungrounded", "ungrounded"]);
    // "no overhead applied": the two print the same. Guide counts it as balanced, but it confirms nothing by itself
    inv.amountCents = 8400;
    expect(solveGrids(rb, ev, { mode: "guide" }).report.identities.overhead.failed).toBe(0);
    expect(solveGrids(rb, ev, { mode: "guide" }).evidence.map((e) => e.status)).toEqual(["ungrounded", "ungrounded"]);
    expect(solveGrids(rb, ev, { mode: "strict" }).evidence.map((e) => e.status)).toEqual(["ungrounded", "ungrounded"]);
    // beside a figure the page already confirmed, the other one is confirmed (guide); strict never takes the equal form
    const backed: ValueEvidence[] = [{ ...ev[0]!, status: "confirmed" }, ev[1]!];
    expect(solveGrids(rb, backed, { mode: "guide" }).evidence.map((e) => e.status)).toEqual(["confirmed", "confirmed_by_math"]);
    expect(solveGrids(rb, backed, { mode: "strict" }).evidence.map((e) => e.status)).toEqual(["confirmed", "ungrounded"]);
    const attested: ValueEvidence[] = [ev[0]!, { ...ev[1]!, status: "attested" }];
    expect(solveGrids(rb, attested, { mode: "guide" }).evidence.map((e) => e.status)).toEqual(["confirmed_by_math", "attested"]);
  });

  it("overhead on an invoiceable is a multiplication: 5 cents where the with-overhead column prints cents, a dollar where it prints dollars", () => {
    const check = (amount: number, withOverhead: number) => {
      const rb = grid(FLAT);
      rb.invoiceables[0]!.amountCents = amount;
      rb.invoiceables[0]!.amountWithOverheadCents = withOverhead;
      return solveGrids(rb, []).report.identities.overhead.failed;
    };
    // whole dollars: 60.50 x 1.4 = 84.70, which rounds to 85.00; 84.00 is a dollar away, 83.00 is two
    expect(check(6050, 8500)).toBe(0);
    expect(check(6050, 8400)).toBe(0);
    expect(check(6050, 8300)).toBe(1);
    // cents: 84.73 against 84.70 is 3 cents, 84.78 is 8
    expect(check(6050, 8473)).toBe(0);
    expect(check(6050, 8478)).toBe(1);
  });

  it("a per-patient total that leaves out one contiguous block of visits balances in the report but is never confirmed", () => {
    const rb = grid(FLAT);
    const g = rb.budgetGrids[0]!;
    const total = "/budgetGrids/0/perPatientTotals/0/cents";
    const visit = "/budgetGrids/0/visits/0/totalCents";
    g.perPatientTotals[0]!.cents = g.visits[0]!.totalCents; // "first visit only"
    for (const mode of MODES) {
      const { report, evidence: out } = solveGrids(rb, evidence(rb), { mode });
      expect(report.identities.patientTotal, mode).toEqual({ checked: 1, passed: 1, failed: 0 });
      expect(statusOf(out, total), mode).toBe("ungrounded");
      // the visit totals it names are confirmed (or not) by their own identity, never by this one
      expect(statusOf(out, visit), mode).toBe("confirmed_by_math");
    }
    // only the sum of every visit confirms it
    g.perPatientTotals[0]!.cents = g.visits.reduce((a, v) => a + v.totalCents, 0);
    for (const mode of MODES) expect(statusOf(solveGrids(rb, evidence(rb), { mode }).evidence, total), mode).toBe("confirmed_by_math");
    g.perPatientTotals[0]!.cents += 12345;
    expect(solveGrids(rb, evidence(rb)).report.identities.patientTotal.failed).toBe(1);
  });

  describe("vouched: a column that adds up to a subtotal the page itself confirms", () => {
    const v0 = "/budgetGrids/0/visits/0";
    const confirmSubtotals = (ev: ValueEvidence[]) => ev.map((e): ValueEvidence => (/\/(procedureSubtotalCents|nonProcedureCents)$/.test(e.path) ? { ...e, status: "confirmed" } : e));

    it("lists the visits whose column balances against confirmed subtotals", () => {
      const rb = grid(FLAT);
      expect(solveGrids(rb, confirmSubtotals(evidence(rb))).report.vouched).toEqual([v0, "/budgetGrids/0/visits/1"]);
    });

    it("not when the subtotal is only the read's (nothing outside the read backs it), or when the column doesn't balance", () => {
      const rb = grid(FLAT);
      expect(solveGrids(rb, evidence(rb)).report.vouched).toEqual([]);
      rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 31000;
      expect(solveGrids(rb, confirmSubtotals(evidence(rb))).report.vouched).toEqual(["/budgetGrids/0/visits/1"]);
    });

    it("not when the visit prints no subtotal", () => {
      const rb = grid(FLAT);
      rb.budgetGrids[0]!.visits.forEach((v) => (v.procedureSubtotalCents = null));
      expect(solveGrids(rb, confirmSubtotals(evidence(rb))).report.vouched).toEqual([]);
    });
  });
});

function deepFreeze(o: unknown): void {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
}

describe("senior engineer's round 3: rows with no printed total, cells outside a total's reach, a failing column", () => {
  /** Bands with ink in every cell (or none, for `blank`), no printed total; `covers` for the rows that have one. */
  const bands = (rb: Rulebook, o: { blank?: string; total?: boolean; covers?: string[] } = {}): RowBand[] =>
    rb.budgetGrids.flatMap((g, gi) =>
      g.procedures.map((p, pi): RowBand => ({
        grid: gi, procedure: pi, documentId: "d1", page: 1, box: [0, 0.1 * pi, 1, 0.1],
        cells: Object.keys(p.cells).map((visit) => ({ visit, box: [0, 0, 0.1, 0.1], ink: visit !== o.blank })),
        total: o.total ? Object.values(p.cells).reduce<number>((a, c) => a + (typeof c === "number" ? c : 0), 0) : null,
        by: o.total ? "row_total" : null,
        covers: o.covers ?? null,
      })),
    );
  const backedEv = (rb: Rulebook) => evidence(rb, "ungrounded").map((e): ValueEvidence => (/\/(unitCents|procedureSubtotalCents|nonProcedureCents)$/.test(e.path) ? { ...e, status: "confirmed" } : e));

  it("no printed total: a cell equal to the backed unit price, on ink, in a column that adds up to a backed subtotal, is confirmed", () => {
    const rb = grid(FLAT);
    const out = solveGrids(rb, backedEv(rb), { mode: "strict", rows: bands(rb) }).evidence;
    expect(statusOf(out, cell(0, "V1"))).toBe("confirmed_by_math");
    expect(statusOf(out, cell(2, "V2"))).toBe("confirmed_by_math");
  });

  it("a cell the scan prints nothing in, or whose column no backed subtotal vouches for, is not", () => {
    const rb = grid(FLAT);
    expect(statusOf(solveGrids(rb, backedEv(rb), { mode: "strict", rows: bands(rb, { blank: "V1" }) }).evidence, cell(0, "V1"))).toBe("ungrounded");
    const unbacked = evidence(rb, "ungrounded", null, "confirmed");
    expect(statusOf(solveGrids(rb, unbacked, { mode: "strict", rows: bands(rb) }).evidence, cell(0, "V1"))).toBe("ungrounded");
  });

  it("a row's total covers only the visits left of its column: cells right of it are checked by unit price and ink", () => {
    const rb = grid(FLAT);
    const rows = bands(rb, { total: true, covers: ["V1"] }).map((r) => ({ ...r, total: r.procedure === 0 ? 30000 : r.total }));
    const { report } = solveGrids(rb, backedEv(rb), { mode: "strict", rows });
    // the printed total of row 0 is its V1 cell only; its V2 cell is outside it, and rowUnit takes it
    expect(report.identities.rowUnit.checked).toBe(3);
    expect(report.identities.rowUnit.passed).toBe(3);
  });

  it("a cell the binder confirmed from its row's line alone is taken back when its column fails against a backed subtotal; a placed cell is not", () => {
    const rb = grid(FLAT);
    rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 31000;
    const ev = evidence(rb, "confirmed").map((e) => ({ ...e, where: [{ documentId: "d1", page: 1, box: null }] }));
    const scanPages = new Set(["d1#1"]);
    const loose = solveGrids(rb, ev, { mode: "strict", rows: [], scanPages });
    expect(statusOf(loose.evidence, cell(0, "V1"))).toBe("ungrounded");
    expect(loose.report.vetoed).toBeGreaterThan(0);
    // placed in a drawn table by its own spot: its visit is read from the page, so the column's sum is no veto
    const placed = solveGrids(rb, ev, { mode: "strict", rows: bands(rb), scanPages });
    expect(statusOf(placed.evidence, cell(0, "V1"))).toBe("confirmed");
    // a text PDF's column that doesn't add up is the contract's own defect, asked once as a finding: no veto
    expect(statusOf(solveGrids(rb, ev, { mode: "strict", rows: [] }).evidence, cell(0, "V1"))).toBe("confirmed");
  });
});
