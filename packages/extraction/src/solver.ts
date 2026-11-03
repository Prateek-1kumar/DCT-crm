import { parseCents, type BudgetGrid, type Rulebook, type ValueEvidence } from "@dct/shared";
import type { RowBand } from "./binder";
import { multiPatientTotals } from "./checks";

/**
 * The guide's algebraic accounting solver (ADR-002 §1.2) over our rulebook. Pure: no I/O, no AI, never mutates its input,
 * never prints, and the report holds JSON pointers and counts, never contract text.
 *
 * Which of the guide's identities our model can hold:
 *  - overhead: an invoiceable's amount x (1 + rate) = its amount with overhead; a visit's overhead = rate x the cells of the
 *    rows that carry overhead. (A procedure row has no "price with overhead" field here.)
 *  - row: the read's cells of a row add up to what the PAGE prints for that row's total: a total column right of the visits, or
 *    a printed unit price times a printed quantity (`RowBand.total`, found by the binder in the table's own geometry). The
 *    model has no row-total or quantity field, so the printed figure is compared, never the model's own sum or unit price:
 *    unit x count = the model's own cells is a tautology on a flat price, and is not an identity. A table that prints neither
 *    has no row identity, and then no visit cell of it is ever confirmed by math (a column sum alone can't say which row a
 *    number belongs to); visit-level values still can be.
 *  - column: a visit's priced cells sum to its subtotal + non-procedure amount (checks.ts's own definition).
 *  - visitTotal: subtotal + overhead + non-procedure = total.
 *  - patientTotal: a per-patient total = the visit totals, or all of them but one contiguous block (checks.ts's heuristic).
 * Not held: guide Check 5 (summary table == detail grid): the master has one grid per table, so there are no two to compare.
 *
 * Tolerance depends on the operation and on what the figures print (the senior engineer's decision):
 *  - addition and subtraction (row, column, visitTotal, patientTotal): 0 cents on a grid whose figures are whole dollars, 5
 *    cents on one that prints cents (each figure was rounded to a cent on its own, so a sum drifts);
 *  - multiplication (overhead): 5 cents when the target column prints cents; when it prints whole dollars, the expected figure
 *    rounded to a whole dollar may differ from the printed one by a dollar.
 * "Prints cents" is read from the grid's own values (`printsCents`: more than one figure in twenty is not a whole number of
 * dollars), grid by grid for addition (a row identity reads it from the page's printed row totals instead, which no misread
 * cell can move) and column by column for overhead. A printed figure with more than two decimals (a raw
 * unrounded float) can't be held in integer cents: the read holds it rounded, so its grid reads as a cents grid and keeps the
 * 5 cents.
 */

export type SolverMode = "guide" | "strict";
export type IdentityKind = "overhead" | "row" | "rowUnit" | "column" | "visitTotal" | "patientTotal";
type Tally = { checked: number; passed: number; failed: number };
export type SolverOptions = {
  mode?: SolverMode;
  /** The table rows the binder found, with what the page prints as each one's total (`bindEvidence(...).rows`). None: no row identity. */
  rows?: readonly RowBand[];
  /**
   * Rounding-aware addition (off by default, awaiting the senior engineer's word): a grid whose visit totals print in whole dollars
   * over parts that print cents. A visit total may then differ from its parts by under a dollar, and a per-patient total from the
   * visit totals by half a dollar for each visit (each was rounded on its own). Beyond the 0 / 5 cents his tolerance rule gives.
   */
  rounding?: boolean;
  /**
   * The pages (`documentId#page`) that are our OCR's reading of a scan. A confirmed cell is taken back for a failing column only
   * there: a scan is where a row's line can't say which visit a number is in, and where a column defect is most likely a misread.
   * A text PDF's column that doesn't add up is the contract's own arithmetic defect, asked once as a finding. Absent: no veto.
   */
  scanPages?: ReadonlySet<string>;
};
export type SolverReport = {
  mode: SolverMode;
  identities: Record<IdentityKind, Tally>;
  /** Cells upgraded to confirmed_by_math, and the status each had. */
  upgraded: { total: number; ungrounded: number; conflict: number };
  /** One entry per identity that didn't balance: the values it takes in, so a later step can ask once per row or column. */
  failures: { identity: IdentityKind; paths: string[] }[];
  /** Cells the binder had confirmed from their row's line alone, taken back because the visit column they sit in no longer adds up to the page's own subtotal. */
  vetoed: number;
  /** Held cells (waiting for a table check) that would have been upgraded: never touched, counted for the owner. */
  heldWouldPass: number;
  /** Visits (`/budgetGrids/g/visits/v`) whose column adds up to a printed subtotal the page itself confirms: the sweep's proof that no price is missing from that column. */
  vouched: string[];
};

