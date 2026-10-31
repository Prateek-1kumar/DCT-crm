/**
 * pnpm --filter @dct/api ocr-eval    the scan gate (ADR-001 addendum 2026-10-29), no AI calls
 * OCR_EVAL_SET=heldout pnpm --filter @dct/api ocr-eval    the same on the unseen contracts in data/heldout
 *
 * Binds the saved reads of the 4 scanned contracts (data/extractions) to our own OCR of their pages and scores the
 * result against the answer keys (data/golden):
 * - wrong confirmed: a value the key pins down, confirmed, but not the key's value. The gate: 0.
 * - planted errors: every confirmed value changed by one digit (random, and a look-alike digit), every grid row shifted
 *   one visit over, each cell copied to a neighbouring visit the read leaves empty ("invoiceable" marks too), two adjacent
 *   rows' contents exchanged (rowSwap), a whole block of rows with held cells placed one row down (rowShift), and the two cost
 *   columns read the wrong way round (costColumnSwap: an item's price before overhead and with it exchanged, a unit price read
 *   from the column with overhead), and a visit's overhead, subtotal, non-procedure amount or total taken from the visit next
 *   door (summaryRowShift), and every money value 100x or 1/100 (decimalShift, the missing-point candidate rule); each must
 *   come out unconfirmed (a value that bills the same amount as before isn't an error).
 *   The gate: all caught. A copy the page itself prints in that visit's cell is the read's miss, counted apart.
 * - ADR-002 PR 2: reviewDraft runs the arithmetic referee and the sweep gate, in the mode OCR_EVAL_SOLVER=guide|strict (default
 *   strict, as the app); `confirmed_by_math` counts as confirmed in every gate, and per contract it prints the values upgraded by math (by their
 *   earlier status), the sweep spans dropped by reason, and the identities checked / passed / failed (`pr2`).
 * - questions per contract, today (no OCR) and with OCR, by reason.
 * - held values (every check passed, a person still confirms their table's columns): counted as confirmed in every gate above,
 *   since the worst case is that the person confirms the mapping. Also reported: table checks, the share confirmed with
 *   and without held, and "mapping off by one" (held cells that would still confirm with the table's columns assigned to the
 *   visit next door, or its rows to the row next door; reported, not a gate), and the rows placed by order.
 *
 * The OCR is the app's own (readTextLayer with ocr, packages/extraction/ocr; install it with `pnpm run setup`), cached
 * beside each PDF after the first run. Repo root = DCT_ROOT, else three levels above this file. Prints counts only;
 * never contract text or amounts.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Anchor, bindEvidence, gateSweep, type NonFee, type PrintedRow, norm, readTextLayer, reviewFromEvidence, runContractChecks, sameName, sharesWord, solveGrids, type SolverMode } from "@dct/extraction";
import { Rulebook, type ValueEvidence } from "@dct/shared";
import { reviewDraft, solve } from "../src/review.js";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONTRACTS = { copd: "COPD", hcwc: "HCWC", mcallen: "McAllen", shah: "Shah" } as const;
const port = { bindEvidence, reviewFromEvidence, solveGrids, gateSweep };
// The solver's mode, as EXTRACTION_SOLVER sets it in the app (ADR-002 PR 2): every number below is what a read would do in that mode.
const mode: SolverMode = process.env.OCR_EVAL_SOLVER === "guide" ? "guide" : "strict";
// OCR_EVAL_ROUNDING=1: the solver's rounding-aware addition (off in the app until the senior engineer approves it)
const rounding = process.env.OCR_EVAL_ROUNDING === "1";
// What reviewDraft makes of a binding: the binder's evidence, then the solver (its upgrades that cite no page undone, as in the app).
// What the live read said besides the rulebook (printed quantities and totals, where it read each value, the amounts it called no fee):
// set per contract below, from its saved read; an older read has none.
let extras: { printedRows?: PrintedRow[]; anchors?: Anchor[]; nonFee?: NonFee[] } = {};
const piped = (m: Rulebook, pg: Parameters<typeof bindEvidence>[1]) => {
  const b = bindEvidence(m, pg, extras.printedRows, extras.anchors);
  return solve(solveGrids, m, b.evidence, mode, b.rows, rounding, new Set(pg.filter((p) => p.source === "ocr").map((p) => `${p.documentId}#${p.page}`))).evidence;
};

const keys = (path: string) => path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
const ptr = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const get = (o: unknown, path: string) => keys(path).reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
const set = (o: unknown, path: string, v: unknown) => {
  const ks = keys(path);
  (ks.slice(0, -1).reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o) as Record<string, unknown>)[ks.at(-1)!] = v;
};
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const isCents = (rb: Rulebook, p: string) => /Cents$|\/cents$|\/cells\//.test(p) || (p.endsWith("/cap/n") && get(rb, p.replace(/\/n$/, "/kind")) === "amount");

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
  // One golden item is one read item's key. The name test is loose (a longer name that holds a shorter one's words passes it), so
  // when several read items pair with one golden item, the one whose words are the closest to its own keeps it, and a tie leaves it
  // with none: a key must not be set against a different item that only resembles it.
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const closeness = (a: string, b: string) => {
    const [x, y] = [words(a), words(b)];
    return (2 * [...x].filter((t) => y.has(t)).length) / (x.size + y.size);
  };
  const pairs = items.flatMap((it) => {
    const named = g.items.filter((k) => (k.code && it.x.code && norm(k.code) === norm(it.x.code)) || (sameName(k.name, it.x.name) && sharesWord(k.name, it.x.name)));
    return named.length === 1 ? [{ ...it, k: named[0]!, close: closeness(named[0]!.name, it.x.name) }] : [];
  });
  for (const { base, x, withOh, k, close } of pairs) {
    const rivals = pairs.filter((o) => o.k === k && o.base !== base);
    if (rivals.some((o) => o.close >= close)) continue;
    const named = [k];
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

// A held value (every check passed, a person still has to confirm its table's columns) counts as confirmed here: the worst
// case is that the person confirms the mapping, so a planted error it lets through is a failure of the gate.
// `confirmed_by_math` counts as confirmed too: a planted error the arithmetic now confirms is a failure to report.
const sure = (e: ValueEvidence) => e.status === "confirmed" || e.status === "confirmed_by_math" || !!e.held;
const confirmedIn = (ev: ValueEvidence[]) => new Set(ev.filter(sure).map((e) => e.path));

// OCR_EVAL_SET=heldout: the unseen contracts in data/heldout (<name>.pdf, its read in extractions/<name>.json), text PDFs
// too; scored against a key only where data/golden has one, so "wrong confirmed" there covers keyed contracts only.
const heldout = process.env.OCR_EVAL_SET === "heldout";
const setDir = join(root, heldout ? "data/heldout" : "data/contracts");
// OCR_EVAL_READS: another folder of saved reads (a live eval run with EVAL_OUT)
const readsDir = heldout ? join(setDir, "extractions") : process.env.OCR_EVAL_READS ?? join(root, "data/extractions");
const set_ = heldout ? Object.fromEntries(readdirSync(readsDir).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), f.slice(0, -5)])) : CONTRACTS;
const files = readdirSync(setDir).filter((f) => f.endsWith(".pdf"));
const report: Record<string, unknown> = {};
const seconds: number[] = [];
// OCR_EVAL_ONLY=hcwc,mcallen: just these contracts (a folder of reads that holds some)
const only = process.env.OCR_EVAL_ONLY?.split(",");
for (const [name, label] of Object.entries(set_).filter(([n]) => !only || only.includes(n))) {
  const read = JSON.parse(readFileSync(join(readsDir, `${name}.json`), "utf8")) as { rulebook: unknown; printedRows?: PrintedRow[]; anchors?: Anchor[]; nonFee?: NonFee[] };
  extras = { printedRows: read.printedRows, anchors: read.anchors, nonFee: read.nonFee };
  const rb = Rulebook.parse(read.rulebook);
  const goldenFile = join(root, "data/golden", `${name}.json`);
  const golden = heldout && !existsSync(goldenFile) ? null : (JSON.parse(readFileSync(goldenFile, "utf8")) as Golden);
  const docId = rb.documents[0]!.id;
  const pdf = join(setDir, files.find((f) => f.includes(label))!);
  const docs = [{ id: docId, filename: "contract.pdf" }];
  const scan = await readTextLayer(pdf, docId);
  const t0 = Date.now();
  const pages = await readTextLayer(pdf, docId, { ocr: true });
  const ocred = pages.filter((p) => p.source === "ocr").length;
  if (!ocred && pages.some((p) => p.source === "image_only")) throw new Error("The OCR didn't run: install it with pnpm run setup (packages/extraction/ocr/setup.sh)");
  if (ocred) seconds.push((Date.now() - t0) / 1000 / ocred);
  const anomalies = runContractChecks(rb);
  const today = reviewDraft(port, rb, anomalies, scan, docs, { solver: mode, rounding, ...extras });
  const withOcr = reviewDraft(port, rb, anomalies, pages, docs, { solver: mode, rounding, ...extras });

  const key = golden ? keyed(rb, golden) : new Map<string, number | string>();
  const final = new Map(withOcr.evidence.map((e) => [e.path, sure(e) ? "confirmed" : e.status]));
  let wrongConfirmed = 0;
  let aiWrong = 0;
  const wrongAt: string[] = [];
  for (const [p, v] of key) {
    const right = get(rb, p) === v;
    if (!right) aiWrong++;
    if (!right && final.get(p) === "confirmed") (wrongConfirmed++, wrongAt.push(p));
  }

  // planted errors, bound against the OCR alone (the totals can't confirm a changed value: they no longer add up)
  const base = bindEvidence(rb, pages, extras.printedRows, extras.anchors);
  const confirmed = confirmedIn(piped(rb, pages));
  const heldPaths = new Set(base.evidence.filter((e) => e.held).map((e) => e.path));
  const planted: Record<"digit" | "lookalike" | "columnShift" | "wrongVisit" | "rowSwap" | "rowShift" | "costColumnSwap" | "summaryRowShift" | "decimalShift", [tried: number, caught: number]> = { digit: [0, 0], lookalike: [0, 0], columnShift: [0, 0], wrongVisit: [0, 0], rowSwap: [0, 0], rowShift: [0, 0], costColumnSwap: [0, 0], summaryRowShift: [0, 0], decimalShift: [0, 0] };
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
      const after = confirmedIn(piped(m, pages));
      planted[kind][0] += changed.length;
      planted[kind][1] += changed.filter((p) => !after.has(p)).length;
    }
  // the decimal point lost or gained: every confirmed money value times 100, and (where it stays whole cents) divided by 100. The
  // missing-point candidate rule reads "4500" as 45.00, so a value read 100x too large can match its own token. A leak is listed by
  // the shape of what the page prints there (digits as 9, never an amount) and the status it came out with.
  const leakShapes: string[] = [];
  // Two rounds a direction, every other value each time: every value is tried once, and its neighbours stay as read. (Changing
  // every value at once scales the whole table by 100, which any sum agrees with and no reader would produce.)
  for (const [dir, half] of [["up", 0], ["up", 1], ["down", 0], ["down", 1]] as const) {
    const m = structuredClone(rb);
    const changed: string[] = [];
    let n = 0;
    for (const p of confirmed) {
      const v = get(rb, p);
      if (typeof v !== "number" || !isCents(rb, p) || v === 0 || (dir === "down" && v % 100 !== 0) || n++ % 2 !== half) continue;
      set(m, p, dir === "up" ? v * 100 : v / 100);
      changed.push(p);
    }
    const out = piped(m, pages);
    const afterIds = confirmedIn(out);
    planted.decimalShift[0] += changed.length;
    planted.decimalShift[1] += changed.filter((p) => !afterIds.has(p)).length;
    for (const e of out) if (changed.includes(e.path) && sure(e)) leakShapes.push(`${dir} ${e.status}${e.held ? " held" : ""} printed ${e.printed === null ? "nothing" : e.printed.replace(/\d/g, "9")}`);
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
  const afterShift = confirmedIn(piped(shifted, pages));
  planted.columnShift = [moved.length, moved.filter((p) => !afterShift.has(p)).length];
  // "Mapping off by one" (reported, not a gate): a held table's columns assigned to the visit next door, either way. Every
  // cell of a row with a held cell moves one visit over (what a wrong mapping would make the master say), and the held
  // cells that would still confirm are counted. A cell whose neighbour is read alike is left out: nobody could tell it apart.
  const offByOne = Object.fromEntries(
    ([-1, 1] as const).map((d) => {
      const m = structuredClone(rb);
      const moved: string[] = [];
      m.budgetGrids.forEach((g, gi) => {
        const codes = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.code);
        g.procedures.forEach((p, pi) => {
          const orig = rb.budgetGrids[gi]!.procedures[pi]!.cells;
          const at = (c: string) => `/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(c)}`;
          if (!codes.some((c) => heldPaths.has(at(c)))) return;
          p.cells = {};
          codes.forEach((c, i) => {
            const to = codes[i + d];
            if (!(c in orig) || to === undefined) return;
            p.cells[to] = orig[c]!;
            if (heldPaths.has(at(c)) && orig[to] !== orig[c]) moved.push(at(to));
          });
        });
      });
      const after = confirmedIn(piped(m, pages));
      return [d < 0 ? "visitBefore" : "visitAfter", `${moved.filter((p) => after.has(p)).length}/${moved.length}`];
    }),
  );
  // Rows. A procedure's content is its cells and unit price, by path. Two adjacent rows' contents exchanged where they differ
  // (a read that has two rows the wrong way round), and a whole block of rows with held cells placed one row down or up
  // (what a wrong row mapping would make the master say). Each changed value that was confirmed or held must come out
  // unconfirmed; where the neighbour's value is the same nothing changed, and nobody could tell.
  const contents = (m: Rulebook, gi: number, pi: number) => {
    const p = m.budgetGrids[gi]!.procedures[pi]!;
    return new Map<string, number | string>([...Object.entries(p.cells).map(([c, v]) => [`/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(c)}`, v] as const), ...(p.unitCents !== null ? [[`/budgetGrids/${gi}/procedures/${pi}/unitCents`, p.unitCents] as const] : [])]);
  };
  const put = (m: Rulebook, gi: number, pi: number, from: Map<string, number | string>) => {
    const p = m.budgetGrids[gi]!.procedures[pi]!;
    const cells: Record<string, number | "invoiceable"> = {};
    let unit = p.unitCents;
    for (const [path, v] of from) {
      const last = path.split("/").at(-1)!;
      if (last === "unitCents") unit = v as number;
      else cells[last.replace(/~1/g, "/").replace(/~0/g, "~")] = v as number | "invoiceable";
    }
    p.cells = cells;
    p.unitCents = unit;
  };
  // What a cell bills: its number, or for "invoiceable" the row's unit price. A cell that comes out billing the same amount
  // as before isn't an error, whatever the read calls it.
  const meaning = (m: Rulebook, path: string) => (get(m, path) === "invoiceable" ? (get(m, path.replace(/\/cells\/.*$/, "/unitCents")) ?? null) : get(m, path));
  const rowsTried = (m: Rulebook, planned: string[]) => {
    const changed = planned.filter((x) => meaning(m, x) !== meaning(rb, x));
    const after = confirmedIn(piped(m, pages));
    return { tried: changed.length, caught: changed.filter((x) => !after.has(x)).length, still: changed.filter((x) => after.has(x)) };
  };
  const swapped = structuredClone(rb);
  const swappedPaths: string[] = [];
  rb.budgetGrids.forEach((g, gi) => {
    for (let pi = 0; pi + 1 < g.procedures.length; pi += 2) {
      const [a, b] = [contents(rb, gi, pi), contents(rb, gi, pi + 1)];
      const there = (path: string) => path.replace(`/procedures/${pi}/`, `/procedures/${pi + 1}/`);
      const [na, nb] = [new Map(a), new Map(b)];
      for (const [path, v] of a) {
        const other = there(path);
        if (b.has(other) && b.get(other) !== v && confirmed.has(path) && confirmed.has(other)) (na.set(path, b.get(other)!), nb.set(other, v), swappedPaths.push(path, other));
      }
      put(swapped, gi, pi, na);
      put(swapped, gi, pi + 1, nb);
    }
  });
  const swap = rowsTried(swapped, swappedPaths);
  planted.rowSwap = [swap.tried, swap.caught];
  // Blocks of consecutive rows holding a held cell, moved one row down (`1`: each takes the content of the one above) or up.
  const moveRows = (d: 1 | -1) => {
    const m = structuredClone(rb);
    const changed: string[] = [];
    m.budgetGrids.forEach((g, gi) => {
      const holds = g.procedures.map((_, pi) => [...contents(rb, gi, pi).keys()].some((x) => heldPaths.has(x)));
      const order = g.procedures.map((_, pi) => pi);
      for (const pi of d === 1 ? order.reverse() : order) {
        const from = pi - d;
        if (!holds[pi] || !holds[from]) continue;
        const [mine, src] = [contents(rb, gi, pi), contents(rb, gi, from)];
        // the neighbour's content under this row's own paths
        const moved = new Map([...src].map(([path, v]) => [path.replace(`/procedures/${from}/`, `/procedures/${pi}/`), v] as const));
        for (const [path, v] of moved) if (mine.has(path) && mine.get(path) !== v && confirmed.has(path)) changed.push(path);
        put(m, gi, pi, moved);
      }
    });
    return rowsTried(m, changed);
  };
  const [down, up] = [moveRows(1), moveRows(-1)];
  planted.rowShift = [down.tried, down.caught];
  const rowOffByOne = { rowBelow: `${down.still.filter((x) => heldPaths.has(x)).length}/${down.tried}`, rowAbove: `${up.still.filter((x) => heldPaths.has(x)).length}/${up.tried}` };
  // The two cost columns read the wrong way round: an item's price before overhead and with it exchanged, and a row's unit price
  // read from the column with overhead (its own price plus the overhead %). Where the two come out the same nothing changed.
  const swappedCosts = structuredClone(rb);
  const costPaths: string[] = [];
  swappedCosts.invoiceables.forEach((x, i) => {
    const [a, b] = [rb.invoiceables[i]!.amountCents, rb.invoiceables[i]!.amountWithOverheadCents];
    if (a === null || b === null || a === b) return;
    [x.amountCents, x.amountWithOverheadCents] = [b, a];
    costPaths.push(`/invoiceables/${i}/amountCents`, `/invoiceables/${i}/amountWithOverheadCents`);
  });
  swappedCosts.budgetGrids.forEach((g, gi) => {
    const pct = rb.budgetGrids[gi]!.statedOverheadPct ?? rb.overhead.pct.value;
    if (pct === null) return;
    g.procedures.forEach((p, pi) => {
      const unit = rb.budgetGrids[gi]!.procedures[pi]!.unitCents;
      if (unit === null || Math.round((unit * (100 + pct)) / 100) === unit) return;
      p.unitCents = Math.round((unit * (100 + pct)) / 100);
      costPaths.push(`/budgetGrids/${gi}/procedures/${pi}/unitCents`);
    });
  });
  const afterCosts = confirmedIn(piped(swappedCosts, pages));
  const costsTried = costPaths.filter((x) => confirmed.has(x));
  planted.costColumnSwap = [costsTried.length, costsTried.filter((x) => !afterCosts.has(x)).length];
  // A visit's overhead, subtotal, non-procedure amount or total taken from the visit next door (the summary row read one column
  // over). Where the neighbour's value is the same, nothing changed.
  const shiftedSums = structuredClone(rb);
  const sumPaths: string[] = [];
  const SUMS = ["overheadCents", "procedureSubtotalCents", "nonProcedureCents", "totalCents"] as const;
  shiftedSums.budgetGrids.forEach((g, gi) => {
    const order = rb.budgetGrids[gi]!.visits.map((v, vi) => ({ v, vi })).sort((a, b) => a.v.order - b.v.order);
    order.forEach(({ v, vi }, k) => {
      const next = order[k + 1];
      if (!next) return;
      for (const f of SUMS) {
        const path = `/budgetGrids/${gi}/visits/${vi}/${f}`;
        const to = next.v[f];
        if (to === null || v[f] === null || to === v[f] || !confirmed.has(path)) continue;
        (g.visits[vi]![f] as number) = to;
        sumPaths.push(path);
      }
    });
  });
  const afterSums = confirmedIn(piped(shiftedSums, pages));
  planted.summaryRowShift = [sumPaths.length, sumPaths.filter((x) => !afterSums.has(x)).length];
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
  // Confirmed only where the page prints that very price in that visit's cell (the binder confirms nothing else): there
  // the read left a visit out. Counted apart, as the read's misses, not as errors the check let through.
  const placedBind = bindEvidence(misplaced, pages, extras.printedRows, extras.anchors);
  const boundPlace = placedBind.evidence;
  const afterPlace = boundPlace.filter((e) => sure(e) && placed.includes(e.path));
  // what the arithmetic then confirms among the rest is an error let through
  const byMathPlace = solve(solveGrids, misplaced, boundPlace, mode, placedBind.rows).evidence.filter((e) => e.status === "confirmed_by_math" && placed.includes(e.path));
  planted.wrongVisit = [placed.length - afterPlace.length, placed.length - afterPlace.length - byMathPlace.length];
  const readMissed = { price: afterPlace.filter((e) => typeof get(misplaced, e.path) === "number").length, invoiceable: afterPlace.filter((e) => get(misplaced, e.path) === "invoiceable").length };

  const status = (ev: ValueEvidence[]) => tally(ev.map((e) => e.status));
  const nConfirmed = withOcr.evidence.filter((e) => e.status === "confirmed" || e.status === "confirmed_by_math").length;
  // Upgraded by math, by the status each value had before; and the sweep and solver tallies, counts only (ADR-002 PR 2).
  const pr2 = (r: typeof withOcr) => ({
    mode,
    upgradedByMath: r.solver ? { total: r.solver.upgraded.total, from: { ungrounded: r.solver.upgraded.ungrounded, conflict: r.solver.upgraded.conflict }, noPage: r.solver.noPage, heldWouldPass: r.solver.heldWouldPass } : null,
    sweepDropped: r.sweep ? { consumed: r.sweep.consumed, insurance: r.sweep.insurance, explained: r.sweep.explained, explainedBy: r.sweep.explainedBy, noCue: r.sweep.noCue, kept: r.sweep.kept } : null,
    identities: r.solver?.identities ?? null,
  });
  const nHeld = withOcr.evidence.filter((e) => e.held).length;
  const pct = (n: number) => `${((100 * n) / withOcr.evidence.length).toFixed(1)}%`;
  report[label] = {
    values: withOcr.evidence.length,
    pages: { ocr: ocred, unclear: withOcr.review.filter((i) => i.reason === "SCAN_PAGE").length, regions: withOcr.review.filter((i) => i.reason === "SCAN_REGION").length },
    today: { status: status(today.evidence), questions: today.review.length },
    pr2: { today: pr2(today), withOcr: pr2(withOcr) },
    withOcr: { status: status(withOcr.evidence), held: withOcr.evidence.filter((e) => e.held).length, questions: withOcr.review.length, byReason: tally(withOcr.review.map((i) => i.reason)) },
    tableChecks: base.tableChecks.length,
    autoConfirmed: { values: withOcr.evidence.length, confirmed: nConfirmed, withHeld: nConfirmed + nHeld, share: pct(nConfirmed), shareWithHeld: pct(nConfirmed + nHeld) },
    mappingOffByOne: { ...offByOne, ...rowOffByOne },
    rowsPlacedByOrder: base.tableChecks.reduce((n, c) => n + (c.rows?.length ?? 0), 0),
    // the paths of any wrong confirmation (indices only, no text), so it can be found
    key: { keyed: key.size, aiWrong, wrongConfirmed, ...(wrongAt.length ? { wrongAt } : {}) },
    planted: Object.fromEntries(Object.entries(planted).map(([k, [tried, caught]]) => [k, `${caught}/${tried}`])),
    decimalShiftLeaks: tally(leakShapes),
    readMissedAVisitThePagePrints: readMissed,
  };
}
// a cached run reads nothing: this is the time per page of the first run only
report.secondsPerPage = seconds.map((s) => +s.toFixed(2));
console.log(JSON.stringify(report, null, 1));
