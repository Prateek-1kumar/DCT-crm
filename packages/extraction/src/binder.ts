import type { BudgetGrid, PageBox, Provenance, ReviewItem, Rulebook, ValueEvidence } from "@dct/shared";
import { amounts, boxOf, frame, inventory, NUMBER, type Span, type TextPage, visualLines, type Word } from "./textlayer";

/**
 * Binder (ADR-001 §5), no AI: each money value in a rulebook is looked up at its own position in the PDF's text, and
 * every inventory span no value is bound to comes back as unaccounted.
 */

type Line = { words: Word[]; dir: Word["dir"]; v: number; h: number };
type Page = { p: TextPage; lines: Line[]; orders: Word[][] };
type Cols = { dir: Word["dir"]; at: Map<string, [number, number]>; unit: [number, number] | null; left: number; pitch: number };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const cents = (s: string | null) => {
  const t = (s ?? "").replace(/\s/g, "");
  return NUMBER.test(t) && !t.endsWith("%") ? Math.round(Number(t.replace(/[^\d.]/g, "")) * 100) : null;
};
const txt = (ws: Word[]) => ws.map((w) => w.text).join(" ");
const mid = (w: Word) => (frame(w)[1] + frame(w)[3]) / 2;

const cache = new WeakMap<TextPage, Page>();
function pageData(p: TextPage): Page {
  const hit = cache.get(p);
  if (hit) return hit;
  const seen = p.words.filter((w) => !w.hidden);
  const lines = visualLines(seen).map((ws) => ({ words: ws, dir: ws[0]!.dir, v: mid(ws[0]!), h: Math.max(...ws.map((w) => frame(w)[3] - frame(w)[1])) }));
  const out = { p, lines, orders: [seen, lines.flatMap((l) => l.words)] };
  cache.set(p, out);
  return out;
}

// ---------- labels and rows ----------

const STOP = new Set(["the", "of", "and", "a", "an", "per", "for", "to", "in", "with", "or", "on", "at", "by"]);
const tokens = (s: string) => s.split(/\s+/).map(norm).filter((t) => t.length > 1 && !STOP.has(t));
const sameToken = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Longest common subsequence of two token lists, tokens compared loosely (prefixes of 4+ letters). */
function lcs(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    b.forEach((y, j) => cur.push(sameToken(x, y) ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!)));
    prev = cur;
  }
  return prev[b.length]!;
}

type Option = { row: Line; code: Word | null; score: number };

/**
 * The rows a label may belong to, best first, found by the label and never by the value. The label's vertical band is
 * a run of up to 4 consecutive lines (left of `limit`) spelling at least half the name in order, scored by the F1 of the
 * common subsequence (neighbouring rows' descriptions often differ in a word or two). Its row is the candidate (a line
 * carrying numbers) nearest the band, from one line above it to 5 line heights below, since labels sit on their row's
 * line or are centred on it; on the code's line when the item has a printed code. No name: a code printed on exactly one candidate.
 */
function rowsFor(lines: Line[], cands: Line[], code: string | null, name: string, limit = Infinity): Option[] {
  const c = norm(code ?? "");
  const codeOf = (l: Line) => (c ? (l.words.find((w) => norm(w.text) === c) ?? null) : null);
  const byCode = cands.filter(codeOf);
  const pool = byCode.length ? byCode : cands;
  const want = tokens(name);
  const ls = lines.map((l) => ({ l, ts: l.words.filter((w) => frame(w)[2] <= limit).map((w) => norm(w.text)) })).filter((x) => x.ts.length);
  const best = new Map<Line, number>();
  // ponytail: a bottom-aligned label, or a name that skips its label's first line in a top-aligned table, lands on the next row → conflicts. Upgrade: row bands from rulings.
  ls.forEach((first, i) => {
    if (!first.ts.some((t) => want.some((x) => sameToken(x, t)))) return;
    for (let k = i, ts: string[] = []; k < Math.min(ls.length, i + 4); k++) {
      const [cur, prev] = [ls[k]!.l, ls[k - 1]?.l];
      if (k > i && (cur.dir !== prev!.dir || cur.v - prev!.v > 2 * Math.max(cur.h, prev!.h))) break;
      ts = [...ts, ...ls[k]!.ts];
      const common = lcs(want, ts);
      const gap = (l: Line) => Math.max(0, first.l.v - l.v, l.v - cur.v);
      const row = common >= want.length / 2 && pool.filter((l) => l.dir === first.l.dir && l.v >= first.l.v - 1.2 * first.l.h && l.v <= cur.v + 5 * cur.h).sort((a, b) => gap(a) - gap(b))[0];
      if (row) best.set(row, Math.max(best.get(row) ?? 0, (2 * common) / (want.length + ts.length)));
    }
  });
  if (!best.size && byCode.length === 1) best.set(byCode[0]!, 0);
  return [...best].map(([row, score]) => ({ row, code: codeOf(row), score })).sort((a, b) => b.score - a.score);
}