// A row identity sees across a visit grid; a column identity down one. An item (an invoiceable) has neither.
type Orient = "row" | "col" | "item";
/**
 * `balanced`: the sums agree (what the report counts). `confirms`: it may also upgrade the values it holds. A per-patient
 * total that balances only on a subset of the visits (a heuristic that exists to avoid raising a flag) never confirms, and
 * neither does an invoiceable's "no overhead applied" (price with overhead equals price) unless a figure of it is backed.
 */
type Identity = { kind: IdentityKind; orient: Orient; paths: string[]; balanced: boolean; confirms: boolean };

const ADD_CENTS = 5;
const MUL_CENTS = 5;
const MUL_DOLLAR = 100;
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isCellPath = (p: string) => /\/procedures\/\d+\/cells\//.test(p);

/**
 * Whether figures print cents: more than one in twenty is not a whole number of dollars. A share rather than "any", so one
 * misread figure with stray cents doesn't loosen a grid of whole dollars; a stray one in a small column does, and then only to
 * a few cents. No figures: whole.
 */
const printsCents = (xs: number[]) => xs.filter((x) => x % 100 !== 0).length * 20 > xs.length;
/** To the nearest whole dollar, half up, in integer cents. */
const wholeDollar = (c: number) => Math.sign(c) * Math.floor((Math.abs(c) + 50) / 100) * 100;
/** A multiplication's result against the printed figure: to the cent-ish where the target prints cents, to the dollar where it prints dollars. */
const mulOk = (expected: number, printed: number, cents: boolean) => (cents ? Math.abs(expected - printed) <= MUL_CENTS : Math.abs(wholeDollar(expected) - printed) <= MUL_DOLLAR);

/**
 * rate% of an amount in whole cents, half up, in integers: the rate is taken to hundredths of a percent (no contract prints
 * more), so no amount goes through float math.
 */
function pctOf(cents: number, pct: number): number {
  const num = Math.abs(cents) * Math.round(pct * 100);
  const q = Math.floor(num / 10000);
  return Math.sign(cents) * (q + (2 * (num - q * 10000) >= 10000 ? 1 : 0));
}

/** Whether the per-patient total is the sum of the visit totals, or of all but one contiguous block; the visits it counts, else null. */
function patientVisits(totals: number[], printed: number, tol: number): number[] | null {
  const all = totals.map((_, i) => i);
  if (Math.abs(sum(totals) - printed) <= tol) return all;
  // ponytail: same heuristic as checks.ts closestBlockExclusion (not exported there); can accept a total that equals some
  // block's sum by chance. Upgrade: a visit-to-total mapping in the schema.
  let best: { diff: number; keep: number[] } | null = null;
  for (let i = 0; i < totals.length; i++)
    for (let j = i; j < totals.length; j++) {
      const keep = all.filter((k) => k < i || k > j);
      const diff = Math.abs(sum(keep.map((k) => totals[k]!)) - printed);
      if (keep.length && diff <= tol && (!best || diff < best.diff)) best = { diff, keep };
    }
  return best?.keep ?? null;
}

