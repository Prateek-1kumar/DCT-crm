import { type BudgetGrid, parseCents, parsePercent, type Provenance } from "@dct/shared";
import { type TextPage, visualLines, type Word } from "./textlayer";

/**
 * Budget grids read by code from a PDF's own text (ADR-003 P2): no model reads a digit. Columns come from where the
 * numbers sit, their names from the header words above them; a row's cells are the numbers in the visit columns of its
 * line. Nothing here trusts the layout: a grid is kept only when the contract's own arithmetic closes on it (`closes`):
 * each row's quantity × unit price is its cells added up, each visit's cells add up to the subtotal it prints, its
 * subtotals and overhead to its total, and the visit totals to the per-patient total. A table it can't place, or whose
 * sums don't close, is left to the model's read, so a layout this doesn't know fails loudly, never silently.
 * ponytail: dir-0 text only, one header band per block, a summary row named in words. Upgrade: rotated grids, arms.
 */

type W = Word & { cx: number; cy: number };
type Line = { y: number; words: W[]; nums: W[] };
type Col = { x0: number; x1: number; c: number; label: string };
export type Role = "code" | "qty" | "unit" | "visit" | "total" | "other";
type Block = { cols: Col[]; roles: Role[]; oh: number | null; section: "procedure" | "non_procedure"; lines: Line[]; page: TextPage; title: string };

export type TextGrid = {
  grid: BudgetGrid;
  /** Each procedure's printed quantity, in procedure order (null where the table has no quantity column). */
  qty: (number | null)[];
  /** The identities checked and the ones that failed, in words for a log: never contract text. */
  checked: number;
  failed: string[];
};

const NUM = /^\(?\$?\d[\d,]*(?:\.\d+)?\)?$/;
const isNum = (w: Word) => NUM.test(w.text) && parseCents(w.text) !== null;
const centre = (w: Word): W => ({ ...w, cx: (w.rect[0] + w.rect[2]) / 2, cy: (w.rect[1] + w.rect[3]) / 2 });
const height = (l: Line) => Math.max(...l.words.map((w) => w.rect[3] - w.rect[1]));
const text = (ws: W[]) => ws.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
const inCol = (w: W, c: Col, slack: number) => w.cx >= c.x0 - slack && w.cx <= c.x1 + slack;

/** Numeric columns of a page: the x-centres of its numbers, split wherever the gap is wider than half a typical column step. */
function columnsOf(data: Line[]): { cols: Col[]; slack: number } {
  const steps = data.flatMap((l) => l.nums.slice(1).map((w, i) => w.cx - l.nums[i]!.cx)).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length * 0.2)] ?? 20;
  const slack = step / 2;
  const xs = data.flatMap((l) => l.nums).sort((a, b) => a.cx - b.cx);
  const cols: Col[] = [];
  for (const w of xs) {
    const last = cols.at(-1);
    if (last && w.cx - last.c <= slack) Object.assign(last, { x0: Math.min(last.x0, w.rect[0]), x1: Math.max(last.x1, w.rect[2]), c: (last.c + w.cx) / 2 });
    else cols.push({ x0: w.rect[0], x1: w.rect[2], c: w.cx, label: "" });
  }
  return { cols, slack };
}

