import type { PageBox, Rulebook, ValueEvidence } from "@dct/shared";
import type { RowBand } from "./binder";
import { bare, centsOf, frame, NUMBER, sentences, type Span, type TextPage, visualLines, type Word } from "./textlayer";

/**
 * The leftover-money sweep's gate (ADR-002 §1.4, the guide's Step 5): which unaccounted spans are still worth a question.
 * Pure: reads its input, returns new lists, prints nothing. Every drop keeps its reason and box, so a page can say
 * "N amounts were not asked because ...". Order: consumed (row band, then zone), insurance, explained by the master, currency cue
 * (a span is counted once). No rule keeps the sweep to grid pages: terms pages hold the holdback, the net days and the start-up
 * fees, and "there is no holdback" is found by sweeping them and finding nothing, so they stay swept (only the insurance and
 * currency-cue filters apply to them).
 */

export const SWEEP = {
  /**
   * A grid is a zone only with this many bound cells on the page. A real budget page binds dozens; one stray confirmed
   * fee must not turn its page into "consumed". 6 = two rows of three, the smallest thing a person calls a table.
   */
  minBoundCells: 6,
  /** The guide's window: a trigger word counts within this many tokens of the span, in its own sentence. */
  triggerTokens: 10,
  /** "Near a payment verb" for the insurance exclusion: a clause's own amount sits within a few words of "reimburse". */
  verbTokens: 8,
  /** The zone grows by one cell, never more than this fraction of the page (a row-wide box would otherwise swallow it). */
  maxMargin: 0.1,
  /**
   * "Explained" needs a table: this many money cells set off by column gaps on the span's line, or in its column. Three is
   * the fewest that is a row or a column and not a pair of prices in a sentence ("$50.00 or $70.00").
   */
  tableMoney: 3,
  /** Right, left or centre edges within this many points are one column (numbers are right-aligned, labels left). */
  columnPt: 2,
};

export type SweepCtx = {
  /** The binder's evidence: its `where` boxes and statuses say which cells are bound. */
  evidence: readonly ValueEvidence[];
  /** The pages `unaccounted` came from (same Word objects, so a span finds its sentence). */
  pages: readonly TextPage[];
  /** The master the read produced: what a second printing of its numbers is compared with. Absent: nothing is "explained". */
  rb?: Rulebook;
  /**
   * The drawn tables' rows the read's procedures were lined up with (`bindEvidence(...).rows`): every number inside such a row's
   * band, across the table's width, is that row's. Absent: no row band, only the zones below.
   */
  rows?: readonly RowBand[];
  /** The visits whose column adds up to a subtotal the page confirms (`solveGrids(...).report.vouched`). Absent: none is vouched for. */
  vouched?: readonly string[];
};

export type DropReason = "consumed" | "insurance_clause" | "explained_by_master" | "no_currency_cue";
/** `as`: for an explained drop, which master value the amount equals (a count per kind shows what the filter hid). */
export type Dropped = { reason: DropReason; where: PageBox; span: Span; as?: string };
/** `explainedBy`: the explained drops counted by the kind of master amount they equal. */
export type SweepReport = { consumed: number; insurance: number; explained: number; noCue: number; kept: number; explainedBy: Record<string, number> };

type B = readonly [number, number, number, number];
const EPS = 1e-6;
const pageKey = (w: { documentId: string; page: number }) => `${w.documentId}#${w.page}`;
// by string, so it works with or without `confirmed_by_math` in the type
const BOUND = new Set<string>(["confirmed", "confirmed_by_math", "attested"]);
const OPEN = new Set<string>(["conflict", "ungrounded"]);

/** The box's centre lies in the zone: a total printed half in the one-cell margin is still beside the table, not beyond it. */
const inside = (a: B, z: B) => {
  const [cx, cy] = [a[0] + a[2] / 2, a[1] + a[3] / 2];
  return cx >= z[0] - EPS && cy >= z[1] - EPS && cx <= z[0] + z[2] + EPS && cy <= z[1] + z[3] + EPS;
};
const meets = (a: B, b: B) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
/** Same printed line: their vertical extents overlap by more than half the shorter one. */
const sameLine = (a: B, b: B) => Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > Math.min(a[3], b[3]) / 2;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A bound money cell of a table: a grid's own numbers, an invoiceable's or a site fee's amounts. Header text is not one. */
const tableOf = (path: string) =>
  path.match(/^\/budgetGrids\/\d+(?=\/(?:procedures|visits|perPatientTotals)\/)/)?.[0] ?? path.match(/^\/(?:invoiceables|siteFees)(?=\/\d+\/amount)/)?.[0];