function identitiesOf(rb: Rulebook, mode: SolverMode, rows: readonly RowBand[], backed: (path: string) => boolean, rounding = false): Identity[] {
  const out: Identity[] = [];
  const add = (kind: IdentityKind, orient: Orient, paths: string[], balanced: boolean, confirms = true) => out.push({ kind, orient, paths, balanced, confirms });
  const rbPct = rb.overhead.appliesTo.value === "none" ? null : rb.overhead.pct.value;

  // the price-with-overhead column of the contract's fee table: whole dollars or cents
  const itemCents = printsCents(rb.invoiceables.flatMap((x) => (x.amountWithOverheadCents === null ? [] : [x.amountWithOverheadCents])));
  rb.invoiceables.forEach((x, i) => {
    if (rbPct === null || x.amountCents === null || x.amountWithOverheadCents === null) return;
    const both = [`/invoiceables/${i}/amountCents`, `/invoiceables/${i}/amountWithOverheadCents`];
    const exact = mulOk(x.amountCents + pctOf(x.amountCents, rbPct), x.amountWithOverheadCents, itemCents);
    // the guide also accepts "no overhead applied" (the two equal); strict doesn't, a marked-up price must show its markup. It is
    // nobody's arithmetic, so it confirms only beside a figure that is already backed.
    const equal = mode === "guide" && x.amountCents === x.amountWithOverheadCents;
    add("overhead", "item", both, exact || equal, exact || both.some(backed));
  });

  rb.budgetGrids.forEach((g: BudgetGrid, gi) => {
    const gp = `/budgetGrids/${gi}`;
    const pct = g.statedOverheadPct ?? rbPct;
    const cellPath = (pi: number, code: string) => `${gp}/procedures/${pi}/cells/${ptr(code)}`;
    const priced = (pi: number, code: string) => {
      const c = g.procedures[pi]!.cells[code];
      return typeof c === "number" ? c : null;
    };
    // one grid may print cents where another prints dollars: the addition tolerance is this grid's
    const figures = [
      ...g.procedures.flatMap((p) => [...(p.unitCents === null ? [] : [p.unitCents]), ...Object.values(p.cells).filter((c): c is number => typeof c === "number")]),
      ...g.visits.flatMap((v) => [v.procedureSubtotalCents, v.overheadCents, v.nonProcedureCents, v.totalCents].filter((c): c is number => c !== null)),
      ...g.perPatientTotals.map((t) => t.cents),
    ];
    const addTol = printsCents(figures) ? ADD_CENTS : 0;
    const overheadCents = printsCents(g.visits.flatMap((v) => (v.overheadCents === null ? [] : [v.overheadCents])));

    // row: the read's cells against the total the page prints for the row; a table that prints none has no row identity. Whether
    // this grid's totals print cents is read from the printed totals themselves, which no misread cell of the read can move
    const mine = rows.filter((r) => r.grid === gi && r.total !== null);
    const rowTol = printsCents(mine.map((r) => r.total!)) ? ADD_CENTS : 0;
    for (const r of mine) {
      const p = g.procedures[r.procedure];
      if (!p) continue;
      const codes = Object.keys(p.cells).filter((k) => !r.covers || r.covers.includes(k));
      // an "invoiceable" cell is the unit price standing in for a word: a printed sum over it can't be checked against the read's numbers
      if (!codes.length || codes.some((k) => priced(r.procedure, k) === null)) continue;
      add("row", "row", codes.map((k) => cellPath(r.procedure, k)), Math.abs(r.total! - sum(codes.map((k) => priced(r.procedure, k)!))) <= rowTol);
    }

    // rowUnit (senior engineer, BHV3000-315): where the table prints no row total, a row's priced cells that all equal its unit
    // price (which the page backs) and that each sit on printed ink are placed: the unit price rules out a swap with a row priced
    // otherwise, the ink a cell the scan prints nothing in. It confirms a cell only beside a column that adds up to a subtotal the
    // page backs (`vouched`, in solveGrids): rows priced alike can still swap, and then the column sum is the same.
    // (and, on a row with a printed total, the cells the total leaves out: the read holds the columns right of it as visits)
    for (const r of rows.filter((x) => x.grid === gi && (x.total === null || x.covers))) {
      const p = g.procedures[r.procedure];
      if (!p || p.unitCents === null) continue;
      const codes = Object.keys(p.cells).filter((k) => priced(r.procedure, k) !== null && (r.total === null || !r.covers!.includes(k)));
      if (!codes.length) continue;
      const unit = `${gp}/procedures/${r.procedure}/unitCents`;
      if (codes.some((k) => priced(r.procedure, k) !== p.unitCents)) continue;
      add("rowUnit", "row", [unit, ...codes.map((k) => cellPath(r.procedure, k))], backed(unit) && codes.every((k) => r.cells.find((c) => c.visit === k)?.ink === true));
    }

    g.visits.forEach((v, vi) => {
      const vp = `${gp}/visits/${vi}`;
      const cells = g.procedures.flatMap((p, pi) => (priced(pi, v.code) === null ? [] : [{ pi, p, c: priced(pi, v.code)! }]));
      const hasProcedureRows = cells.some((x) => x.p.category === "procedure");
      const nonProc = v.nonProcedureCents;

      const [colCells, printed] = hasProcedureRows
        ? [cells, v.procedureSubtotalCents === null ? null : v.procedureSubtotalCents + (nonProc ?? 0)]
        : [cells.filter((x) => x.p.category === "non_procedure"), nonProc];
      if (printed !== null && colCells.length)
        add("column", "col", [...colCells.map((x) => cellPath(x.pi, v.code)), ...(hasProcedureRows ? [`${vp}/procedureSubtotalCents`] : []), ...(nonProc !== null ? [`${vp}/nonProcedureCents`] : [])], Math.abs(sum(colCells.map((x) => x.c)) - printed) <= addTol);

      const withOh = cells.filter((x) => x.p.overheadApplied);
      if (pct !== null && v.overheadCents !== null && withOh.length)
        add("overhead", "col", [`${vp}/overheadCents`, ...withOh.map((x) => cellPath(x.pi, v.code))], mulOk(pctOf(sum(withOh.map((x) => x.c)), pct), v.overheadCents, overheadCents));

      if (v.procedureSubtotalCents !== null && v.overheadCents !== null) {
        const parts = [v.procedureSubtotalCents, v.overheadCents, ...(nonProc !== null ? [nonProc] : [])];
        const tol = rounding && v.totalCents % 100 === 0 && parts.some((x) => x % 100 !== 0) ? Math.max(addTol, 99) : addTol;
        add("visitTotal", "col", [`${vp}/procedureSubtotalCents`, `${vp}/overheadCents`, `${vp}/totalCents`, ...(nonProc !== null ? [`${vp}/nonProcedureCents`] : [])], Math.abs(sum(parts) - v.totalCents) <= tol);
      }
    });

    const order = g.visits.map((v, vi) => ({ v, vi })).sort((a, b) => a.v.order - b.v.order);
    // a total for several patients a saved read still holds here is no per-patient total (multiPatientTotals): in no identity
    const several = new Set(multiPatientTotals(g).map((e) => e.index));
    g.perPatientTotals.forEach((t, ti) => {
      if (!order.length || several.has(ti)) return;
      const totals = order.map((x) => x.v.totalCents);
      // each visit total printed in whole dollars was rounded on its own: the sum can be half a dollar off per visit
      const tol = rounding && t.cents % 100 === 0 && totals.every((c) => c % 100 === 0) ? addTol + 50 * totals.length : addTol;
      const keep = patientVisits(totals, t.cents, tol);
      const used = keep ?? order.map((_, i) => i);
      const paths = [`${gp}/perPatientTotals/${ti}/cents`, ...used.map((i) => `${gp}/visits/${order[i]!.vi}/totalCents`)];
      out.push({ kind: "patientTotal", orient: "row", paths, balanced: keep !== null, confirms: keep?.length === order.length });
    });
  });
  return out;
}

