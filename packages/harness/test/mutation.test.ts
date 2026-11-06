import type { Cell, Grid, Relation, Rulebook, Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { checks } from "../src/checks";
import { withRelationProof } from "../src/checks/relations";
import { amountsAt, usd } from "../src/checks/text";
import type { Reader } from "../src/models/reader";
import { buildPage } from "../src/pdf/page";
import { resolve } from "../src/resolve";
import { withScans } from "../src/scan";
import { amountsOf } from "../src/scan/diff";
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
}

// the agent cites a handwritten replacement, never the value it strikes out
const cited = (f: Field | undefined) => (f ? (f.parts ? f.parts.filter((p) => !p.marks.includes("struck_out")).flatMap((p) => amountsOf(p.text)) : amountsOf(f.text)) : []);

const TOTALS = /total/i;

function gridBook(id: string, reads: Transcription[]): Book {
  const visits: string[] = [];
  const rows = new Map<string, { name: string; cells: Map<number, [number, string]> }>();
  const lines = { subtotal: new Map<number, [number, string]>(), grand: undefined as [number, string] | undefined };
  reads.forEach((t, i) => {
    const table = t.tables[0];
    if (!table) return;
    const from = visits.length;
    visits.push(...table.columns.slice(1));
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
        const entry = rows.get(key) ?? { name: row.label, cells: new Map() };
        values.forEach((v, k) => v !== null && from + k < visits.length && entry.cells.set(from + k, [v, at(k)]));
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
  const gridRows = [...rows.values()].map((row, i) => ({
    name: row.name, code: null, unitCostCents: null, printedRowTotalCents: null,
    cells: line(row.cells, (j) => `rows.${i}.cells.${j}`, (j) => `${row.name}|${visits[j]}`),
  }));
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
      t!.tables[0]?.rows.forEach((row, i) => {
        const id = (k: number) => `p1.t1.r${i + 1}.c${k}`;
        const cents = cited(row.cells[1]).at(-1);
        if (cents === undefined) return;
        const t = term(`t${i + 1}`, row.label, cents, row.label, id(2));
        terms.push(t);
        values.push({ target: "term", id: t.id, path: "amountCents", key: row.label, cents });
        if (cited(row.cells[0]).length) relations.push({ kind: "sum", doc: DOC, result: id(2), operands: [id(1)], rate: "p1.t1.h2" });
      });
      return { terms, grids: [], relations, values };
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
  terms: book.terms, grids: book.grids, accounted: [], questions: [], relations: book.relations,
});

const valueAt = (node: unknown, path: string) => path.split(".").reduce<unknown>((n, key) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[key] : undefined), node);

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
    return { out, questions: out.rulebook.questions.filter((q) => q.state === "open").length };
  };
  const { out, questions } = await settle(before, first, second);
  const baseline = (await settle(withRelationProof(rulebookOf(shape.book(truth)), [docOf(truth)]), truth, truth)).questions;

  t.trials++;
  t.pages += truth.length;
  t.questions += questions;
  t.baseline += baseline;
  const kept = new Set(book.values.map((v) => v.key));
  const lost = [...truthOf.keys()].filter((key) => !kept.has(key)).length;
  t.lost += lost;
  if (!questions) t.unnoticed += lost;
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
      const t: Tally = { trials: 0, pages: 0, cited: 0, wrong: 0, proven: { reads: 0, relation: 0, totals: 0 }, questions: 0, baseline: 0, lost: 0, unnoticed: 0 };
      for (let seed = 1; seed <= SEEDS; seed++) await trial(t, shape, mutation, seed * 7919 + shape.name.length, misread);
      rows.push({ shape: shape.name, mutation: mutation ?? "none", ...t });
    }
  }
  console.log(
    [
      `Misread in the ${misread} read (${SEEDS} seeds each; "-" where the mutation has nothing to act on)`,
      "shape | mutation | trials | pages | wrong as cited | still wrong | wrong, proven by reads / relation / totals | questions (clean-read baseline) | extra per page | values lost / with no question",
      ...rows.map((x) =>
        [
          x.shape, x.mutation, x.trials, x.pages, x.cited, x.wrong, `${x.proven.reads} / ${x.proven.relation} / ${x.proven.totals}`, `${x.questions} (${x.baseline})`,
          x.pages ? ((x.questions - x.baseline) / x.pages).toFixed(2) : "-", `${x.lost} / ${x.unnoticed}`,
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
  });

  it("a misread in the second read only raises questions, fewer than one a page", { timeout: 300_000 }, async () => {
    const rows = await tally("second");
    expect(total(rows, (t) => t.wrong)).toBe(0);
    const mutated = rows.filter((x) => x.mutation !== "none");
    const pages = total(mutated, (t) => t.pages);
    const perPage = total(mutated, (t) => t.questions) / pages;
    console.log(`questions per page with a misread second read: ${perPage.toFixed(2)}, of which the misread adds ${(total(mutated, (t) => t.questions - t.baseline) / pages).toFixed(2)}`);
    expect(perPage).toBeLessThan(1);
  });
});