// ---------- grid columns ----------

const UNIT = /unit|cost|price|amount|rate|fee|budget/i;

/** Word runs on one line that spell one of the targets. */
function runs(l: Line, targets: string[]): Word[][] {
  const ts = targets.map(norm).filter(Boolean);
  const max = Math.max(0, ...ts.map((t) => t.length));
  const out: Word[][] = [];
  l.words.forEach((_, i) => {
    let s = "";
    for (let j = i; j < l.words.length && s.length < max; j++) {
      s += norm(l.words[j]!.text);
      if (ts.includes(s)) {
        out.push(l.words.slice(i, j + 1));
        break;
      }
    }
  });
  return out;
}

const span = (ws: Word[]): [number, number] => [Math.min(...ws.map((w) => frame(w)[0])), Math.max(...ws.map((w) => frame(w)[2]))];

/** Visit columns from the header line that names the most visits (code or name), in the text's own direction. */
function headerColumns(pg: Page, visits: BudgetGrid["visits"]): Cols | null {
  const hits = visits.map((v) => pg.lines.flatMap((l) => runs(l, [v.code, v.name]).map((ws) => ({ l, ws }))));
  const near = (a: Line, b: Line) => a.dir === b.dir && Math.abs(a.v - b.v) <= 3 * Math.max(a.h, b.h);
  let header: Line | null = null;
  let most = 0;
  for (const l of pg.lines) {
    const n = hits.filter((h) => h.some((x) => near(x.l, l))).length;
    if (n > most) [header, most] = [l, n];
  }
  // ponytail: one header line per page, visit labels on one line each. Upgrade: join stacked header cells per column.
  if (!header || most < Math.max(2, visits.length / 2)) return null;
  const h = header;
  const at = new Map<string, [number, number]>();
  visits.forEach((v, i) => {
    const pick = hits[i]!.filter((x) => near(x.l, h)).sort((a, b) => Math.abs(a.l.v - h.v) - Math.abs(b.l.v - h.v))[0];
    if (pick) at.set(v.code, span(pick.ws));
  });
  const left = Math.min(...[...at.values()].map((c) => c[0]));
  const centres = [...at.values()].map((c) => (c[0] + c[1]) / 2).sort((a, b) => a - b);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!).sort((a, b) => a - b);
  const unitWord = pg.lines.filter((l) => near(l, h)).flatMap((l) => l.words.filter((w) => UNIT.test(w.text) && frame(w)[2] <= left)).sort((a, b) => frame(b)[0] - frame(a)[0])[0];
  return { dir: h.dir, at, unit: unitWord ? span([unitWord]) : null, left, pitch: gaps[Math.floor(gaps.length / 2)] ?? Infinity };
}

/** Column of a cell word: most overlap with a header, else (among the visits) the nearest header within half a column. */
function columnOf(cols: Cols, w: Word): string | null {
  const [u0, u1] = span([w]);
  const all: [string, [number, number]][] = [...cols.at, ...(cols.unit ? [["#unit", cols.unit] as [string, [number, number]]] : [])];
  let best: string | null = null;
  let score = -Infinity;
  for (const [k, [a, b]] of all) {
    const overlap = Math.min(u1, b) - Math.max(u0, a);
    const s = overlap > 0 ? overlap : -Math.abs((u0 + u1) / 2 - (a + b) / 2);
    if (s > score) [best, score] = [k, s];
  }
  return score > 0 || (u0 >= cols.left - cols.pitch / 2 && -score < cols.pitch / 2) ? best : null;
}

const cellWords = (cols: Cols, row: Line, key: string) => row.words.filter((w) => columnOf(cols, w) === key);

// ---------- quotes ----------