/**
 * Sets `confirmed_by_math` on the entries the document's own arithmetic proves, and reports what it checked.
 *
 * A value is confirmed only when every identity it takes part in balances, and a visit cell takes part in at least one row
 * identity and one column identity: a number placed in the wrong visit still balances its row (ADR-001 §4), and a number in
 * the wrong row still balances its column, so only both together say more. The row identity is the PAGE's printed row total or
 * quantity (see the header), so where a table prints neither a visit cell is never confirmed here. Outside visit cells (unit
 * prices, totals, an invoiceable's prices) every identity must balance and at least one must exist: they have no visit, so
 * there is no wrong visit to place them in. A balanced identity overrides conflict (not one whose printed text is a clean
 * price) and ungrounded.
 *
 * `guide` differs in one thing: an invoiceable whose price with overhead equals its price ("no overhead applied") balances,
 * and confirms beside a figure that is already confirmed or attested. (It once also took a 5-cent tolerance, any one identity,
 * and a flat price filled across a row; the first is now every mode's rule where the grid prints cents, the others are gone.)
 *
 * Never downgrades confirmed or attested, never touches an entry with a `held` id (they are only counted), leaves every
 * other field as it was. A per-patient total confirms only on the sum of every visit (the "all but one block" form still
 * counts as balanced in the report, but confirms nothing).
 */