type Zone = { box: B; cells: B[] };

/** At least two printed lines each hold two cells in different columns: a table, not fee sentences scattered down a page. */
function tabular(cells: B[]) {
  const rows: B[][] = [];
  for (const c of [...cells].sort((a, b) => a[1] + a[3] / 2 - (b[1] + b[3] / 2))) {
    const row = rows.at(-1);
    if (row && sameLine(row[0]!, c)) row.push(c);
    else rows.push([c]);
  }
  return rows.filter((r) => new Set(r.map((c) => c[0].toFixed(3))).size >= 2).length >= 2;
}

/**
 * One zone per bound table on a page: the union of its bound cells, grown by one cell (the median cell's width and
 * height) so the row of totals or the column the read left out, printed right beside the table, is inside too. One
 * cell, not more: narrative text below a table starts a blank line or more away. Only `confirmed`, `confirmed_by_math`
 * and `attested` cells count; a conflict or a missing value binds nothing.
 */
function zonesOf(evidence: readonly ValueEvidence[]) {
  const groups = new Map<string, { paths: Set<string>; cells: B[]; page: string }>();
  for (const e of evidence) {
    const t = BOUND.has(e.status) ? tableOf(e.path) : undefined;
    if (!t) continue;
    for (const w of e.where) {
      if (!w.box) continue;
      const g = groups.get(`${pageKey(w)}|${t}`) ?? { paths: new Set<string>(), cells: [], page: pageKey(w) };
      g.paths.add(e.path);
      g.cells.push(w.box);
      groups.set(`${pageKey(w)}|${t}`, g);
    }
  }
  const out = new Map<string, Zone[]>();
  for (const g of groups.values()) {
    if (g.paths.size < SWEEP.minBoundCells || !tabular(g.cells)) continue;
    const mx = Math.min(median(g.cells.map((c) => c[2])), SWEEP.maxMargin);
    const my = Math.min(median(g.cells.map((c) => c[3])), SWEEP.maxMargin);
    const x0 = Math.min(...g.cells.map((c) => c[0])) - mx;
    const y0 = Math.min(...g.cells.map((c) => c[1])) - my;
    const x1 = Math.max(...g.cells.map((c) => c[0] + c[2])) + mx;
    const y1 = Math.max(...g.cells.map((c) => c[1] + c[3])) + my;
    out.set(g.page, [...(out.get(g.page) ?? []), { box: [x0, y0, x1 - x0, y1 - y0], cells: g.cells }]);
  }
  return out;
}

// Duplicated from the inventory's KEYWORDS (textlayer.ts keeps them private) plus the guide's own triggers.
const TRIGGER = /\b(?:pay|paid|invoic|fees?\b|cost|reimburs|overhead|indirect|f\s?&\s?a\b|holdback|hold back|withh|retain|refund|offset|interest|late\b|caps?\b|capped|maximum|not to exceed|escalat|increas|stipend|screen[\s-]?fail|terminat|budget|compensat|start[\s-]?up|per chart|per mile)/i;
const INSURANCE = /(?:commercial general liability|insurance|per occurrence|annual aggregate|indemnif)/i;
/**
 * Words that move money: the fee clause that merely mentions insurance ("Sponsor will reimburse the premium, up to
 * $5,000") has one next to its amount, and an insurance LIMIT ("$1,000,000 per occurrence") never does. "withhold",
 * "holdback", "refund", "offset" and "deduct" are added to the four named because each is a payment too.
 */
const MOVES_MONEY = /\b(?:reimburs|pay|paid|fee|invoic|withh|holdback|hold back|refund|offset|deduct)/i;
/** A currency mark printed with the amount ($, US$, USD). */
const MARKED = /\$|\bUSD\b/i;