const role = (label: string): Role =>
  /^(?:code|cpt|item|#)\b/i.test(label) ? "code"
  : /\b(?:qty|quantity)\b/i.test(label) ? "qty"
  : /\btotal\b|with\s*oh|with\s*overhead/i.test(label) ? "total"
  : /\b(?:budget|unit|price|cost|fee|rate|amount)\b/i.test(label) ? "unit"
  : label ? "visit" : "other";

/**
 * A header band: a line with no number whose words sit over most of the numeric columns (a wrapped row label only reaches
 * the few columns at the left), with the lines just above it that also sit over columns (a wrapped visit name).
 */
function isHeader(l: Line, cols: Col[], slack: number) {
  return l.nums.length === 0 && cols.filter((c) => l.words.some((w) => inCol(w, c, slack))).length >= Math.max(3, Math.ceil(cols.length * 0.6));
}

function blocksOf(page: TextPage, carry: Block | null): Block[] {
  const lines: Line[] = visualLines(page.words.filter((w) => !w.hidden && w.dir === 0)).map((ws) => {
    const words = ws.map(centre);
    return { y: words.reduce((a, w) => a + w.cy, 0) / words.length, words, nums: words.filter(isNum) };
  });
  const data = lines.filter((l) => l.nums.length >= 3);
  if (!data.length) return [];
  const { cols, slack } = columnsOf(data);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  // rows before the page's first header continue the last page's block, when its columns sit at the same places
  if (carry && cols.every((c) => carry.cols.some((k) => Math.abs(k.c - c.c) <= slack))) {
    const at = (c: Col) => carry.cols.findIndex((k) => Math.abs(k.c - c.c) <= slack);
    cur = { ...carry, page, lines: [], cols: cols.map((c) => ({ ...c, label: carry.cols[at(c)]!.label })), roles: cols.map((c) => carry.roles[at(c)]!) };
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isHeader(l, cols, slack) && l.y < data.at(-1)!.y) {
      // the band: this line and any just above it over the columns (a wrapped visit name)
      const band = [l];
      for (let j = i - 1; j >= 0 && l.y - lines[j]!.y <= 2.2 * height(l) && lines[j]!.nums.length === 0 && cols.some((c) => lines[j]!.words.some((w) => inCol(w, c, slack))); j--) band.unshift(lines[j]!);
      const words = band.flatMap((b) => b.words);
      const labelled = cols.map((c) => ({ ...c, label: text(words.filter((w) => inCol(w, c, slack)).sort((a, b) => a.cy - b.cy || a.cx - b.cx)) }));
      const ohWord = words.find((w) => /^(?:oh|o\/h|overhead)$/i.test(w.text));
      const title = text(lines.filter((x) => x.y < band[0]!.y && x.y >= band[0]!.y - 8 * height(l) && x.nums.length === 0).flatMap((x) => x.words)).slice(-120);
      if (cur?.lines.length) blocks.push(cur);
      cur = { cols: labelled, roles: labelled.map((c) => role(c.label)), oh: ohWord?.cx ?? null, section: /non[\s-]*procedure/i.test(text(words)) ? "non_procedure" : "procedure", lines: [], page, title };
      continue;
    }
    cur?.lines.push(l);
  }
  if (cur?.lines.length) blocks.push(cur);
  return blocks;
}

type Row = { code: string | null; name: string; qty: number | null; unit: number; cells: Record<string, number>; oh: boolean; section: Block["section"]; page: number };
type Sum = { label: string; values: Map<string, number>; first: number | null; pct: number | null; section: Block["section"]; page: number };