const QUOTE_WORD = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[­\-‐-―]/g, "")
    .replace(/^[.,;:!?()[\]"'*]+|[.,;:!?()[\]"'*]+$/g, "");

/**
 * Page words that say the quote word for word (whitespace, quote marks, hyphens, case and edge punctuation aside), whole words only.
 * ponytail: a quote the reader shortened with "…" doesn't match → ungrounded. Upgrade: match the parts in order.
 */
function findQuote(pg: Page, quote: string | undefined): Word[] | null {
  const q = (quote ?? "").split(/\s+/).map(QUOTE_WORD).join("");
  if (q.length < 3) return null;
  for (const order of pg.orders) {
    const parts = order.map((w) => QUOTE_WORD(w.text));
    const starts: number[] = [];
    const s = parts.reduce((acc, t) => (starts.push(acc.length), acc + t), "");
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + 1)) {
      const a = starts.indexOf(i);
      const b = starts.findIndex((st, k) => st + parts[k]!.length === i + q.length && parts[k]!.length > 0);
      if (a >= 0 && b >= a) return order.slice(a, b + 1);
    }
  }
  return null;
}

// ---------- binding ----------

export type Bound = { evidence: ValueEvidence[]; unaccounted: Span[] };

export function bindEvidence(rulebook: Rulebook, pages: TextPage[]): Bound {
  const data = new Map(pages.filter((p) => p.source === "text").map((p) => [`${p.documentId}#${p.page}`, pageData(p)]));
  const pageAt = (src: Provenance["source"]) => (src ? data.get(`${src.documentId}#${src.page}`) : undefined);
  const evidence: ValueEvidence[] = [];
  const bound = new Set<Word>();
  const put = (path: string, status: ValueEvidence["status"], where: PageBox[], printed: string | null, note: string | null = null, used: Word[] = []) => {
    used.forEach((w) => bound.add(w));
    evidence.push({ path, status, where, printed, note });
  };
  const nowhere = (src: Provenance["source"]): PageBox[] => (src ? [{ documentId: src.documentId, page: src.page, box: null }] : []);

  rulebook.budgetGrids.forEach((g, gi) => {
    const gp = `/budgetGrids/${gi}`;
    const pagesOf = [...new Set([...g.procedures, ...g.visits].flatMap((x) => (x.prov.source ? [`${x.prov.source.documentId}#${x.prov.source.page}`] : [])))].sort((a, b) => Number(a.split("#")[1]) - Number(b.split("#")[1]));
    // A continuation page without its own header uses the columns of the grid page before it.
    // ponytail: assumes continuation pages keep the layout; a changed layout gives conflicts, not confirmations.
    const colsOn = new Map<string, Cols | null>();
    let last: Cols | null = null;
    for (const k of pagesOf) {
      const pg = data.get(k);
      last = (pg && headerColumns(pg, g.visits)) || last;
      colsOn.set(k, pg ? last : null);
    }
    const ctx = (src: Provenance["source"]) => {
      const pg = pageAt(src);
      const cols = src ? colsOn.get(`${src.documentId}#${src.page}`) : null;
      if (!pg || !cols) return null;
      const cands = pg.lines.filter((l) => l.dir === cols.dir && l.words.some((w) => (NUMBER.test(w.text) || /invoic/i.test(w.text)) && columnOf(cols, w)));
      return { pg, cols, cands };
    };
    const cell = (path: string, c: NonNullable<ReturnType<typeof ctx>>, row: Line, key: string, value: number | "invoiceable", used: Word[] = []) => {
      const ws = cellWords(c.cols, row, key);
      const printed = ws.length ? txt(ws) : null;
      const ok = value === "invoiceable" ? /invoic/i.test(printed ?? "") : cents(printed) === value;
      put(path, ok ? "confirmed" : "conflict", [boxOf(c.pg.p, ws.length ? ws : row.words)], printed, null, [...ws, ...used]);
    };

    // Grid cells, by the row's label and the visit's column. One printed row per item: best label matches claim rows first.
    const options = g.procedures.flatMap((p, pi) => {
      const c = ctx(p.prov.source);
      return c ? rowsFor(c.pg.lines, c.cands, p.code, p.name, c.cols.left).map((o) => ({ ...o, pi })) : [];
    });
    const rowOf = new Map<number, Option>();
    const procRows = new Set<Line>();
    for (const o of options.sort((a, b) => b.score - a.score)) if (!rowOf.has(o.pi) && !procRows.has(o.row)) (rowOf.set(o.pi, o), procRows.add(o.row));
    g.procedures.forEach((p, pi) => {
      const pp = `${gp}/procedures/${pi}`;
      const c = ctx(p.prov.source);
      const found = rowOf.get(pi);
      // Numbers outside the price columns of a row the master holds (code, count) belong to that row; they aren't prices.
      if (c && found) for (const w of found.row.words) if (NUMBER.test(w.text) && frame(w)[2] <= c.cols.left && !columnOf(c.cols, w)) bound.add(w);
      const entries: [string, string, number | "invoiceable"][] = Object.entries(p.cells).map(([k, v]) => [`${pp}/cells/${ptr(k)}`, k, v]);
      if (p.unitCents !== null) entries.push([`${pp}/unitCents`, "#unit", p.unitCents]);
      for (const [path, key, value] of entries) {
        if (!c || !found || (key === "#unit" ? !c.cols.unit : !c.cols.at.has(key))) put(path, "ungrounded", found && c ? [boxOf(c.pg.p, found.row.words)] : nowhere(p.prov.source), null);
        else cell(path, c, found.row, key, value, found.code ? [found.code] : []);
      }
    });

    // Visit totals and subtotals: rows found by their printed label.
    const LABELS: Record<"totalCents" | "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents", (s: string) => boolean> = {
      totalCents: (s) => /\btotal/i.test(s) && !/sub[\s-]?total|patient|subject/i.test(s),
      procedureSubtotalCents: (s) => /sub[\s-]?total/i.test(s) && !/non[\s-]?proc/i.test(s),
      nonProcedureCents: (s) => /non[\s-]?proc/i.test(s),
      overheadCents: (s) => /overhead|indirect|f\s?&\s?a\b/i.test(s) && !/\btotal/i.test(s),
    };
    g.visits.forEach((v, vi) => {
      const c = ctx(v.prov.source);
      for (const f of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        const value = v[f];
        if (value === null) continue;
        const path = `${gp}/visits/${vi}/${f}`;
        const rows = c ? c.cands.filter((l) => !procRows.has(l) && LABELS[f](txt(l.words.filter((w) => frame(w)[2] <= c.cols.left)))) : [];
        // ponytail: a subtotal the grid doesn't print as its own row is ungrounded; arithmetic checks it. Upgrade: confirm it from the printed cells it sums.
        if (c && rows.length === 1) cell(path, c, rows[0]!, v.code, value);
        else put(path, "ungrounded", nowhere(v.prov.source), null, rows.length > 1 ? "several rows carry this label" : null);
      }
    });
    g.perPatientTotals.forEach((t, ti) => item(`${gp}/perPatientTotals/${ti}`, null, t.label, t.prov, [["cents", t.cents]]));
  });

  /** Label + amount on one row of the cited page, or the amount inside the quote; else a wrong page reference. */
  function item(base: string, code: string | null, name: string, prov: Provenance, fields: [string, number | null][]) {
    const src = prov.source;
    const pg = pageAt(src);
    const lineAmounts = (pg: Page) => pg.lines.filter((l) => amounts(l.words).length);
    const found = pg ? rowsFor(pg.lines, lineAmounts(pg), code, name)[0] : undefined;
    // Numbers on the item's row other than amounts (code, count) belong to it.
    const rowNumbers = (l: Line) => l.words.filter((w) => NUMBER.test(w.text) && !amounts(l.words).some((a) => a.words.includes(w)));
    const onRow = found ? amounts(found.row.words) : [];
    if (found) rowNumbers(found.row).forEach((w) => bound.add(w));
    const quote = pg ? findQuote(pg, src?.quote) : null;
    const inQuote = quote ? amounts(quote) : [];
    quote?.forEach((w) => bound.add(w));
    const want = fields.filter((f): f is [string, number] => f[1] !== null);
    // Two prices and two amounts on the row: by position, base price then price with overhead, as tables print them.
    // ponytail: a table printing them the other way round gives conflicts. Upgrade: read the order from the column headers.
    const positional = want.length === 2 && onRow.length >= 2;
    want.forEach(([field, value], i) => {
      const path = `${base}/${field}`;
      const spot = positional ? onRow[i] : onRow.find((a) => a.cents === value);
      const q = inQuote.find((a) => a.cents === value);
      const used = found?.code ? [found.code] : [];
      if (spot?.cents === value) return put(path, "confirmed", [boxOf(pg!.p, spot.words)], txt(spot.words), null, [...spot.words, ...used]);
      if (onRow.length) {
        const shown = positional ? [onRow[i]!] : onRow.filter((a) => !want.some(([, c]) => c === a.cents));
        return put(path, "conflict", [boxOf(pg!.p, found!.row.words)], txt(shown.flatMap((a) => a.words)) || null, null, [...onRow.flatMap((a) => a.words), ...used]);
      }
      if (q) return put(path, "confirmed", [boxOf(pg!.p, quote!)], txt(q.words), null, quote!);
      if (inQuote.length) return put(path, "conflict", [boxOf(pg!.p, quote!)], txt(inQuote.flatMap((a) => a.words)), null, quote!);
      // Wrong page reference: label and this amount on one line of exactly one other page of the same document.
      const elsewhere = [...data.values()].flatMap((o) => {
        if (!src || o.p.documentId !== src.documentId || o.p.page === src.page) return [];
        const lines = o.lines.filter((l) => rowsFor([l], [l], code, name).length && amounts(l.words).some((a) => a.cents === value));
        return lines.length ? [{ o, l: lines[0]! }] : [];
      });
      if (elsewhere.length === 1) {
        const { o, l } = elsewhere[0]!;
        const a = amounts(l.words).find((x) => x.cents === value)!;
        return put(path, "confirmed", [boxOf(o.p, a.words)], txt(a.words), `page reference corrected from ${src!.page} to ${o.p.page}`, [...a.words, ...rowNumbers(l)]);
      }
      put(path, "ungrounded", nowhere(src), null);
    });
  }

  rulebook.invoiceables.forEach((x, i) => item(`/invoiceables/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents], ["amountWithOverheadCents", x.amountWithOverheadCents]]));
  rulebook.siteFees.forEach((x, i) => item(`/siteFees/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents]]));
  if (rulebook.screenFail) item("/screenFail", null, "screen failure", rulebook.screenFail.prov, [["amountCents", rulebook.screenFail.amountCents]]);

  /** % and day rules: the value must sit inside a quote that matches the cited page word for word. */
  // ponytail: anywhere in the quote, so a quote with two day counts confirms either. Upgrade: the number next to the rule's unit.
  const rule = (path: string, value: number | null | undefined, prov: Provenance | undefined) => {
    if (value === null || value === undefined || !prov) return;
    const pg = pageAt(prov.source);
    const quote = pg ? findQuote(pg, prov.source?.quote) : null;
    if (!pg || !quote) return put(path, "ungrounded", nowhere(prov.source), null);
    const nums = quote.flatMap((w) => [...w.text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => ({ w, n: Number(m[0]) })));
    const hit = nums.find((x) => x.n === value);
    const where = [boxOf(pg.p, quote)];
    if (hit) put(path, "confirmed", where, hit.w.text, null, quote);
    else put(path, nums.length ? "conflict" : "ungrounded", where, nums.length ? txt([...new Set(nums.map((x) => x.w))]) : null, null, quote);
  };
  rule("/overhead/pct/value", rulebook.overhead.pct.value, rulebook.overhead.pct.prov);
  rule("/holdback/pct", rulebook.holdback?.pct, rulebook.holdback?.prov);
  rule("/payment/netDays/value", rulebook.payment.netDays.value, rulebook.payment.netDays.prov);
  rulebook.deadlines.forEach((d, i) => rule(`/deadlines/${i}/value`, d.value, d.prov));

  const unaccounted = inventory(pages).filter((s) => !s.words.some((w) => bound.has(w)));
  return { evidence, unaccounted };
}