/** The span's own sentence as tokens, and where the span sits in it; found by word identity, else from the span's stored text. */
function context(span: Span, bySentence: Map<Word, Word[]>) {
  const s = bySentence.get(span.words[0]!);
  if (s) return { tokens: s.map((w) => w.text), from: s.indexOf(span.words[0]!), to: s.indexOf(span.words.at(-1)!) };
  const tokens = span.text.split(/\s+/);
  const from = Math.max(0, tokens.indexOf(span.words[0]!.text));
  return { tokens, from, to: from + span.words.length - 1 };
}

/** Does `re` match the `n` tokens either side of the span (its own words left out)? An absence span is the whole sentence. */
function within(re: RegExp, c: ReturnType<typeof context>, span: Span, n: number) {
  if (span.kind === "absence") return re.test(c.tokens.join(" "));
  return re.test(`${c.tokens.slice(Math.max(0, c.from - n), c.from).join(" ")} | ${c.tokens.slice(c.to + 1, c.to + 1 + n).join(" ")}`);
}

// ---------- explained by the master ----------

/**
 * Every amount the master holds, by what it is. A summary table, a Totals column or a second printing of the grid
 * prints these again; nothing else counts: a cap's limit, a holdback's base or a figure in prose is never in the set.
 * The first kind to claim a cent value names it. Percent prices are rounded both ways, as printed figures are.
 */
export function masterAmounts(rb: Rulebook): Map<number, string> {
  const m = new Map<number, string>();
  const add = (c: number | null | undefined, as: string) => {
    if (typeof c === "number" && !m.has(c)) m.set(c, as);
  };
  for (const g of rb.budgetGrids) {
    // integer basis points, so a stated 32.5% is never a float product
    const pct = g.statedOverheadPct ?? rb.overhead.pct.value;
    const bp = typeof pct === "number" ? Math.round(pct * 100) : null;
    const sums = new Map<string, { procedure: number; non: number }>();
    for (const p of g.procedures) {
      add(p.unitCents, "unit_price");
      if (p.overheadApplied && bp !== null && p.unitCents !== null) {
        add(Math.floor((p.unitCents * (10000 + bp)) / 10000), "unit_price_with_overhead");
        add(Math.ceil((p.unitCents * (10000 + bp)) / 10000), "unit_price_with_overhead");
      }
      let row = 0;
      for (const [visit, c] of Object.entries(p.cells)) {
        if (typeof c !== "number") continue;
        add(c, "grid_cell");
        row += c;
        const v = sums.get(visit) ?? { procedure: 0, non: 0 };
        v[p.category === "procedure" ? "procedure" : "non"] += c;
        sums.set(visit, v);
      }
      add(row, "row_sum");
    }
    for (const v of sums.values()) {
      add(v.procedure, "visit_sum");
      add(v.non, "visit_sum");
      add(v.procedure + v.non, "visit_sum");
    }
    for (const v of g.visits) for (const c of [v.procedureSubtotalCents, v.overheadCents, v.nonProcedureCents, v.totalCents]) add(c, "visit_total");
    for (const t of g.perPatientTotals) add(t.cents, "patient_total");
    add(g.visits.reduce((n, v) => n + v.totalCents, 0), "patient_total");
  }
  for (const x of rb.invoiceables) (add(x.amountCents, "fee_table"), add(x.amountWithOverheadCents, "fee_table"));
  for (const x of rb.siteFees) add(x.amountCents, "fee_table");
  add(rb.screenFail?.amountCents, "fee_table");
  return m;
}

/** The master's own names: a table line may be labelled with these, or with the words a printed sum is labelled with. */
function knownWords(rb: Rulebook) {
  const out = new Set(["per", "and", "the", "for", "with", "without", "each", "usd", "total", "subtotal", "sum", "overhead", "visit", "visits", "patient", "subject", "price", "unit", "amount", "procedure", "procedures", "non", "indirect", "cost", "costs"]);
  const take = (s: string | null | undefined) => (s ?? "").toLowerCase().match(/[a-z]{3,}/g)?.forEach((w) => out.add(w));
  for (const g of rb.budgetGrids) {
    take(g.label);
    g.procedures.forEach((p) => (take(p.name), take(p.code)));
    g.visits.forEach((v) => take(v.name));
    g.perPatientTotals.forEach((t) => take(t.label));
  }
  [...rb.invoiceables, ...rb.siteFees].forEach((x) => (take(x.name), take(x.code)));
  return out;
}

