import type { BudgetGrid, ContractAnomaly, Rulebook } from "@dct/shared";
import { z } from "zod";
import { norm, sameName, sharesWord } from "./checks";

/**
 * Hand-checked expected values for one contract (data/golden/<name>.json, never committed).
 * A field left undefined is not scored; null means "the contract does not state it".
 */
export const Golden = z.object({
  name: z.string(),
  file: z.string(),
  study: z.object({
    sponsor: z.string().nullable(),
    payingAgent: z.string().nullable().optional(),
    protocol: z.string().nullable(),
    siteName: z.string().nullable(),
    investigator: z.string().nullable(),
    effectiveDate: z.string().nullable(),
  }),
  overheadPct: z.number().nullable().optional(),
  holdbackPct: z.number().nullable().optional(),
  netDays: z.number().nullable().optional(),
  rounding: z.enum(["printed_amounts", "cents", "unspecified"]).optional(),
  appliesFrom: z.string().nullable().optional(),
  grids: z.array(
    z.object({
      label: z.string(),
      visitTotals: z.array(z.number().int()),
      perPatient: z.array(z.number().int()),
      /** Every grid row, cells in visit order (null = empty), e.g. from the sponsor's spreadsheet (scripts/golden-grid-from-xlsx.py). */
      rows: z.array(z.object({ code: z.string().nullable(), name: z.string(), unitCents: z.number().int().nullable(), cells: z.array(z.number().int().nullable()) })).optional(),
    }),
  ),
  procedures: z.array(z.object({ code: z.string().nullable(), name: z.string(), unitCents: z.number().int() })).default([]),
  /** Invoiceables and site fees together (contracts file the same item under either heading). */
  items: z.array(z.object({ code: z.string().nullable(), name: z.string(), cents: z.number().int(), withOverheadCents: z.number().int().optional() })),
  screenFail: z
    .object({
      cents: z.number().int().nullable(),
      basis: z.enum(["fixed", "per_procedure"]).optional(),
      capKind: z.string(),
      n: z.number().nullable(),
      ratio: z.number().nullable(),
    })
    .nullable()
    .optional(),
  deadlines: z.array(z.object({ kind: z.string(), value: z.number().int() })),
  overpayment: z.object({ refundDays: z.number().int().nullable(), sponsorMayOffset: z.boolean() }).optional(),
  /** Codes that must appear; "A|B" accepts either. */
  expectedAnomalies: z.array(z.string()),
});
export type Golden = z.infer<typeof Golden>;

type Category = { name: string; hit: number; total: number };
export type Score = { name: string; pct: number; categories: Category[]; misses: string[] };

