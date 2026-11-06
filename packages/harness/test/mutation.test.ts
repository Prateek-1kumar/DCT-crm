import { applyPatches, cellProofPatches, citationPatches, correctedCells, valueAt, type Accounted, type Cell, type Grid, type Relation, type Rulebook, type Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { checks } from "../src/checks";
import { printsTotals } from "../src/checks/grid";
import { coverage } from "../src/checks/coverage";
import { withRelationProof } from "../src/checks/relations";
import { amountsAt, usd } from "../src/checks/text";
import type { Reader } from "../src/models/reader";
import { buildPage } from "../src/pdf/page";
import { resolve } from "../src/resolve";
import { asPrintedQuestion } from "../src/resolve/read";
import { withScans } from "../src/scan";
import { amountsOf } from "../src/scan/cells";
import { parseTranscription, type Field, type Transcription } from "../src/scan/transcribe";
import { verifyVersion } from "../src/scan/verify";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";

/*
 * Planted misreads (§5.5 gate). A misread in the first read, which the rulebook cites, must never end up proven; one in the
 * second read only costs questions, and how many is the noise rate. Pages, values and mutations are random but seeded.
 */

const DOC = "Budget.pdf";
const SEEDS = 50;

function random(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = ReturnType<typeof random>;
const pick = <T>(r: Rand, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
const shuffled = <T>(r: Rand, xs: T[]) => xs.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const fee = (r: Rand) => (20 + Math.floor(r() * 1980)) * 100 + pick(r, [0, 0, 0, 25, 50, 75]);
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

const PROCEDURES = ["Physical exam", "Vital signs", "ECG", "Hematology", "Chemistry panel", "Urinalysis", "PK sample", "Drug dispensing", "Pregnancy test", "Questionnaire", "Chest X-ray", "MRI"];
const PROSE = [
  "The screen failure fee is {a} per subject.",
  "Each unscheduled visit is paid at {a}.",
  "The study start-up fee of {a} is non-refundable.",
  "Advertising costs are reimbursed up to {a} in total.",
  "An IRB renewal fee of {a} is paid annually.",
  "Archiving is paid at {a} at study close-out.",
];

const shown = (cents: number | null, struck?: number) => (cents === null ? "" : struck === undefined ? usd(cents) : `${usd(struck)}{x} ${usd(cents)}{hw}`);
const read = (lines: string[]) => parseTranscription({ rotation: 0, text: lines.join("\n") });

function gridLines(title: string, visits: string[], rows: { label: string; values: (number | null)[] }[], strike?: { row: number; col: number; old: number }) {
  return [
    `T 0.1-0.6 | ${title}`,
    `H | Procedure | ${visits.join(" | ")}`,
    ...rows.map((row, i) => `R 0.2-0.21 | ${row.label} | ${row.values.map((v, j) => shown(v, strike?.row === i && strike.col === j ? strike.old : undefined)).join(" | ")}`),
  ];
}

const strikeIn = (r: Rand, rows: { values: (number | null)[] }[], last = rows.length) => {
  const spots = rows.slice(0, last).flatMap((row, i) => row.values.flatMap((v, col) => (v === null ? [] : [{ row: i, col }])));
  return { ...pick(r, spots), old: fee(r) };
};

interface Shape {
  name: string;
  pages(r: Rand, strike: boolean): Transcription[];
  /** The rulebook the compile agent writes from these reads, each value with the place it stands for. */
  book(reads: Transcription[]): Book;
}

interface Value {
  target: "term" | "grid";
  id: string;
  path: string;
  key: string;
  cents: number;
}
interface Book {
  terms: Term[];
  grids: Grid[];
  relations: Relation[];
  values: Value[];
  accounted?: Accounted[];
}

// the agent cites a handwritten replacement, never the value it strikes out
const cited = (f: Field | undefined) => (f ? (f.parts ? f.parts.filter((p) => !p.marks.includes("struck_out")).flatMap((p) => amountsOf(p.text)) : amountsOf(f.text)) : []);

const TOTALS = /total/i;

function gridBook(id: string, reads: Transcription[]): Book {
  const visits: string[] = [];
  type Row = { name: string; cells: Map<number, [number, string]>; total?: [number, string] };
  const rows = new Map<string, Row>();
  const lines = { subtotal: new Map<number, [number, string]>(), grand: undefined as [number, string] | undefined };
  reads.forEach((t, i) => {
    const table = t.tables[0];
    if (!table) return;
    const from = visits.length;
    // a last column headed "Total" holds each row's printed total
    const totalAt = TOTALS.test(table.columns.at(-1) ?? "") ? table.columns.length - 2 : -1;
    visits.push(...table.columns.slice(1, totalAt < 0 ? undefined : -1));
    const seen = new Map<string, number>();
    table.rows.forEach((row, ri) => {
      const at = (k: number) => `p${i + 1}.t1.r${ri + 1}.c${k + 1}`;
      const values = row.cells.map((c) => cited(c).at(-1) ?? null);
      if (/^subtotal/i.test(row.label)) values.forEach((v, k) => v !== null && lines.subtotal.set(from + k, [v, at(k)]));
      else if (TOTALS.test(row.label)) {
        const k = values.findIndex((v) => v !== null);
        if (k >= 0) lines.grand = [values[k]!, at(k)];
      } else {
        const n = (seen.get(row.label) ?? 0) + 1;
        seen.set(row.label, n);
        const key = `${row.label}#${n}`;
        const entry: Row = rows.get(key) ?? { name: row.label, cells: new Map() };
        values.forEach((v, k) => {
          if (v === null) return;
          if (k === totalAt) entry.total = [v, at(k)];
          else if (from + k < visits.length) entry.cells.set(from + k, [v, at(k)]);
        });
        rows.set(key, entry);
      }
    });
  });
  const values: Value[] = [];
  const cellIds: Record<string, string> = {};
  const line = (cells: Map<number, [number, string]>, path: (j: number) => string, key: (j: number) => string): Cell[] =>
    visits.map((_, j) => {
      const at = cells.get(j);
      if (!at) return null;
      cellIds[path(j)] = at[1];
      values.push({ target: "grid", id, path: path(j), key: key(j), cents: at[0] });
      return at[0];
    });
  const gridRows = [...rows.values()].map((row, i) => {
    if (row.total) {
      cellIds[`rows.${i}.printedRowTotalCents`] = row.total[1];
      values.push({ target: "grid", id, path: `rows.${i}.printedRowTotalCents`, key: `${row.name}|total`, cents: row.total[0] });
    }
    return {
      name: row.name, code: null, unitCostCents: null, printedRowTotalCents: row.total?.[0] ?? null,
      cells: line(row.cells, (j) => `rows.${i}.cells.${j}`, (j) => `${row.name}|${visits[j]}`),
    };
  });
  const subtotal = lines.subtotal.size ? line(lines.subtotal, (j) => `subtotal.${j}`, (j) => `subtotal|${visits[j]}`) : null;
  if (lines.grand) {
    cellIds.grandTotalCents = lines.grand[1];
    values.push({ target: "grid", id, path: "grandTotalCents", key: "grand", cents: lines.grand[0] });
  }
  const grid: Grid = {
    id, name: "Budget", arm: null, doc: DOC, pages: reads.map((_, i) => i + 1), visits, overheadPct: null, rows: gridRows, subtotal, overhead: null,
    additions: [], total: null, grandTotalCents: lines.grand?.[0] ?? null, cellsReadTwice: [], acceptedAsPrinted: false, cellIds,
  };
  return { terms: [], grids: [grid], relations: [], values };
}

const term = (id: string, name: string, cents: number, quote: string, cell: string): Term => ({
  id, category: "site_fee", name, amountCents: cents, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
  holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: DOC, page: Number(/^p(\d+)/.exec(cell)![1]), quote, cell }, evidence: "none",
  houseRuleIds: [], notes: null,
});

const SHAPES: Shape[] = [
  {
    name: "wide visit grid",
    pages(r, strike) {
      const visits = Array.from({ length: 12 }, (_, i) => `V${i + 1}`);
      const body = shuffled(r, PROCEDURES).slice(0, 7).map((label) => ({ label, values: visits.map(() => (r() < 0.15 ? null : fee(r))) }));
      const subtotal = visits.map((_, j) => sum(body.map((row) => row.values[j]!)));
      const rows = [...body, { label: "Subtotal", values: subtotal }, { label: "Grand total", values: [sum(subtotal), ...visits.slice(1).map(() => null)] }];
      return [read(["L 0.02-0.03 | Exhibit B - Budget", ...gridLines("Per-visit budget", visits, rows, strike ? strikeIn(r, rows, body.length) : undefined)])];
    },
    book: (reads) => gridBook("g1", reads),
  },
  {
    name: "two-page grid",
    pages(r, strike) {
      const labels = shuffled(r, PROCEDURES).slice(0, 5);
      const page = (from: number) => {
        const visits = Array.from({ length: 8 }, (_, i) => `V${from + i + 1}`);
        return { visits, rows: labels.map((label) => ({ label, values: visits.map(() => (r() < 0.2 ? null : fee(r))) })) };
      };
      const halves = [page(0), page(8)];
      const at = strike ? Math.floor(r() * 2) : -1;
      return halves.map((h, i) => read(gridLines(i ? "Schedule of payments (continued)" : "Schedule of payments", h.visits, h.rows, i === at ? strikeIn(r, h.rows) : undefined)));
    },
    book: (reads) => gridBook("g1", reads),
  },
  {
    name: "row-total grid",
    pages(r, strike) {
      const visits = Array.from({ length: 6 }, (_, i) => `V${i + 1}`);
      // every row prints at least its first visit, so its total is never $0.00
      const body = shuffled(r, PROCEDURES).slice(0, 7).map((label) => ({ label, values: visits.map((_, j) => (j && r() < 0.3 ? null : fee(r))) }));
      const rows = body.map((row) => ({ ...row, values: [...row.values, sum(row.values)] }));
      return [read(["L 0.02-0.03 | Exhibit B - Budget", ...gridLines("Per-visit budget", [...visits, "Total"], rows, strike ? strikeIn(r, body) : undefined)])];
    },
    book: (reads) => gridBook("g1", reads),
  },
  {
    name: "column-sum relations",
    pages(r, strike) {
      const visits = ["Screening", "Treatment", "Follow-up"];
      const body = shuffled(r, PROCEDURES).slice(0, 6).map((label) => ({ label, values: visits.map(() => (r() < 0.3 ? null : fee(r))) }));
      const rows = [...body, { label: "Total", values: visits.map((_, j) => sum(body.map((row) => row.values[j]!))) }];
      return [read(["L 0.02-0.03 | Exhibit C - Fees by period", ...gridLines("Fees by period", visits, rows, strike ? strikeIn(r, body) : undefined)])];
    },
    book([t]) {
      // a term per fee, and the printed column totals as sums of the cells above them
      const terms: Term[] = [];
      const relations: Relation[] = [];
      const values: Value[] = [];
      const accounted: Accounted[] = [];
      const table = t!.tables[0];
      const width = table ? table.columns.length - 1 : 0;
      for (let k = 0; k < width; k++) {
        const operands: string[] = [];
        table!.rows.forEach((row, i) => {
          const cents = cited(row.cells[k]).at(-1);
          if (cents === undefined) return;
          const cell = `p1.t1.r${i + 1}.c${k + 1}`;
          if (TOTALS.test(row.label)) {
            accounted.push({ doc: DOC, page: 1, cell, reason: "the total of the fees above it" });
            if (operands.length > 1) relations.push({ kind: "sum", doc: DOC, result: cell, operands: [...operands] });
            return;
          }
          const id = `t${i + 1}.${k + 1}`;
          terms.push({ ...term(id, `${row.label} (${table!.columns[k + 1]})`, cents, row.label, cell), unit: table!.columns[k + 1]! });
          values.push({ target: "term", id, path: "amountCents", key: `${row.label}|${table!.columns[k + 1]}`, cents });
          operands.push(cell);
        });
      }
      return { terms, grids: [], relations, values, accounted };
    },
  },
  {
    name: "fee / fee with overhead",
    pages(r, strike) {
      const rows = shuffled(r, PROCEDURES).slice(0, 8).map((label) => {
        const base = fee(r);
        return { label, values: [base, Math.floor((base * 13 + 5) / 10)] };
      });
      const lines = ["L 0.02-0.03 | Exhibit C - Procedure fees", ...gridLines("Procedure fees", ["Fee", "Fee with 30% overhead"], rows, strike ? strikeIn(r, rows) : undefined)];
      return [read(lines)];
    },
    book([t]) {
      const terms: Term[] = [];
      const relations: Relation[] = [];
      const values: Value[] = [];
      const accounted: Accounted[] = [];
      t!.tables[0]?.rows.forEach((row, i) => {
        const id = (k: number) => `p1.t1.r${i + 1}.c${k}`;
        const cents = cited(row.cells[1]).at(-1);
        if (cents === undefined) return;
        const t = term(`t${i + 1}`, row.label, cents, row.label, id(2));
        terms.push(t);
        values.push({ target: "term", id: t.id, path: "amountCents", key: row.label, cents });
        if (cited(row.cells[0]).length) {
          relations.push({ kind: "sum", doc: DOC, result: id(2), operands: [id(1)], rate: "p1.t1.h2" });
          accounted.push({ doc: DOC, page: 1, cell: id(1), reason: "the fee before overhead" });
        }
      });
      return { terms, grids: [], relations, values, accounted };
    },
  },
  {
    name: "prose amounts",
    pages(r, strike) {
      const sentences = shuffled(r, PROSE).slice(0, 5);
      const at = strike ? Math.floor(r() * sentences.length) : -1;
      const lines = sentences.flatMap((s, i) => [`L 0.1-0.11 | ${s.replace("{a}", shown(fee(r), i === at ? fee(r) : undefined))}`, ...(i % 2 ? ["L 0.12-0.13 | The site invoices the sponsor quarterly."] : [])]);
      return [read(["L 0.02-0.03 | Article 5. Payment", ...lines])];
    },
    book([t]) {
      const terms: Term[] = [];
      const values: Value[] = [];
      t!.lines.forEach((line, i) => {
        const printed = amountsAt(line.text);
        cited(line).forEach((cents, k) => {
          // the words before the amount, without the struck value a replacement follows
          const at = printed.find((a) => a.cents === cents)!;
          const quote = line.text.slice(0, at.start).trim();
          const key = quote.replace(/\$[\d,.]+/g, "").replace(/\s+/g, " ").trim();
          const id = `t${i + 1}.${k}`;
          terms.push(term(id, key, cents, quote, `p1.l${i + 1}`));
          values.push({ target: "term", id, path: "amountCents", key, cents });
        });
      });
      return { terms, grids: [], relations: [], values };
    },
  },
];

function amountFields(t: Transcription) {
  return [
    ...t.tables.flatMap((table) => table.rows.flatMap((row, ri) => row.cells.flatMap((field, k) => (amountsOf(field.text).length ? [{ table, row: ri, k, field }] : [])))),
    ...t.lines.flatMap((field, line) => (amountsOf(field.text).length ? [{ line, field }] : [])),
  ];
}

const blank = (): Field => ({ text: "", unsure: false, marks: [] });

type Mutate = (t: Transcription, r: Rand) => boolean;

const glyph = (a: string, b: string): Mutate => (t, r) => {
  const swap = { [a]: b, [b]: a };
  const spots = amountFields(t).filter((s) => !s.field.parts && new RegExp(`[${a}${b}]`).test(s.field.text.replace(/[^\d]/g, "")));
  if (!spots.length) return false;
  const { field } = pick(r, spots);
  const digits = [...field.text].flatMap((c, i) => (c in swap ? [i] : []));
  const i = pick(r, digits);
  field.text = field.text.slice(0, i) + swap[field.text[i]!] + field.text.slice(i + 1);
  return true;
};

const rowsWithAmounts = (t: Transcription) => t.tables.flatMap((table) => table.rows.map((row, i) => ({ table, row, i })).filter((x) => x.row.cells.some((c) => amountsOf(c.text).length)));

/** One column's cell missed or one invented: every value from there on sits under its neighbour's heading. */
const shift: Mutate = (t, r) => {
  const spots = rowsWithAmounts(t);
  if (!spots.length) return false;
  const { row } = pick(r, spots);
  const n = row.cells.length;
  const k = pick(r, row.cells.flatMap((c, i) => (amountsOf(c.text).length ? [i] : [])));
  if ((k < n - 1 && r() < 0.5) || k === 0) row.cells.splice(k, 0, blank());
  else {
    row.cells.splice(k - 1, 1);
    row.cells.push(blank());
  }
  row.cells.length = n;
  return true;
};

const rowOrLine = (t: Transcription, r: Rand): { list: unknown[]; i: number } | undefined => {
  const spots = [...rowsWithAmounts(t).map((x) => ({ list: x.table.rows as unknown[], i: x.i })), ...t.lines.flatMap((l, i) => (amountsOf(l.text).length ? [{ list: t.lines as unknown[], i }] : []))];
  return spots.length ? pick(r, spots) : undefined;
};

const drop: Mutate = (t, r) => {
  const at = rowOrLine(t, r);
  return !!at && !!at.list.splice(at.i, 1);
};

const duplicate: Mutate = (t, r) => {
  const at = rowOrLine(t, r);
  if (!at) return false;
  at.list.splice(at.i + 1, 0, structuredClone(at.list[at.i]));
  return true;
};

/** The reader misses the strike and the handwriting, and keeps only the printed value. */
const unstrike: Mutate = (t) => {
  const fields = [...t.tables.flatMap((table) => table.rows.flatMap((row) => row.cells)), ...t.lines];
  const field = fields.find((f) => f.marks.includes("struck_out"));
  if (!field) return false;
  const kept = field.parts?.filter((p) => p.marks.includes("struck_out")).map((p) => p.text).join(" ") ?? field.text;
  Object.assign(field, { text: kept, unsure: false, marks: [] });
  delete field.parts;
  return true;
};

/** A value lands on the row above or below its own. */
const slip: Mutate = (t, r) => {
  const moves = [
    ...t.tables.flatMap((table) =>
      table.rows.flatMap((row, i) =>
        row.cells.flatMap((field, k) =>
          !amountsOf(field.text).length || field.parts
            ? []
            : [table.rows[i - 1], table.rows[i + 1]].flatMap((to) =>
                to
                  ? [() => {
                      while (to.cells.length <= k) to.cells.push(blank());
                      to.cells[k] = { ...field };
                      row.cells[k] = blank();
                    }]
                  : [],
              ),
        ),
      ),
    ),
    ...t.lines.flatMap((line, i) => {
      const amount = amountsAt(line.text)[0];
      if (!amount || line.parts) return [];
      return [t.lines[i - 1], t.lines[i + 1]].flatMap((to) =>
        to
          ? [() => {
              line.text = (line.text.slice(0, amount.start) + line.text.slice(amount.end)).replace(/\s+/g, " ").trim();
              to.text = `${to.text} ${amount.text}`;
            }]
          : [],
      );
    }),
  ];
  if (!moves.length) return false;
  pick(r, moves)();
  return true;
};

const MUTATIONS: Record<string, Mutate> = {
  "glyph 3<->8": glyph("3", "8"),
  "glyph 1<->7": glyph("1", "7"),
  "shifted one column": shift,
  "dropped row": drop,
  "duplicated row": duplicate,
  "struck mark removed": unstrike,
  "row slip": slip,
};

const NO_CALLS: Reader = {
  model: "openai-x",
  price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
  ask: () => Promise.reject(new Error("the mutation test makes no model calls")),
};

function docOf(first: Transcription[]): LoadedDoc {
  const pages = first.map((_, i) => buildPage(i + 1, [], "image"));
  const saved: ScanPage[] = first.map((transcription, i) => ({ page: i + 1, version: "test", rotation: 0, transcription }));
  return withScans({ name: DOC, path: DOC, sha256: "mutation", pages }, saved);
}

/** The second read comes from the store, as on a re-run, so nothing is rendered or paid for. */
function storeOf(second: Transcription[]): ScanStore {
  const pages: ScanPage[] = second.map((transcription, i) => ({ page: i + 1, version: verifyVersion(NO_CALLS), rotation: 0, transcription }));
  const verify: ScanStore = { get: () => Promise.resolve(pages), put: () => Promise.resolve() };
  return { get: () => Promise.resolve([]), put: () => Promise.resolve(), verify };
}

const rulebookOf = (book: Book): Rulebook => ({
  study: {
    protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null,
    documents: [{ doc: DOC, role: "budget", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null }],
  },
  terms: book.terms, grids: book.grids, accounted: book.accounted ?? [], questions: [], relations: book.relations,
});

type Proof = "reads" | "relation" | "totals";

/** What a value ends up resting on besides the first read: the second read, a relation, or the grid's printed totals. */
function proofOf(rulebook: Rulebook, docs: LoadedDoc[], v: Value): Proof | null {
  if (v.target === "term") {
    const evidence = withRelationProof(rulebook, docs).terms.find((t) => t.id === v.id)!.evidence;
    return evidence === "two_reads" ? "reads" : evidence === "math" ? "relation" : null;
  }
  const g = rulebook.grids.find((x) => x.id === v.id)!;
  const cell = /^rows\.(\d+)\.cells\.(\d+)$/.exec(v.path);
  const at = (u: { row: number; col: number }) => u.row === Number(cell?.[1]) && u.col === Number(cell?.[2]);
  if (cell && g.cellsReadTwice.some(([row, col]) => at({ row, col }))) return "reads";
  const result = checks.runChecks(rulebook, docs).grids[g.id]!;
  return !result.problems.length && !(cell && result.unproven.some(at)) ? "totals" : null;
}

/**
 * Whether the draft is stuck: a person answers every open question with its first option, as the answer route applies it,
 * and it still can't be approved with nothing left to answer. Which option is picked doesn't matter here, only that some
 * answer always leads on.
 */
function deadEnd(start: Rulebook, docs: LoadedDoc[], compiled: Rulebook): boolean {
  // what the compile agent's own book left is its to fix before it finishes, not a person's
  const agents = new Set(checks.runChecks(compiled, docs).problems.filter((p) => !p.afterCompile).map((p) => p.message));
  const withRequired = (rb: Rulebook) => {
    const known = new Set(rb.questions.map((q) => q.id));
    const report = checks.runChecks(rb, docs);
    const asked = (g: Grid) => rb.questions.some((q) => q.state === "open" && q.about?.target === "grid" && q.about.id === g.id);
    const printed = rb.grids.filter((g) => report.grids[g.id]?.problems.length && printsTotals(g) && !checks.checkGrid({ ...g, acceptedAsPrinted: true }, docs).problems.length && !asked(g));
    return { ...rb, questions: [...rb.questions, ...report.required.filter((q) => !known.has(q.id)), ...printed.map((g) => asPrintedQuestion(g, `read:${g.id}:printed${rb.questions.length}`, "", report.grids[g.id]!.problems))] };
  };
  let rb = withRequired(start);
  for (let n = 0; n < 100; n++) {
    const q = rb.questions.find((x) => x.state === "open" && x.blocking && x.options.length);
    if (!q) break;
    const chosen = q.options[0]!;
    const dropped = citationPatches(rb, chosen.patches);
    const patched = applyPatches(rb, [...chosen.patches, ...cellProofPatches(rb, chosen.patches), ...dropped]);
    const touched = new Set(chosen.patches.filter((p) => p.target === "term").map((p) => p.id));
    rb = withRequired({
      ...patched,
      accounted: [...patched.accounted, ...correctedCells(rb, dropped)],
      terms: patched.terms.map((t) => (touched.has(t.id) ? { ...t, evidence: "person" as const } : t)),
      questions: patched.questions.map((x) => (x.id === q.id ? { ...x, state: "answered" as const } : x)),
    });
  }
  return checks.runChecks(rb, docs).problems.some((p) => !agents.has(p.message)) || rb.questions.some((q) => q.state === "open" && q.blocking);
}

interface Tally {
  trials: number;
  pages: number;
  /** Values the rulebook took wrong from the first read. */
  cited: number;
  /** Values still wrong after the resolver. */
  wrong: number;
  /** Wrong values that end proven, by what proves them: the gate is none. */
  proven: Record<Proof, number>;
  questions: number;
  /** Questions the same pages raise when neither read is misread. */
  baseline: number;
  /** Printed values the rulebook lost with the first read, and of those, the ones in a trial that raised no question at all. */
  lost: number;
  unnoticed: number;
  /** Lost values coverage doesn't list as missing, as an amount only the second read found. */
  unflagged: number;
  /** Drafts that answering every question still leaves unapprovable. */
  stuck: number;
}

async function trial(t: Tally, shape: Shape, mutation: string | null, seed: number, misread: "first" | "second") {
  const r = random(seed);
  const truth = shape.pages(r, mutation === "struck mark removed");
  const mutated = structuredClone(truth);
  if (mutation && !shuffled(r, mutated).some((page) => MUTATIONS[mutation]!(page, r))) return;
  const [first, second] = misread === "first" ? [mutated, truth] : [truth, mutated];

  const truthOf = new Map(shape.book(truth).values.map((v) => [v.key, v.cents]));
  const book = shape.book(first);
  const docs = [docOf(first)];
  const before = withRelationProof(rulebookOf(book), docs);
  expect(checks.runChecks(before, docs).problems.filter((p) => p.check === "cell")).toEqual([]);
  const settle = async (rulebook: Rulebook, pages: Transcription[], read2: Transcription[]) => {
    const scanned = [docOf(pages)];
    const out = await resolve(rulebook, scanned, checks.runChecks(rulebook, scanned), { claude: NO_CALLS, openai: NO_CALLS, budget: { limit: 3, spent: 0 }, scans: storeOf(read2) });
    return { out, scanned, questions: out.rulebook.questions.filter((q) => q.state === "open").length };
  };
  const { out, scanned, questions } = await settle(before, first, second);
  const baseline = (await settle(withRelationProof(rulebookOf(shape.book(truth)), [docOf(truth)]), truth, truth)).questions;

  t.trials++;
  t.pages += truth.length;
  t.questions += questions;
  t.baseline += baseline;
  const kept = new Set(book.values.map((v) => v.key));
  const lost = [...truthOf.keys()].filter((key) => !kept.has(key));
  const flagged = coverage(out.rulebook, scanned).pages.flatMap((p) => p.amounts.filter((a) => a.status === "missing" && a.reason?.startsWith("a second read")).map((a) => a.cents));
  t.lost += lost.length;
  if (!questions) t.unnoticed += lost.length;
  t.unflagged += lost.filter((key) => !flagged.includes(Math.abs(truthOf.get(key)!))).length;
  if (deadEnd(out.rulebook, scanned, before)) {
    t.stuck++;
    if (process.env.DEBUG_STUCK) console.log("STUCK", shape.name, mutation, misread, seed, JSON.stringify(checks.runChecks(out.rulebook, scanned).problems.map((p) => p.message)), JSON.stringify(out.rulebook.questions.map((q) => [q.id, q.options.map((o) => o.label)])));
  }
  for (const v of book.values) {
    const right = truthOf.get(v.key);
    if (v.cents !== right) t.cited++;
    const now = v.target === "term" ? out.rulebook.terms.find((x) => x.id === v.id)!.amountCents : valueAt(out.rulebook.grids.find((g) => g.id === v.id), v.path);
    if (now === right) continue;
    t.wrong++;
    const proof = proofOf(out.rulebook, docs, v);
    if (proof) t.proven[proof]++;
  }
}

async function tally(misread: "first" | "second") {
  const rows: (Tally & { shape: string; mutation: string })[] = [];
  for (const shape of SHAPES) {
    for (const mutation of [null, ...Object.keys(MUTATIONS)]) {
      const t: Tally = { trials: 0, pages: 0, cited: 0, wrong: 0, proven: { reads: 0, relation: 0, totals: 0 }, questions: 0, baseline: 0, lost: 0, unnoticed: 0, unflagged: 0, stuck: 0 };
      for (let seed = 1; seed <= SEEDS; seed++) await trial(t, shape, mutation, seed * 7919 + shape.name.length, misread);
      rows.push({ shape: shape.name, mutation: mutation ?? "none", ...t });
    }
  }
  console.log(
    [
      `Misread in the ${misread} read (${SEEDS} seeds each; "-" where the mutation has nothing to act on)`,
      "shape | mutation | trials | pages | wrong as cited | still wrong | wrong, proven by reads / relation / totals | questions (clean-read baseline) | extra per page | values lost / with no question / not listed as possibly missed | stuck drafts",
      ...rows.map((x) =>
        [
          x.shape, x.mutation, x.trials, x.pages, x.cited, x.wrong, `${x.proven.reads} / ${x.proven.relation} / ${x.proven.totals}`, `${x.questions} (${x.baseline})`,
          x.pages ? ((x.questions - x.baseline) / x.pages).toFixed(2) : "-", `${x.lost} / ${x.unnoticed} / ${x.unflagged}`, x.stuck,
        ].join(" | "),
      ),
    ].join("\n"),
  );
  return rows;
}

const total = (rows: Tally[], of: (t: Tally) => number) => rows.reduce((n, t) => n + of(t), 0);

describe("planted misreads", () => {
  it("a misread in the first read is never proven, by the second read, a relation or the totals", { timeout: 300_000 }, async () => {
    const rows = await tally("first");
    expect(total(rows, (t) => t.trials)).toBeGreaterThan(SEEDS * 20);
    expect(total(rows, (t) => t.cited)).toBeGreaterThan(0);
    expect(total(rows.filter((x) => x.mutation === "none"), (t) => t.cited + t.wrong)).toBe(0);
    expect(total(rows, (t) => t.proven.reads + t.proven.relation + t.proven.totals)).toBe(0);
    // every scanned page with money is read twice, so whatever the first read lost is listed as possibly missed
    expect(total(rows, (t) => t.unflagged)).toBe(0);
    expect(total(rows, (t) => t.stuck)).toBe(0);
  });

  it("a misread in the second read only raises questions, fewer than one a page", { timeout: 300_000 }, async () => {
    const rows = await tally("second");
    expect(total(rows, (t) => t.wrong)).toBe(0);
    expect(total(rows, (t) => t.stuck)).toBe(0);
    const mutated = rows.filter((x) => x.mutation !== "none");
    const pages = total(mutated, (t) => t.pages);
    const perPage = total(mutated, (t) => t.questions) / pages;
    console.log(`questions per page with a misread second read: ${perPage.toFixed(2)}, of which the misread adds ${(total(mutated, (t) => t.questions - t.baseline) / pages).toFixed(2)}`);
    expect(perPage).toBeLessThan(1);
  });
});