/**
 * Words that move money. Not "overhead", "cost" or "total": those label the rows of a summary table, which is the very
 * thing this filter is for. A table line with one of these ("Start-up fee   1,200.00   1,200.00   1,200.00") is a fee
 * and stays asked, whatever it equals.
 */
const PAYS = /\b(?:fee|pay|paid|reimburs|invoic|withh|holdback|hold back|retain|refund|offset|deduct|credit|penalt|interest|late\b|caps?\b|capped|maximum|not to exceed|stipend|start[\s-]?up|per chart|per mile)/i;
/** A printed amount: a currency sign, cents, or a thousands comma. A bare integer (a quantity, a count) is not one. */
const isMoney = (w: Word) => NUMBER.test(bare(w.text)) && /\$|\.\d{2}\b|\d,\d{3}/.test(w.text);
/** The span's cents: an amount carries them; a bare table number is read as the contract's amounts are (centsOf). */
const centsFor = (s: Span) => s.cents ?? centsOf(bare(s.words.map((w) => w.text).join("")));

type Layout = { line: Map<Word, Word[]>; money: Word[]; setOff: (w: Word) => boolean };
/** A page's lines (as the inventory reads rows) and the money cells that are set off by a column gap, as a table's cells are. */
function layout(p: TextPage): Layout {
  const line = new Map<Word, Word[]>();
  const money: Word[] = [];
  const setOff = (w: Word) => {
    const l = line.get(w)!;
    const i = l.indexOf(w);
    return i === 0 || frame(w)[0] - frame(l[i - 1]!)[2] >= frame(w)[3] - frame(w)[1];
  };
  for (const l of visualLines(p.words.filter((w) => !w.hidden))) for (const w of l) line.set(w, l);
  for (const w of line.keys()) if (isMoney(w) && setOff(w)) money.push(w);
  return { line, money, setOff };
}

/**
 * Printed in a table, never in prose: set off by a column gap, and either its line holds `tableMoney` such cells (a row,
 * a Totals strip) or `tableMoney` more sit in its column on other lines (a column the read has no row for). Prose that
 * runs three prices together ("$500.00, $750.00 and $1,000.00") has no column gaps, so it is not a table.
 */
function tableLike(w: Word, lay: Layout) {
  if (!lay.setOff(w)) return false;
  const l = lay.line.get(w)!;
  if (new Set([w, ...lay.money.filter((x) => lay.line.get(x) === l)]).size >= SWEEP.tableMoney) return true;
  const [f, tol] = [frame(w), SWEEP.columnPt];
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  return lay.money.filter((x) => x.dir === w.dir && lay.line.get(x) !== l && ((g) => near(g[2], f[2]) || near(g[0], f[0]) || near(g[0] + g[2], f[0] + f[2]))(frame(x))).length >= SWEEP.tableMoney;
}

/**
 * Which master value this table amount repeats, or undefined: it must be printed in a table (`tableLike`), on a line with no
 * word that moves money, whose label words (if any) are all the master's own names or a sum's labels (so a row the read
 * missed, "Unbilled ECG   75.00   75.00   75.00", is not explained by another row that happens to cost the same), and
 * equal a master amount to the cent.
 */
function explained(span: Span, page: TextPage, master: { amounts: Map<number, string>; words: Set<string> }, layouts: Map<string, Layout>) {
  const cents = centsFor(span);
  const as = cents === null ? undefined : master.amounts.get(cents);
  if (!as) return undefined;
  const lay = layouts.get(`${page.documentId}#${page.page}`) ?? layout(page);
  layouts.set(`${page.documentId}#${page.page}`, lay);
  const w = span.words[0]!;
  const line = lay.line.get(w);
  if (!line || !tableLike(w, lay) || PAYS.test(line.map((x) => x.text).join(" "))) return undefined;
  const label = line.map((x) => x.text.toLowerCase()).filter((t) => !/\d/.test(t)).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= 3);
  return label.every((t) => master.words.has(t)) ? as : undefined;
}

/**
 * The senior engineer's overhead pair, label-independent: a table line printing two amounts where the larger is the smaller plus
 * the overhead % (to a cent either way, or to the dollar where the line prints whole dollars), and both are amounts the master
 * holds, is that master row printed again, whatever its (possibly garbled) label says. The label rule of `explained` is skipped;
 * the money-word rule stays.
 */