export function scoreExtraction(rb: Rulebook, anomalies: Pick<ContractAnomaly, "code">[], golden: Golden): Score {
  const cats = new Map<string, Category>();
  const misses: string[] = [];
  const check = (cat: string, ok: boolean, what: string) => {
    const c = cats.get(cat) ?? { name: cat, hit: 0, total: 0 };
    c.total++;
    if (ok) c.hit++;
    else misses.push(`${cat}: ${what}`);
    cats.set(cat, c);
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // study
  const st = rb.study;
  for (const f of ["sponsor", "protocol", "siteName", "investigator"] as const) {
    const g = golden.study[f];
    if (g !== null) check("study", !!st[f].value && sameName(st[f].value, g) && sameName(g, st[f].value), `${f} expected "${g}", got "${st[f].value}"`);
  }
  if (golden.study.payingAgent !== undefined) {
    const g = golden.study.payingAgent;
    const v = st.payingAgent.value;
    check("study", g === null ? v === null : !!v && sameName(v, g), `payingAgent expected ${JSON.stringify(g)}, got ${JSON.stringify(v)}`);
  }
  if (golden.study.effectiveDate !== null) check("study", st.effectiveDate.value === golden.study.effectiveDate, `effectiveDate expected ${golden.study.effectiveDate}, got ${st.effectiveDate.value}`);

  // rules
  const rules: [string, unknown, unknown][] = [
    ["overhead %", golden.overheadPct, rb.overhead.pct.value],
    ["holdback %", golden.holdbackPct, rb.holdback?.pct ?? null],
    ["net days", golden.netDays, rb.payment.netDays.value],
    ["rounding", golden.rounding, rb.rounding.value],
    ["applies from", golden.appliesFrom, rb.appliesFrom.value],
  ];
  for (const [what, g, v] of rules) if (g !== undefined) check("rules", eq(g, v), `${what} expected ${JSON.stringify(g)}, got ${JSON.stringify(v)}`);
  for (const d of golden.deadlines) {
    const got = rb.deadlines.filter((x) => x.kind === d.kind).map((x) => x.value);
    check("rules", got.includes(d.value), `deadline ${d.kind} expected ${d.value}, got ${JSON.stringify(got)}`);
  }
  if (golden.overpayment) {
    check("rules", rb.overpayment?.refundDays === golden.overpayment.refundDays, `overpayment refundDays expected ${golden.overpayment.refundDays}, got ${rb.overpayment?.refundDays}`);
    check("rules", rb.overpayment?.sponsorMayOffset === golden.overpayment.sponsorMayOffset, `overpayment offset expected ${golden.overpayment.sponsorMayOffset}`);
  }
  if (golden.screenFail !== undefined) {
    const g = golden.screenFail;
    const sf = rb.screenFail;
    if (g === null) check("screen fail", sf === null, "expected no screen-fail terms");
    else {
      check("screen fail", sf?.amountCents === g.cents, `amount expected ${g.cents}, got ${sf?.amountCents}`);
      if (g.basis) check("screen fail", sf?.basis === g.basis, `basis expected ${g.basis}, got ${sf?.basis}`);
      check("screen fail", sf?.cap.kind === g.capKind, `cap kind expected ${g.capKind}, got ${sf?.cap.kind}`);
      if (g.n !== null) check("screen fail", sf?.cap.n === g.n, `cap n expected ${g.n}, got ${sf?.cap.n}`);
      if (g.ratio !== null) check("screen fail", sf?.cap.ratio === g.ratio, `cap ratio expected ${g.ratio}, got ${sf?.cap.ratio}`);
    }
  }

  // grids: match each golden grid to the extracted grid sharing the most visit totals.
  const free = new Set(rb.budgetGrids.map((_, i) => i));
  for (const g of golden.grids) {
    let best: BudgetGrid | null = null;
    let bestScore = -1;
    for (const i of free) {
      const cand = rb.budgetGrids[i]!;
      const s = multisetHits(g.visitTotals, cand.visits.map((v) => v.totalCents)) + g.perPatient.filter((p) => cand.perPatientTotals.some((t) => t.cents === p)).length;
      if (s > bestScore) [best, bestScore] = [cand, s];
    }
    if (best) free.delete(rb.budgetGrids.indexOf(best));
    const remaining = best ? best.visits.map((v) => v.totalCents) : [];
    for (const t of g.visitTotals) {
      const i = remaining.indexOf(t);
      if (i >= 0) remaining.splice(i, 1);
      check("visit totals", i >= 0, `${g.label}: visit total ${t} not found`);
    }
    for (const p of g.perPatient) check("per-patient totals", !!best?.perPatientTotals.some((t) => t.cents === p), `${g.label}: per-patient total ${p} not found`);
    if (g.rows) scoreRows(g.rows, best, (ok, what) => check("grid rows", ok, `${g.label}: ${what}`));
  }

  const procs = rb.budgetGrids.flatMap((g) => g.procedures);
  for (const p of golden.procedures) {
    const ok = procs.some((x) => x.unitCents === p.unitCents && (p.code ? !!x.code && norm(x.code) === norm(p.code) : sharesWord(x.name, p.name)));
    check("procedures", ok, `${p.code ?? ""} ${p.name} unit ${p.unitCents} not found`);
  }

  const items = [
    ...rb.invoiceables.map((x) => ({ code: x.code, name: x.name, amounts: [x.amountCents, x.amountWithOverheadCents], oh: x.amountWithOverheadCents })),
    ...rb.siteFees.map((x) => ({ code: x.code, name: x.name, amounts: [x.amountCents], oh: null as number | null })),
  ];
  for (const it of golden.items) {
    const named = items.filter((x) => (it.code && x.code && norm(x.code) === norm(it.code)) || sharesWord(x.name, it.name) || norm(x.name) === norm(it.name));
    check("invoiceables & fees", named.some((x) => x.amounts.includes(it.cents)), `${it.code ?? ""} ${it.name} ${it.cents} not found`);
    if (it.withOverheadCents !== undefined) check("invoiceables & fees", named.some((x) => x.oh === it.withOverheadCents), `${it.code ?? ""} ${it.name} with overhead ${it.withOverheadCents} not found`);
  }

  const codes = new Set(anomalies.map((a) => a.code));
  for (const e of golden.expectedAnomalies) check("anomalies", e.split("|").some((c) => codes.has(c as ContractAnomaly["code"])), `${e} not raised`);

  const categories = [...cats.values()];
  const hit = categories.reduce((a, c) => a + c.hit, 0);
  const total = categories.reduce((a, c) => a + c.total, 0);
  return { name: golden.name, pct: total ? Math.round((1000 * hit) / total) / 10 : 100, categories, misses };
}

type GoldenRow = NonNullable<Golden["grids"][number]["rows"]>[number];

/**
 * One check per golden row: unit price and every visit cell (by visit order) exactly right, nothing extra.
 * Each row is paired with the unused extracted row of the same code that matches it best (codes repeat: 99000 ×7).
 */
function scoreRows(rows: GoldenRow[], grid: BudgetGrid | null, check: (ok: boolean, what: string) => void) {
  const codes = grid ? [...grid.visits].sort((a, b) => a.order - b.order).map((v) => v.code) : [];
  const vector = (p: BudgetGrid["procedures"][number]) => codes.map((c) => p.cells[c] ?? null);
  const unused = new Set(grid?.procedures ?? []);
  for (const r of rows) {
    const label = `${r.code ?? ""} ${r.name.slice(0, 40)}`.trim();
    const candidates = [...unused].filter((p) => (r.code ? !!p.code && norm(p.code) === norm(r.code) : sharesWord(p.name, r.name)));
    const hits = (p: BudgetGrid["procedures"][number]) => vector(p).filter((c, i) => c === r.cells[i]).length + (sharesWord(p.name, r.name) ? 0.5 : 0);
    const best = candidates.sort((a, b) => hits(b) - hits(a))[0];
    if (!best) {
      check(false, `row ${label} not found`);
      continue;
    }
    unused.delete(best);
    const got = vector(best);
    const wrong = r.cells.flatMap((c, i) => (got[i] === c ? [] : [`${codes[i] ?? `visit ${i + 1}`} ${c ?? "empty"}→${got[i] ?? "empty"}`]));
    if (codes.length !== r.cells.length) wrong.unshift(`${codes.length} visits, expected ${r.cells.length}`);
    if (r.unitCents !== null && best.unitCents !== r.unitCents) wrong.unshift(`unit ${r.unitCents}→${best.unitCents}`);
    check(!wrong.length, `row ${label}: ${wrong.slice(0, 4).join(", ")}${wrong.length > 4 ? `, … (${wrong.length})` : ""}`);
  }
}

function multisetHits(want: number[], have: number[]): number {
  const pool = [...have];
  let n = 0;
  for (const w of want) {
    const i = pool.indexOf(w);
    if (i >= 0) {
      pool.splice(i, 1);
      n++;
    }
  }
  return n;
}
