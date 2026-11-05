import type { Region, Rulebook } from "@dct/shared";
import { groupLines, rawLine } from "../pdf/lines";
import type { LoadedDoc, Word } from "../types";
import { amountsAt, amountsIn, normalise } from "./text";

export type AmountStatus = "captured" | "decided" | "set_aside" | "missing";
export type CoverageRef = { target: "term"; id: string } | { target: "grid"; id: string; row: number; col: number };

export interface CoverageAmount {
  box: Region;
  text: string;
  cents: number;
  status: AmountStatus;
  ref: CoverageRef | null;
  reason: string | null;
  /** The printed line it sits on, for context. */
  line: string;
}

export interface CoverageClause {
  termId: string;
  boxes: Region[];
}

export interface CoveragePage {
  doc: string;
  page: number;
  kind: "text" | "image";
  amounts: CoverageAmount[];
  clauses: CoverageClause[];
}

export interface Coverage {
  pages: CoveragePage[];
  totals: { amounts: number; captured: number; decided: number; setAside: number; missing: number };
}

const key = (s: string) => normalise(s).replace(/[^\p{L}\p{N}]/gu, "");

const union = (words: Word[]): Region => [Math.min(...words.map((w) => w.x0)), Math.min(...words.map((w) => w.y0)), Math.max(...words.map((w) => w.x1)), Math.max(...words.map((w) => w.y1))];

/** One box per printed line the quote spans; [] when the words aren't on the page (a scan has none). */
export function findQuote(words: Word[], quote: string): Region[] {
  const wanted = quote.split(/\s+/).map(key).join("");
  if (!wanted) return [];
  const ordered = groupLines(words).flat();
  // the page as one run of letters and digits, so a quote matches however the words split or punctuation sits; a hit must start and end on a word
  let run = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const w of ordered) {
    starts.push(run.length);
    run += key(w.text);
    ends.push(run.length);
  }
  for (let at = run.indexOf(wanted); at !== -1; at = run.indexOf(wanted, at + 1)) {
    const first = starts.indexOf(at);
    const last = ends.indexOf(at + wanted.length);
    if (first === -1 || last === -1 || last < first) continue;
    const lines: Word[][] = [];
    for (const w of ordered.slice(first, last + 1).filter((w) => key(w.text))) {
      const line = lines.at(-1);
      if (line && Math.abs((w.y0 + w.y1) / 2 - (line[0]!.y0 + line[0]!.y1) / 2) <= (w.y1 - w.y0) / 2) line.push(w);
      else lines.push([w]);
    }
    return lines.map(union);
  }
  return [];
}

interface Candidate {
  ref: CoverageRef;
  person: boolean;
  doc: string;
  pages: number[];
}

function candidates(rulebook: Rulebook): Map<number, Candidate[]> {
  const byCents = new Map<number, Candidate[]>();
  const add = (cents: unknown, candidate: Candidate) => {
    if (typeof cents !== "number" || cents === 0) return;
    const list = byCents.get(Math.abs(cents)) ?? [];
    list.push(candidate);
    byCents.set(Math.abs(cents), list);
  };
  for (const t of rulebook.terms) {
    const candidate: Candidate = { ref: { target: "term", id: t.id }, person: t.evidence === "person", doc: t.source.doc, pages: [t.source.page] };
    add(t.amountCents, candidate);
    if (t.cap?.kind === "amount") add(t.cap.value, candidate);
    // money written into a rule's words ("100% of $5,995 for Visit 1") is captured by that rule
    for (const s of [t.formula, t.conditions, t.notes, t.trigger, t.cap?.text, t.deadline, t.unit]) if (s) amountsIn(s).forEach((c) => add(c, candidate));
  }
  for (const g of rulebook.grids) {
    const at = (row: number, col: number): Candidate => ({ ref: { target: "grid", id: g.id, row, col }, person: false, doc: g.doc, pages: g.pages });
    g.rows.forEach((r, row) => {
      add(r.unitCostCents, at(row, -1));
      add(r.printedRowTotalCents, at(row, -1));
      r.cells.forEach((c, col) => add(c, at(row, col)));
    });
    [g.subtotal, g.overhead, g.total, ...g.additions.map((a) => a.cells)].forEach((line) => line?.forEach((c, col) => add(c, at(-1, col))));
    add(g.grandTotalCents, at(-1, -1));
  }
  return byCents;
}

export function coverage(rulebook: Rulebook, docs: LoadedDoc[]): Coverage {
  const known = candidates(rulebook);
  const noMoney = new Set(rulebook.study.documents.filter((d) => !d.hasMoney).map((d) => d.doc));
  const pages: CoveragePage[] = [];
  const totals = { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 };

  for (const doc of docs) {
    if (noMoney.has(doc.name)) continue;
    for (const page of doc.pages) {
      const out: CoveragePage = { doc: doc.name, page: page.page, kind: page.kind, amounts: [], clauses: [] };
      pages.push(out);
      if (page.kind === "image") continue;

      // A whole page set aside (a superseded budget) wins over a coincidental match; a set-aside amount counts wherever
      // it was listed, as in the every-dollar check.
      const wholePage = rulebook.accounted.find((a) => a.doc === doc.name && a.pages?.includes(page.page));
      const setAside = (cents: number) =>
        rulebook.accounted.find((a) => a.doc === doc.name && a.page === page.page && a.amountCents !== undefined && Math.abs(a.amountCents) === cents) ??
        rulebook.accounted.find((a) => a.amountCents !== undefined && Math.abs(a.amountCents) === cents);
      for (const line of groupLines(page.words)) {
        let at = 0;
        const spans = line.map((w) => {
          const span = { w, start: at, end: at + w.text.length };
          at = span.end + 1;
          return span;
        });
        for (const a of amountsAt(rawLine(line))) {
          if (a.cents === 0) continue;
          const printed = spans.filter((s) => s.start < a.end && s.end > a.start).map((s) => s.w);
          const matches = wholePage ? [] : (known.get(a.cents) ?? []);
          const match = matches.find((c) => c.doc === doc.name && c.pages.includes(page.page)) ?? matches[0];
          const accounted = match ? undefined : (wholePage ?? setAside(a.cents));
          const status: AmountStatus = match ? (match.person ? "decided" : "captured") : accounted ? "set_aside" : "missing";
          out.amounts.push({ box: union(printed), text: a.text, cents: a.cents, status, ref: match?.ref ?? null, reason: accounted?.reason ?? null, line: rawLine(line).trim().slice(0, 120) });
          totals.amounts++;
          totals[status === "set_aside" ? "setAside" : status]++;
        }
      }

      for (const t of rulebook.terms) {
        if (t.source.doc !== doc.name || t.source.page !== page.page) continue;
        const boxes = findQuote(page.words, t.source.quote);
        if (boxes.length) out.clauses.push({ termId: t.id, boxes });
      }
    }
  }
  return { pages, totals };
}