// ---------- review queue ----------

const DEADLINE: Record<Rulebook["deadlines"][number]["kind"], string> = {
  invoice_days_from_expense: "Within how many days of an expense must it be invoiced?",
  invoice_months_after_study_close: "Within how many months after the study closes must the last invoices be sent?",
  final_invoice_days_after_closeout: "Within how many days after close-out must the final invoice be sent?",
  query_resolution_days: "Within how many days must data queries be resolved?",
  dispute_days_after_final_payment: "Within how many days after the final payment can a payment be disputed?",
  edc_entry_business_days: "Within how many business days must visit data be entered?",
};
const VISIT_FIELD: Record<string, string> = { totalCents: "total", procedureSubtotalCents: "procedure subtotal", overheadCents: "overhead", nonProcedureCents: "non-procedure subtotal" };

/** The question for one value, never the value itself (blind entry): amounts and % inside a name are blanked too. */
function ask(rb: Rulebook, path: string): Pick<ReviewItem, "question" | "input"> {
  const q = (s: string) => `"${s.replace(/\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%/g, "…").trim()}"`;
  const [, top, i, sub, j, field, key] = path.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const money = (question: string) => ({ question, input: "money" as const });
  if (top === "budgetGrids") {
    const g = rb.budgetGrids[Number(i)]!;
    if (sub === "procedures") {
      const p = g.procedures[Number(j)]!;
      if (field === "unitCents") return money(`What unit price is printed for ${q(p.name)}?`);
      return money(`What amount is printed for ${q(p.name)} at ${g.visits.find((v) => v.code === key)?.name || key}?`);
    }
    if (sub === "visits") return money(`What amount is printed for the ${g.visits[Number(j)]!.name} ${VISIT_FIELD[field!] ?? "amount"}?`);
    return money(`What amount is printed for ${q(g.perPatientTotals[Number(j)]!.label)}?`);
  }
  if (top === "invoiceables" || top === "siteFees") {
    const x = (top === "invoiceables" ? rb.invoiceables : rb.siteFees)[Number(i)]!;
    return money(`What amount${sub === "amountWithOverheadCents" ? " including overhead" : ""} is printed for ${q(x.name)}?`);
  }
  if (top === "screenFail") return money("What amount is printed for a screen failure?");
  if (top === "overhead") return { question: "What overhead percentage does the contract state?", input: "percent" };
  if (top === "holdback") return { question: "What percentage of each payment is held back?", input: "percent" };
  if (top === "payment") return { question: "Within how many days must an invoice be paid?", input: "number" };
  if (top === "deadlines") return { question: DEADLINE[rb.deadlines[Number(i)]!.kind], input: "number" };
  return { question: "What does the contract say for this value?", input: "text" };
}