/** One block's procedure rows and summary rows, each label made of the label lines nearest its number line. */
function rowsOf(b: Block): { rows: Row[]; sums: Sum[] } | null {
  const unit = b.roles.indexOf("unit");
  if (unit < 0) return null;
  const visits = b.cols.flatMap((c, i) => (b.roles[i] === "visit" && i > unit ? [{ c, i }] : []));
  if (!visits.length) return null;
  // a row's label is everything left of its first figure column (quantity or unit price), numbers in a name included
  const figureAt = b.cols.find((_, i) => b.roles[i] === "qty" || b.roles[i] === "unit")!.x0;
  // half the narrowest step between neighbouring columns: a number belongs to one column at most
  const slack = Math.max(2, Math.min(...b.cols.slice(1).map((c, i) => (c.c - b.cols[i]!.c) / 2)));
  const data = b.lines.filter((l) => l.nums.some((w) => w.rect[0] >= figureAt - 1));
  const labelLines = b.lines.filter((l) => !data.includes(l));
  const labelOf = (l: Line) => {
    const own = l.words.filter((w) => w.rect[2] <= figureAt + 1);
    const near = labelLines.filter((x) => data.reduce((best, d) => (Math.abs(d.y - x.y) < Math.abs(best.y - x.y) ? d : best), data[0]!) === l);
    const left = (x: Line) => x.words.filter((w) => w.rect[2] <= figureAt + 1);
    return text([...near.filter((x) => x.y < l.y).flatMap(left), ...own, ...near.filter((x) => x.y > l.y).flatMap(left)]);
  };
  // the number nearest the column's centre, if it falls in the column at all
  const valueIn = (l: Line, i: number) => {
    const c = b.cols[i]!;
    const w = l.nums.filter((n) => inCol(n, c, slack)).sort((a, z) => Math.abs(a.cx - c.c) - Math.abs(z.cx - c.c))[0];
    return w && b.cols.reduce((best, k, j) => (Math.abs(k.c - w.cx) < Math.abs(b.cols[best]!.c - w.cx) ? j : best), 0) === i ? parseCents(w.text) : null;
  };
  const rows: Row[] = [];
  const sums: Sum[] = [];
  for (const l of data) {
    const u = valueIn(l, unit);
    const cells: Record<string, number> = {};
    for (const { c, i } of visits) {
      const v = valueIn(l, i);
      if (v !== null) cells[c.label.replace(/\s+/g, "")] = v;
    }
    const codeCol = b.roles.indexOf("code");
    const codeWord = codeCol >= 0 ? l.words.find((w) => inCol(w, b.cols[codeCol]!, slack)) : l.words.find((w) => /^[A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*$/.test(w.text) && w.rect[2] < figureAt);
    if (u !== null) {
      const qtyCol = b.roles.indexOf("qty");
      const q = qtyCol >= 0 ? valueIn(l, qtyCol) : null;
      const name = labelOf(l).replace(codeWord ? new RegExp(`^${codeWord.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`) : /^$/, "");
      const oh = b.oh !== null && l.words.some((w) => !isNum(w) && Math.abs(w.cx - b.oh!) <= slack);
      rows.push({ code: codeWord?.text ?? null, name, qty: q === null ? null : q / 100, unit: u, cells, oh, section: b.section, page: b.page.page });
    } else {
      const label = labelOf(l);
      const pct = /(\d+(?:\.\d+)?)\s*%/.exec(label);
      sums.push({ label, values: new Map(Object.entries(cells)), first: l.nums[0] ? parseCents(l.nums[0].text) : null, pct: pct ? parsePercent(pct[0]) : null, section: b.section, page: b.page.page });
    }
  }
  return { rows, sums };
}

const prov = (documentId: string, page: number): Provenance => ({ source: { documentId, page }, confidence: 1, method: "text", crossCheck: "not_checked" });

/**
 * Every budget grid of one document's text pages, each with the identities its own numbers satisfy. Blocks with the same
 * visit columns, in page order, are one grid. A grid with no visit sums, or one whose arithmetic doesn't close, comes back
 * with `failed` set: the caller keeps the model's read for it.
 */
export function readTextGrids(pages: TextPage[], documentId: string): TextGrid[] {
  const blocks: Block[] = [];
  for (const p of pages.filter((x) => x.source === "text").sort((a, b) => a.page - b.page)) blocks.push(...blocksOf(p, blocks.at(-1) ?? null));
  const groups: { visits: string[]; parts: { rows: Row[]; sums: Sum[]; b: Block }[] }[] = [];
  for (const b of blocks) {
    const read = rowsOf(b);
    if (!read || (!read.rows.length && !read.sums.length)) continue;
    const visits = b.cols.flatMap((c, i) => (b.roles[i] === "visit" && i > b.roles.indexOf("unit") ? [c.label.replace(/\s+/g, "")] : []));
    const g = groups.at(-1);
    if (g && g.visits.join("|") === visits.join("|")) g.parts.push({ ...read, b });
    else groups.push({ visits, parts: [{ ...read, b }] });
  }
  return groups.flatMap((g, gi) => {
    const rows = g.parts.flatMap((p) => p.rows);
    const sums = g.parts.flatMap((p) => p.sums);
    if (!rows.length) return [];
    const first = g.parts[0]!.b;
    const sumOf = (re: RegExp, section?: Block["section"]) => sums.find((s) => re.test(s.label) && (!section || s.section === section));
    const procSub = sumOf(/sub\s*-?\s*total/i, "procedure");
    const nonSub = sumOf(/sub\s*-?\s*total/i, "non_procedure");
    const overhead = sumOf(/overhead|\bo\/?h\b|indirect/i);
    const total = sums.find((s) => /\btotal\b/i.test(s.label) && !/sub\s*-?\s*total|per\s*patient|per\s*subject/i.test(s.label));
    const perPatient = sumOf(/per\s*(?:patient|subject)/i);
    const failed: string[] = [];
    let checked = 0;
    const check = (ok: boolean, what: string) => (checked++, ok || failed.push(what));
    // a row: its quantity counts units, so its cells add up to quantity × unit price
    rows.forEach((r, i) => {
      if (r.qty !== null) check(Object.values(r.cells).reduce((a, b) => a + b, 0) === Math.round(r.qty * r.unit), `row ${i + 1}: cells ≠ quantity × unit price`);
    });
    // a visit: its section's cells, its subtotals and overhead, its total
    g.visits.forEach((v, vi) => {
      const add = (section: Block["section"]) => rows.filter((r) => r.section === section).reduce((a, r) => a + (r.cells[v] ?? 0), 0);
      if (procSub?.values.has(v)) check(add("procedure") === procSub.values.get(v), `visit ${vi + 1}: procedure cells ≠ subtotal`);
      if (nonSub?.values.has(v)) check(add("non_procedure") === nonSub.values.get(v), `visit ${vi + 1}: non-procedure cells ≠ subtotal`);
      if (total?.values.has(v)) check((procSub?.values.get(v) ?? 0) + (nonSub?.values.get(v) ?? 0) + (overhead?.values.get(v) ?? 0) === total.values.get(v), `visit ${vi + 1}: subtotals + overhead ≠ total`);
      else failed.push(`visit ${vi + 1}: no total printed`);
    });
    if (perPatient?.first != null) check(g.visits.reduce((a, v) => a + (total?.values.get(v) ?? 0), 0) === perPatient.first, "visit totals ≠ per-patient total");
    const grid: BudgetGrid = {
      id: `text-${documentId}-${gi}`,
      label: first.title || "Budget",
      arm: null,
      statedOverheadPct: overhead?.pct ?? null,
      visits: g.visits.map((v, vi) => ({
        code: v, name: v, order: vi + 1,
        procedureSubtotalCents: procSub?.values.get(v) ?? null,
        overheadCents: overhead?.values.get(v) ?? null,
        nonProcedureCents: nonSub?.values.get(v) ?? null,
        totalCents: total?.values.get(v) ?? 0,
        autopay: true,
        prov: prov(documentId, (total ?? procSub)?.page ?? first.page.page),
      })),
      procedures: rows.map((r) => ({ code: r.code, name: r.name, unitCents: r.unit, overheadApplied: r.oh, category: r.section, cells: r.cells, prov: prov(documentId, r.page) })),
      perPatientTotals: perPatient?.first != null ? [{ label: perPatient.label.replace(/\s*\(?us\$\)?/i, "").trim() || "Total", cents: perPatient.first, prov: prov(documentId, perPatient.page) }] : [],
      header: { investigator: null, siteName: null },
      prov: prov(documentId, first.page.page),
    };
    return [{ grid, qty: rows.map((r) => r.qty), checked, failed }];
  });
}

/** For the native gate's diagnostics: the blocks a document's pages split into, roles and counts, no text. @internal */
export const blocksForDebug = (pages: TextPage[]) => {
  const out: Block[] = [];
  for (const p of pages.filter((x) => x.source === "text").sort((a, b) => a.page - b.page)) out.push(...blocksOf(p, out.at(-1) ?? null));
  return out.map((b) => ({
    page: b.page.page, section: b.section, roles: b.roles.join(","),
    labelShape: b.cols.map((c) => c.label.replace(/[A-Za-z]+/g, "w").replace(/\d+/g, "N")).join("|"),
    lines: b.lines.length, dataLines: b.lines.filter((l) => l.nums.length).length, rows: rowsOf(b)?.rows.length ?? -1, sums: rowsOf(b)?.sums.length ?? -1,
  }));
};