function pairExplained(span: Span, page: TextPage, master: { amounts: Map<number, string> }, rates: number[], layouts: Map<string, Layout>) {
  const cents = centsFor(span);
  if (cents === null || !rates.length) return false;
  const lay = layouts.get(`${page.documentId}#${page.page}`) ?? layout(page);
  layouts.set(`${page.documentId}#${page.page}`, lay);
  const w = span.words[0]!;
  const line = lay.line.get(w);
  if (!line || !tableLike(w, lay) || PAYS.test(line.map((x) => x.text).join(" "))) return false;
  const amounts = [...new Set(lay.money.filter((x) => lay.line.get(x) === line).flatMap((x) => centsOf(bare(x.text)) ?? []))];
  return amounts.some((lo) => amounts.some((hi) => (lo === cents || hi === cents) && hi > lo && master.amounts.has(lo) && master.amounts.has(hi) && rates.some((bp) => {
    const exact = (lo * (10000 + bp)) / 10000;
    return Math.abs(exact - hi) <= 5 || (hi % 100 === 0 && lo % 100 === 0 && Math.abs(exact - hi) <= 100);
  })));
}

/** A price as opposed to a visit number in a header: a sign, cents, a thousands comma, or three digits or more. */
const priceLike = (s: Span) => s.words.some((w) => /[$]|\.\d{2}\b|\d,\d{3}|\d{3}/.test(w.text));

/**
 * Splits the binder's unaccounted spans into those still asked (`kept`) and those not, each with its reason.
 *
 * 0. consumed by row band (ADR-002, the senior engineer's structural rule): once a drawn table's row is lined up with a rulebook
 *    row (`ctx.rows`, from the binder's own table geometry), every amount or table number whose centre is in that row's band,
 *    across the table's width, is consumed, even where the row's label was garbled. Kept anyway: a price in a visit cell the
 *    read has no entry for in that row (it may be a column the read missed), unless that visit's column adds up to a printed
 *    subtotal the page confirms (`ctx.vouched`). A band is the whole story for its row only: a row of the table no rulebook row
 *    took, a number outside the table (a footnote, a cap printed under it) and every row the label path placed (no drawn
 *    table, no geometry) go through the rules below.
 * 1. consumed: an amount or table number whose centre is inside a bound table's zone (`zonesOf`) and that overlaps a bound
 *    entry's own spot is that table's cell; so is a bare number that prints no price (a visit number in a header, a margin
 *    number). A price no entry claims is kept, even on a line full of bound cells: a column or row the read missed is
 *    exactly what the sweep is for. Kept too when it overlaps a conflicting or missing value's spot (that value is asked,
 *    with its printed amounts). Percentages, days and "up to N" figures are never consumed: they aren't cells.
 * 2. insurance_clause: the span's OWN sentence names insurance, liability limits or indemnity, and no word that moves
 *    money is within `verbTokens` of the span. A neighbouring sentence or bullet never excludes it.
 * 3. explained_by_master: an amount or table number in a table (`tableLike`), on a line with no fee or payment word and no
 *    name the master doesn't know, whose cents equal an amount the master holds (`masterAmounts`): a summary table or a
 *    Totals column printing the grid again. Never prose: a fee clause that equals a cell's price is asked. Residual risk:
 *    a different fee in a table that equals a master value to the cent, under a label made of known words, is hidden.
 * 4. no_currency_cue: only on a narrative page (a text or OCR page with no zone and no ruled table), and only for a
 *    span without a currency mark: dropped unless a trigger word is within `triggerTokens`. Amounts with a mark always stay.
 */