const UNACCOUNTED_OPTIONS = [
  { id: "add", label: "Add it to the invoicing master" },
  { id: "bill_by_hand", label: "Keep as a term to bill by hand" },
  { id: "not_payment", label: "Not a payment term" },
];

/**
 * The review queue for a draft: a blind "type what the page says" item for every value the text didn't confirm, and
 * one item per line or sentence of the contract with money terms the master doesn't hold.
 */
export function reviewFromEvidence(evidence: ValueEvidence[], unaccounted: Span[], rulebook: Rulebook): ReviewItem[] {
  const base = { answer: null, outcome: null, compare: null, blocking: true } as const;
  const confirm: ReviewItem[] = evidence
    .filter((e) => e.status === "conflict" || e.status === "ungrounded")
    .map((e) => ({ ...base, id: `confirm:${e.path}`, kind: "confirm_value", reason: e.status === "conflict" ? "VALUE_CONFLICT" : "UNGROUNDED_VALUE", path: e.path, ...ask(rulebook, e.path), options: [], where: e.where }));
  // One item per line or sentence: a row the master missed is one question, not one per number.
  const groups = new Map<string, Span[]>();
  for (const s of unaccounted) {
    const k = `${s.where.documentId}#${s.where.page}#${s.kind === "grid_number" || s.kind === "amount" ? "row" : "term"}#${s.text}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const perPage = new Map<string, number>();
  const terms: ReviewItem[] = [...groups.values()].map((ss) => {
    const { documentId, page } = ss[0]!.where;
    const n = perPage.get(`${documentId}#${page}`) ?? 0;
    perPage.set(`${documentId}#${page}`, n + 1);
    const what = ss[0]!.kind === "absence" ? "mentions a payment condition" : ss[0]!.kind === "grid_number" || ss[0]!.kind === "amount" ? `has ${ss.length > 1 ? "amounts" : "an amount"}` : "has a payment term";
    return {
      ...base,
      id: `unaccounted:${documentId}:${page}:${n}`,
      kind: "unaccounted",
      reason: "UNACCOUNTED_TERM",
      path: null,
      question: `Page ${page} ${what} that the invoicing master doesn't have: "${ss[0]!.text.replace(/[.;:,]$/, "")}". How should it be handled?`,
      input: null,
      options: UNACCOUNTED_OPTIONS,
      where: ss.map((s) => s.where),
    };
  });
  return [...confirm, ...terms];
}
