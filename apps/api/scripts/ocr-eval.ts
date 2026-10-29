/**
 * pnpm --filter @dct/api ocr-eval    the scan gate (ADR-001 addendum 2026-10-29), no AI calls
 *
 * Binds the saved reads of the 4 scanned contracts (data/extractions) to our own OCR of their pages and scores the
 * result against the answer keys (data/golden):
 * - wrong confirmed: a value the key pins down, confirmed, but not the key's value. The gate: 0.
 * - planted errors: every confirmed value changed by one digit (random, and a look-alike digit), and every grid row
 *   shifted one visit over; each must come out unconfirmed. The gate: all caught.
 * - questions per contract, today (no OCR) and with OCR, by reason.
 *
 * OCR comes from OCR_DIR: <contract>.jsonl, one line per page image the worker read ({path, ms, words}; the image is
 * "<page>.png", or "<page>r.png" turned 90° clockwise). Repo root = DCT_ROOT, else three levels above this file.
 * Prints counts only; never contract text or amounts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindEvidence, norm, ocrPage, type OcrWord, readTextLayer, reviewFromEvidence, runContractChecks, sameName, sharesWord, type TextPage } from "@dct/extraction";
import { Rulebook, type ValueEvidence } from "@dct/shared";
import { reviewDraft } from "../src/review.js";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ocrDir = process.env.OCR_DIR;
if (!ocrDir) throw new Error("Set OCR_DIR to the folder of OCR readings (<contract>.jsonl)");
const CONTRACTS = { copd: "COPD", hcwc: "HCWC", mcallen: "McAllen", shah: "Shah" } as const;
const port = { bindEvidence, reviewFromEvidence };

const keys = (path: string) => path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
const ptr = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const get = (o: unknown, path: string) => keys(path).reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
const set = (o: unknown, path: string, v: unknown) => {
  const ks = keys(path);
  (ks.slice(0, -1).reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o) as Record<string, unknown>)[ks.at(-1)!] = v;
};
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const isCents = (rb: Rulebook, p: string) => /Cents$|\/cents$|\/cells\//.test(p) || (p.endsWith("/cap/n") && get(rb, p.replace(/\/n$/, "/kind")) === "amount");

/** The OCR'd pages: per page the reading with more confident words, when the worker read it both ways. */
function ocrPages(name: string, scan: TextPage[]): { pages: TextPage[]; ms: number[] } {
  type Line = { path: string; ms: number; words: OcrWord[]; dpi?: number };
  const all = readFileSync(join(ocrDir!, `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Line);
  const good = (o: Line) => o.words.filter((w) => w.conf >= 0.8).length;
  const best = new Map<number, Line>();
  for (const o of all) {
    const n = Number(/(\d+)r?\.png$/.exec(o.path)![1]);
    if (!best.has(n) || good(o) > good(best.get(n)!)) best.set(n, o);
  }
  const pages = scan.map((p) => {
    const o = best.get(p.page);
    return o ? ocrPage(p, { words: o.words, dpi: o.dpi ?? 300, turned: /r\.png$/.test(o.path) ? 90 : 0 }) : p;
  });
  return { pages, ms: all.map((o) => o.ms) };
}

type Golden = {
  grids: { visitTotals: number[]; perPatient: number[]; rows?: { code: string | null; name: string; cells: (number | null)[]; unitCents: number | null }[] }[];
  items: { code?: string | null; name: string; cents: number; withOverheadCents?: number }[];
  study: { effectiveDate: string | null };
  overheadPct?: number | null;
  holdbackPct?: number | null;
  netDays?: number | null;
  overpayment?: { refundDays?: number | null } | null;
  screenFail?: { cents: number | null; n: number | null } | null;
  deadlines: { kind: string; value: number }[];
};

/** path → the answer key's value, wherever the key pins one down. */
function keyed(rb: Rulebook, g: Golden): Map<string, number | string> {
  const out = new Map<string, number | string>();
  const free = new Set(rb.budgetGrids.map((_, i) => i));
  for (const kg of g.grids) {
    const hits = (gi: number) => {
      const pool = rb.budgetGrids[gi]!.visits.map((v) => v.totalCents);
      return kg.visitTotals.filter((t) => {
        const i = pool.indexOf(t);
        return i >= 0 && pool.splice(i, 1);
      }).length;
    };
    const gi = [...free].sort((a, b) => hits(b) - hits(a))[0];
    if (gi === undefined) continue;
    free.delete(gi);
    const grid = rb.budgetGrids[gi]!;
    const order = grid.visits.map((v, vi) => ({ v, vi })).sort((a, b) => a.v.order - b.v.order);
    if (order.length === kg.visitTotals.length) order.forEach(({ vi }, i) => out.set(`/budgetGrids/${gi}/visits/${vi}/totalCents`, kg.visitTotals[i]!));
    grid.perPatientTotals.forEach((t, ti) => {
      if (kg.perPatient.includes(t.cents)) out.set(`/budgetGrids/${gi}/perPatientTotals/${ti}/cents`, t.cents);
    });
    const codes = order.map(({ v }) => v.code);
    const unused = new Set(grid.procedures.map((_, i) => i));
    for (const r of kg.rows ?? []) {
      const score = (pi: number) => codes.filter((c, i) => grid.procedures[pi]!.cells[c] === (r.cells[i] ?? undefined)).length;
      const pi = [...unused]
        .filter((i) => (r.code ? !!grid.procedures[i]!.code && norm(grid.procedures[i]!.code!) === norm(r.code) : sharesWord(grid.procedures[i]!.name, r.name)))
        .sort((a, b) => score(b) - score(a))[0];
      if (pi === undefined) continue;
      unused.delete(pi);
      codes.forEach((c, i) => {
        if (r.cells[i] !== null && r.cells[i] !== undefined && c in grid.procedures[pi]!.cells) out.set(`/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(c)}`, r.cells[i]!);
      });
      if (r.unitCents !== null && grid.procedures[pi]!.unitCents !== null) out.set(`/budgetGrids/${gi}/procedures/${pi}/unitCents`, r.unitCents);
    }
  }
  const items = [...rb.invoiceables.map((x, i) => ({ base: `/invoiceables/${i}`, x, withOh: x.amountWithOverheadCents })), ...rb.siteFees.map((x, i) => ({ base: `/siteFees/${i}`, x, withOh: null }))];
  for (const { base, x, withOh } of items) {
    const named = g.items.filter((k) => (k.code && x.code && norm(k.code) === norm(x.code)) || (sameName(k.name, x.name) && sharesWord(k.name, x.name)));
    if (named.length !== 1) continue;
    if (x.amountCents !== null) out.set(`${base}/amountCents`, named[0]!.cents);
    if (withOh !== null && withOh !== undefined && named[0]!.withOverheadCents !== undefined) out.set(`${base}/amountWithOverheadCents`, named[0]!.withOverheadCents);
  }
  const rule = (path: string, v: unknown) => {
    if (v !== undefined && v !== null && get(rb, path) !== undefined && get(rb, path) !== null) out.set(path, v as number | string);
  };
  rule("/study/effectiveDate/value", g.study.effectiveDate);
  rule("/overhead/pct/value", g.overheadPct);
  rule("/holdback/pct", g.holdbackPct);
  rule("/payment/netDays/value", g.netDays);
  rule("/overpayment/refundDays", g.overpayment?.refundDays);
  if (g.screenFail) {
    rule("/screenFail/amountCents", g.screenFail.cents);
    rule("/screenFail/cap/n", g.screenFail.n);
  }
  rb.deadlines.forEach((d, i) => {
    const k = g.deadlines.filter((x) => x.kind === d.kind);
    if (k.length === 1) rule(`/deadlines/${i}/value`, k[0]!.value);
  });
  return out;
}

// planted errors: deterministic, so a run can be repeated
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const LOOK: Record<string, string> = { "0": "8", "1": "7", "2": "7", "3": "8", "4": "1", "5": "6", "6": "5", "7": "1", "8": "3", "9": "8" };
function oneDigit(rb: Rulebook, p: string, v: number | string, look: boolean): number | string | null {
  const s = typeof v === "string" ? v : isCents(rb, p) ? (v / 100).toFixed(2) : String(v);
  const at = [...s].flatMap((ch, i) => (/\d/.test(ch) ? [i] : []));
  if (!at.length) return null;
  const i = at[Math.floor(rand() * at.length)]!;
  const t = s.slice(0, i) + (look ? LOOK[s[i]!]! : String((Number(s[i]) + 1 + Math.floor(rand() * 9)) % 10)) + s.slice(i + 1);
  if (typeof v === "string") return Number.isNaN(new Date(`${t}T00:00:00Z`).getTime()) ? null : t;
  return isCents(rb, p) ? Math.round(Number(t) * 100) : Number(t);
}

const confirmedIn = (ev: ValueEvidence[]) => new Set(ev.filter((e) => e.status === "confirmed").map((e) => e.path));

const files = readdirSync(join(root, "data/contracts")).filter((f) => f.endsWith(".pdf"));
const report: Record<string, unknown> = {};
const allMs: number[] = [];
for (const [name, label] of Object.entries(CONTRACTS)) {
  const read = JSON.parse(readFileSync(join(root, "data/extractions", `${name}.json`), "utf8")) as { rulebook: unknown };
  const rb = Rulebook.parse(read.rulebook);
  const golden = JSON.parse(readFileSync(join(root, "data/golden", `${name}.json`), "utf8")) as Golden;
  const docId = rb.documents[0]!.id;
  const pdf = join(root, "data/contracts", files.find((f) => f.includes(label))!);
  const docs = [{ id: docId, filename: "contract.pdf" }];
  const scan = await readTextLayer(pdf, docId);
  const { pages, ms } = ocrPages(name, scan);
  allMs.push(...ms);
  const anomalies = runContractChecks(rb);
  const today = reviewDraft(port, rb, anomalies, scan, docs);
  const withOcr = reviewDraft(port, rb, anomalies, pages, docs);

  const key = keyed(rb, golden);
  const final = new Map(withOcr.evidence.map((e) => [e.path, e.status]));
  let wrongConfirmed = 0;
  let aiWrong = 0;
  for (const [p, v] of key) {
    const right = get(rb, p) === v;
    if (!right) aiWrong++;
    if (!right && final.get(p) === "confirmed") wrongConfirmed++;
  }

  // planted errors, bound against the OCR alone (the totals can't confirm a changed value: they no longer add up)
  const confirmed = confirmedIn(bindEvidence(rb, pages).evidence);
  const planted: Record<"digit" | "lookalike" | "columnShift" | "wrongVisit", [tried: number, caught: number]> = { digit: [0, 0], lookalike: [0, 0], columnShift: [0, 0], wrongVisit: [0, 0] };
  for (const kind of ["digit", "lookalike"] as const)
    for (let round = 0; round < 3; round++) {
      const m = structuredClone(rb);
      const changed: string[] = [];
      for (const p of confirmed) {
        const v = get(rb, p);
        if (typeof v !== "number" && typeof v !== "string") continue;
        const w = oneDigit(rb, p, v, kind === "lookalike");
        if (w !== null && w !== v) (set(m, p, w), changed.push(p));
      }
      const after = confirmedIn(bindEvidence(m, pages).evidence);
      planted[kind][0] += changed.length;
      planted[kind][1] += changed.filter((p) => !after.has(p)).length;
    }
  // a whole row read one visit to the left: each cell takes its right-hand neighbour's value; one that comes out the same changes nothing
  const shifted = structuredClone(rb);
  const moved: string[] = [];
  shifted.budgetGrids.forEach((g, gi) => {
    const codes = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.code);
    g.procedures.forEach((p, pi) => {
      const orig = rb.budgetGrids[gi]!.procedures[pi]!.cells;
      codes.forEach((c, i) => {
        const next = codes[i + 1];
        const path = `/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(c)}`;
        if (next === undefined || !(c in orig) || !(next in orig) || orig[c] === orig[next] || !confirmed.has(path)) return;
        p.cells[c] = orig[next]!;
        moved.push(path);
      });
    });
  });
  const afterShift = confirmedIn(bindEvidence(shifted, pages).evidence);
  planted.columnShift = [moved.length, moved.filter((p) => !afterShift.has(p)).length];
  // a price put at the visit next door, where the row prints nothing: billing a procedure at a visit that doesn't have it
  const misplaced = structuredClone(rb);
  const placed: string[] = [];
  misplaced.budgetGrids.forEach((g, gi) => {
    const codes = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.code);
    g.procedures.forEach((p, pi) => {
      const orig = rb.budgetGrids[gi]!.procedures[pi]!.cells;
      codes.forEach((c, i) => {
        const from = `/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(c)}`;
        const to = [codes[i - 1], codes[i + 1]].find((n) => n !== undefined && !(n in orig) && !(n in p.cells));
        if (!(c in orig) || to === undefined || !confirmed.has(from)) return;
        p.cells[to] = orig[c]!;
        placed.push(`/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(to)}`);
      });
    });
  });
  const afterPlace = confirmedIn(bindEvidence(misplaced, pages).evidence);
  planted.wrongVisit = [placed.length, placed.filter((p) => !afterPlace.has(p)).length];

  const status = (ev: ValueEvidence[]) => tally(ev.map((e) => e.status));
  report[label] = {
    values: withOcr.evidence.length,
    today: { status: status(today.evidence), questions: today.review.length },
    withOcr: { status: status(withOcr.evidence), questions: withOcr.review.length, byReason: tally(withOcr.review.map((i) => i.reason)) },
    key: { keyed: key.size, aiWrong, wrongConfirmed },
    planted: Object.fromEntries(Object.entries(planted).map(([k, [tried, caught]]) => [k, `${caught}/${tried}`])),
  };
}
report.secondsPerPage = +(allMs.reduce((a, b) => a + b, 0) / allMs.length / 1000).toFixed(2);
console.log(JSON.stringify(report, null, 1));