export function solveGrids(rb: Rulebook, evidence: ValueEvidence[], opts: SolverOptions = {}): { evidence: ValueEvidence[]; report: SolverReport } {
  const mode = opts.mode ?? "guide";
  const backed = new Set(evidence.filter((e) => e.status === "confirmed" || e.status === "attested").map((e) => e.path));
  const ids = identitiesOf(rb, mode, opts.rows ?? [], (p) => backed.has(p), opts.rounding);
  const identities = Object.fromEntries((["overhead", "row", "rowUnit", "column", "visitTotal", "patientTotal"] as const).map((k) => [k, { checked: 0, passed: 0, failed: 0 }])) as Record<IdentityKind, Tally>;
  const failures: SolverReport["failures"] = [];
  const byPath = new Map<string, Identity[]>();
  const fullGrids = new Set(ids.flatMap((i) => (i.kind === "patientTotal" && i.confirms ? [i.paths[0]!.match(/^\/budgetGrids\/\d+/)![0]] : [])));
  for (const id of ids) {
    const t = identities[id.kind];
    t.checked++;
    if (id.balanced) t.passed++;
    else {
      t.failed++;
      failures.push({ identity: id.kind, paths: [...id.paths] });
    }
    // a per-patient total that fails holds back the visit totals it sums (a read that shifted the totals, however consistent each visit
    // is within itself, shows there), unless the grid has another per-patient total that adds up over every visit: a total over some
    // visits only (a screen-fail path, a double-blind-only path) is then no sign that a visit total is wrong
    const spared = id.kind === "patientTotal" && !id.balanced && fullGrids.has(id.paths[0]!.match(/^\/budgetGrids\/\d+/)![0]);
    for (const p of spared ? id.paths.slice(0, 1) : id.paths) byPath.set(p, [...(byPath.get(p) ?? []), id]);
  }

  // a column that adds up to the subtotal (and non-procedure amount) the page itself has confirmed: no price is missing from it
  const vouched = ids.flatMap((id) => {
    const figs = id.paths.filter((p) => !isCellPath(p));
    return id.kind === "column" && id.balanced && figs.length && figs.every((p) => backed.has(p)) ? [figs[0]!.replace(/\/[^/]+$/, "")] : [];
  });

  const proven = (e: ValueEvidence) => {
    const mine = byPath.get(e.path) ?? [];
    if (!mine.length) return false;
    // what the page prints as a whole price is never overridden by sums: a read that copies one price into every cell of a
    // row would balance that row against itself
    if (e.status === "conflict" && e.printed !== null && parseCents(e.printed) !== null) return false;
    const usable = mine.filter((i) => i.balanced && i.confirms);
    if (!(mine.every((i) => i.balanced) && usable.length > 0)) return false;
    if (!isCellPath(e.path)) return true;
    if (!(usable.some((i) => i.orient === "row") && usable.some((i) => i.orient === "col"))) return false;
    // a row with no printed total is placed by its unit price and ink alone: the column must add up to a subtotal the page backs
    return usable.some((i) => i.orient === "row" && i.kind !== "rowUnit") || vouchedCell(e.path);
  };
  const vouchedSet = new Set(vouched);
  const vouchedCell = (path: string) => {
    const m = /^\/budgetGrids\/(\d+)\/procedures\/\d+\/cells\/(.+)$/.exec(path);
    const vi = m ? rb.budgetGrids[Number(m[1])]?.visits.findIndex((v) => ptr(v.code) === m[2]) ?? -1 : -1;
    return vi >= 0 && vouchedSet.has(`/budgetGrids/${m![1]}/visits/${vi}`);
  };

  // a cell is no better than the column it sits in: the binder may have confirmed it from its row's line alone (no table geometry, so
  // no visit), and if the visit's column then fails to add up to a subtotal the page backs, the cell may be in the wrong visit. Cells
  // the binder placed in a drawn table by their own spot are exempt: their visit is read from the page.
  const placed = new Set((opts.rows ?? []).flatMap((r) => Object.keys(rb.budgetGrids[r.grid]?.procedures[r.procedure]?.cells ?? {}).map((k) => `/budgetGrids/${r.grid}/procedures/${r.procedure}/cells/${ptr(k)}`)));
  const broken = new Set(
    ids.flatMap((id) => (id.kind === "column" && !id.balanced && id.paths.filter((p) => !isCellPath(p)).every((p) => backed.has(p)) ? id.paths.filter(isCellPath) : [])),
  );
  let vetoed = 0;

  const upgraded = { total: 0, ungrounded: 0, conflict: 0 };
  let heldWouldPass = 0;
  const next = evidence.map((e) => {
    if (e.status === "confirmed" && broken.has(e.path) && !placed.has(e.path) && e.held === undefined && e.where.some((w) => opts.scanPages?.has(`${w.documentId}#${w.page}`))) {
      vetoed++;
      return { ...e, status: "ungrounded" as const, note: "its visit's column doesn't add up to the page's subtotal" };
    }
    if ((e.status !== "conflict" && e.status !== "ungrounded") || !proven(e)) return e;
    if (e.held !== undefined) {
      heldWouldPass++;
      return e;
    }
    upgraded.total++;
    upgraded[e.status]++;
    return { ...e, status: "confirmed_by_math" as const };
  });
  return { evidence: next, report: { mode, identities, upgraded, failures, vetoed, heldWouldPass, vouched: [...new Set(vouched)] } };
}