export function gateSweep(unaccounted: readonly Span[], ctx: SweepCtx): { kept: Span[]; dropped: Dropped[]; report: SweepReport } {
  const zones = zonesOf(ctx.evidence);
  const open = new Map<string, B[]>();
  // the spots some bound entry claims: a printed price nobody claims is never "consumed", wherever it sits
  const claimed = new Map<string, B[]>();
  for (const e of ctx.evidence) {
    const into = OPEN.has(e.status) ? open : BOUND.has(e.status) ? claimed : null;
    if (into) for (const w of e.where) if (w.box) into.set(pageKey(w), [...(into.get(pageKey(w)) ?? []), w.box]);
  }
  const pages = new Map(ctx.pages.map((p) => [pageKey(p), p]));
  const bySentence = new Map<Word, Word[]>();
  for (const p of ctx.pages) for (const s of sentences(p)) for (const w of s) bySentence.set(w, s);

  const kept: Span[] = [];
  const dropped: Dropped[] = [];
  const report: SweepReport = { consumed: 0, insurance: 0, explained: 0, noCue: 0, kept: 0, explainedBy: {} };
  const drop = (reason: DropReason, span: Span, counter: "consumed" | "insurance" | "explained" | "noCue", as?: string) => {
    dropped.push({ reason, where: span.where, span, ...(as ? { as } : {}) });
    report[counter]++;
    if (as) report.explainedBy[as] = (report.explainedBy[as] ?? 0) + 1;
  };
  const master = ctx.rb ? { amounts: masterAmounts(ctx.rb), words: knownWords(ctx.rb) } : null;
  const layouts = new Map<string, Layout>();
  // overhead rates in basis points: the contract's and each grid's own
  const rates = ctx.rb ? [...new Set([ctx.rb.overhead.pct.value, ...ctx.rb.budgetGrids.map((g) => g.statedOverheadPct)].flatMap((x) => (typeof x === "number" && x > 0 ? [Math.round(x * 100)] : [])))] : [];

  // the senior engineer's two table rules. (1) The inside of a table: a number whose centre is in a mapped table's box and in a
  // visit column whose printed subtotal the page backs (`vouched`) can't be a missing price, the column would no longer add up.
  // (2) Counting: the page prints amount P K times and the read holds K values equal to P that cite that page, so every printing
  // is accounted for, a garbled label or a misread digit elsewhere notwithstanding.
  const tables = new Map<string, { box: B; cols: [number, number][] }[]>();
  {
    const per = new Map<string, { box: [number, number, number, number]; cols: [number, number][] }>();
    for (const r of ctx.rows ?? []) {
      const k = `${pageKey(r)}|${r.grid}`;
      const t = per.get(k) ?? { box: [1, 1, 0, 0] as [number, number, number, number], cols: [] };
      t.box = [Math.min(t.box[0], r.box[0]), Math.min(t.box[1], r.box[1]), Math.max(t.box[2], r.box[0] + r.box[2]), Math.max(t.box[3], r.box[1] + r.box[3])];
      for (const c of r.cells) {
        const vi = ctx.rb?.budgetGrids[r.grid]?.visits.findIndex((v) => v.code === c.visit) ?? -1;
        if (vi >= 0 && (ctx.vouched ?? []).includes(`/budgetGrids/${r.grid}/visits/${vi}`) && !t.cols.some(([a]) => Math.abs(a - c.box[0]) < 1e-4)) t.cols.push([c.box[0], c.box[0] + c.box[2]]);
      }
      per.set(k, t);
    }
    for (const [k, t] of per) tables.set(k.split("|")[0]!, [...(tables.get(k.split("|")[0]!) ?? []), { box: [t.box[0], t.box[1], t.box[2] - t.box[0], t.box[3] - t.box[1]] as unknown as B, cols: t.cols }]);
  }
  const centsAtPage = (path: string) => {
    const v = path.split("/").slice(1).reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], ctx.rb);
    return typeof v === "number" ? v : null;
  };
  const held = new Map<string, number>();
  for (const e of ctx.evidence) {
    if (!/Cents$|\/cents$|\/cells\//.test(e.path)) continue;
    const v = centsAtPage(e.path);
    if (v === null) continue;
    for (const k of new Set(e.where.map(pageKey))) held.set(`${k}|${v}`, (held.get(`${k}|${v}`) ?? 0) + 1);
  }
  const printed = new Map<string, number>();
  for (const p of ctx.pages) for (const w of p.words) if (!w.hidden && isMoney(w)) {
    const c = centsOf(bare(w.text));
    if (c !== null) printed.set(`${pageKey(p)}|${c}`, (printed.get(`${pageKey(p)}|${c}`) ?? 0) + 1);
  }

  // the mapped rows' bands by page, and whether a visit cell of one has no entry in the read (a column the read missed in that row)
  const bands = new Map<string, RowBand[]>();
  for (const r of ctx.rows ?? []) bands.set(pageKey(r), [...(bands.get(pageKey(r)) ?? []), r]);
  const paths = new Set(ctx.evidence.map((e) => e.path));
  const vouched = new Set(ctx.vouched ?? []);
  /** A price in a visit cell the read gave this row no value for, in a column no printed subtotal vouches for: the price may be a missed one. */
  const missed = (r: RowBand, b: B) => {
    const cell = r.cells.find((c) => inside(b, c.box));
    if (!cell || paths.has(`/budgetGrids/${r.grid}/procedures/${r.procedure}/cells/${ptr(cell.visit)}`)) return false;
    const vi = ctx.rb?.budgetGrids[r.grid]?.visits.findIndex((v) => v.code === cell.visit) ?? -1;
    return vi < 0 || !vouched.has(`/budgetGrids/${r.grid}/visits/${vi}`);
  };

  for (const span of unaccounted) {
    const key = pageKey(span.where);
    const b = span.where.box;
    const here = zones.get(key) ?? [];

    // Inside a mapped row's band, across the table's width, every number is that row's (its code, count, unit price, a printed
    // total, a price whose cell the read has an entry for), even where the row's label was garbled. What stays asked: a price in a
    // visit cell the read has no value for, unless that visit's column adds up without it.
    const rowBand = b && (span.kind === "amount" || span.kind === "grid_number") ? (bands.get(key) ?? []).find((r) => inside(b, r.box)) : undefined;
    if (rowBand && b && !missed(rowBand, b)) {
      drop("consumed", span, "consumed");
      continue;
    }

    const zone = b && (span.kind === "amount" || span.kind === "grid_number") ? here.find((z) => inside(b, z.box)) : undefined;
    if (zone && b && !(open.get(key) ?? []).some((o) => meets(b, o)) && ((claimed.get(key) ?? []).some((c) => meets(b, c)) || !priceLike(span))) {
      drop("consumed", span, "consumed");
      continue;
    }

    // (1) inside a mapped table, in a visit column the page's own subtotal vouches for
    if (b && (span.kind === "amount" || span.kind === "grid_number") && !(open.get(key) ?? []).some((o) => meets(b, o))) {
      const [cx, cy] = [b[0] + b[2] / 2, b[1] + b[3] / 2];
      if ((tables.get(key) ?? []).some((t) => cy >= t.box[1] && cy <= t.box[1] + t.box[3] && t.cols.some(([x0, x1]) => cx >= x0 && cx <= x1))) {
        drop("explained_by_master", span, "explained", "column_vouched");
        continue;
      }
    }
    // (2) every printing of this amount on the page is one of the read's values that cite the page
    const cents = span.kind === "amount" || span.kind === "grid_number" ? centsFor(span) : null;
    if (cents !== null && (held.get(`${key}|${cents}`) ?? 0) >= (printed.get(`${key}|${cents}`) ?? Infinity) && !(b && (open.get(key) ?? []).some((o) => meets(b, o)))) {
      drop("explained_by_master", span, "explained", "price_count");
      continue;
    }

    const c = context(span, bySentence);
    if (INSURANCE.test(c.tokens.join(" ")) && !within(MOVES_MONEY, c, span, SWEEP.verbTokens)) {
      drop("insurance_clause", span, "insurance");
      continue;
    }

    const page = pages.get(key);
    const as =
      master && page && b && (span.kind === "amount" || span.kind === "grid_number") && !(open.get(key) ?? []).some((o) => meets(b, o))
        ? explained(span, page, master, layouts) ?? (pairExplained(span, page, master, rates, layouts) ? "overhead_pair" : undefined)
        : undefined;
    if (as) {
      drop("explained_by_master", span, "explained", as);
      continue;
    }

    const narrative = !!page && (page.source === "text" || page.source === "ocr") && !here.length && !page.grids?.length;
    if (narrative && span.kind !== "absence" && !MARKED.test(span.words.map((w) => w.text).join(" ")) && !within(TRIGGER, c, span, SWEEP.triggerTokens)) {
      drop("no_currency_cue", span, "noCue");
      continue;
    }

    kept.push(span);
    report.kept++;
  }
  return { kept, dropped, report };
}
