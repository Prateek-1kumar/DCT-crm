import { blankNumbers, type PageBox, type ReviewItem, settled, type ValueEvidence } from "./evidence";
import type { Rulebook, Unclassified } from "./rulebook";

/**
 * Blind entry (ADR-001): on a draft, a value with an open question never leaves the server, nor anything that restates it.
 * The API (versionDto, diff, search) and the in-browser sample server both answer through these.
 */

const BLANK = "•••";
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);

const tokensOf = (p: string) => (p.startsWith("/") ? p.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")) : null);
const valueAt = (root: unknown, tokens: string[]) =>
  tokens.reduce<unknown>((n, t) => (Array.isArray(n) ? n[Number(t)] : isObj(n) && Object.hasOwn(n, t) ? n[t] : undefined), root);

/** One value, not an item or a section: what can be typed, reported or withheld. */
export const leaf = (v: unknown) => v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"));

/** Ids, codes and fixed-list values: they say which item it is, never how much, so they're kept. */
const STRUCTURAL = new Set(["id", "code", "kind", "basis", "trigger", "category", "paidVia", "arm", "documentId", "method", "crossCheck", "currency"]);
/** Names say which row it is: only an amount or % in them is blanked, as the questions blank them. */
const NAMES = new Set(["name", "label", "description", "title"]);
const blankAmounts = (s: string) => s.replace(/\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%/g, BLANK);

type Box = NonNullable<PageBox["box"]>;
const sameLine = (a: Box, b: Box) => a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
/**
 * Where withheld values sit on the page, by their evidence: the PDF's text there prints the number (a conflict's), or
 * holds it among others (an ungrounded value's row). A money term quoted from one of those lines restates it.
 */
const withheldAt = (hidden: Set<string>, evidence: ValueEvidence[]) => evidence.filter((e) => hidden.has(e.path)).flatMap((e) => e.where.filter((w) => !!w.box));
const onLineOf = (where: PageBox[], at: PageBox[]) => where.some((w) => !!w.box && at.some((x) => x.documentId === w.documentId && x.page === w.page && sameLine(x.box!, w.box!)));

/** Whether a money-term question quotes the PDF's text from a printed line that also holds a withheld value. */
export const quotesWithheld = (i: Pick<ReviewItem, "kind" | "where">, hidden: Set<string>, evidence: ValueEvidence[]) =>
  i.kind === "unaccounted" && onLineOf(i.where, withheldAt(hidden, evidence));

/** A term on the bill-by-hand list as shown while it quotes a withheld value's line: its words without their numbers. */
function blankTerm(u: Unclassified): Unclassified {
  const { pct: _pct, days: _days, ...rest } = u;
  return { ...rest, label: blankNumbers(u.label), quote: blankNumbers(u.quote), amounts: [], note: blankNumbers(u.note) };
}

/** What a version's questions and evidence say about where its withheld values are printed (mask needs both). */
export type Withheld = { evidence: ValueEvidence[]; review: ReviewItem[] };

/**
 * The rulebook with each withheld value set to null. The item that holds it (the nearest object with a provenance) can
 * restate the number in its other words, so there: the quote is dropped, the numbers in its location and in its other
 * text fields are blanked (blankNumbers; in names only amounts and %), and its page stays, so the clause can still be
 * found. Ids, codes and fixed-list values stay. Item- and section-level paths (a grid header, a referenced document) aren't
 * values and stay as they are. A term on the bill-by-hand list quoted from a line that holds a withheld value (its
 * question's spots, `on`) carries that number in its words: they're blanked too, and its figures left out. A term whose
 * question isn't on this version came with a correction's copy of the live version: approved, and shown there in full,
 * so it withholds nothing.
 */
export function mask(rb: Rulebook, hidden: string[], on: Withheld): Rulebook {
  // by JSON, not structuredClone: that keeps objects shared between items shared, so blanking one item's words would blank another's
  const out = JSON.parse(JSON.stringify(rb)) as Rulebook;
  for (const p of hidden) {
    const tokens = tokensOf(p);
    if (!tokens?.length) continue;
    const v = valueAt(rb, tokens);
    if (v === undefined || !leaf(v)) continue;
    const parent = valueAt(out, tokens.slice(0, -1));
    if (Array.isArray(parent)) parent[Number(tokens.at(-1))] = null;
    else if (isObj(parent)) parent[tokens.at(-1)!] = null;
    for (let n = tokens.length - 1; n > 0; n--) {
      const node = valueAt(out, tokens.slice(0, n));
      if (!isObj(node) || !isObj(node.prov)) continue;
      const src = node.prov.source;
      if (isObj(src)) {
        delete src.quote;
        if (typeof src.location === "string") src.location = blankNumbers(src.location);
      }
      for (const [k, x] of Object.entries(node)) {
        if (STRUCTURAL.has(k)) continue;
        if (typeof x === "string") node[k] = NAMES.has(k) ? blankAmounts(x) : blankNumbers(x);
        else if (Array.isArray(x) && x.length && x.every((s) => typeof s === "string")) node[k] = x.map((s: string) => blankNumbers(s));
      }
      break;
    }
  }
  const at = withheldAt(new Set(hidden), on.evidence);
  if (at.length && out.unclassified?.length)
    out.unclassified = out.unclassified.map((u) => {
      const item = on.review.find((i) => i.id === u.itemId);
      return item && onLineOf(item.where, at) ? blankTerm(u) : u;
    });
  return out;
}

const gridOf = (path: string | null) => /^\/budgetGrids\/\d+\//.exec(path ?? "")?.[0];

/**
 * Whether a question's notes (and a contract problem's wording) could give a withheld value away: its value is withheld,
 * or, for a contract problem (item id `anomaly:<code>:<path>`), a value in the grid it's about. A contract problem's
 * question quotes the read numbers of its grid ("printed total $8,489.00 ≠ …").
 */
export function blindItem(i: Pick<ReviewItem, "id" | "path">, hidden: Set<string>): boolean {
  if (i.path && hidden.has(i.path)) return true;
  if (!i.id.startsWith("anomaly:")) return false;
  const path = i.id.replace(/^anomaly:[A-Z_]+:/, "");
  const grid = gridOf(path);
  return hidden.has(path) || (!!grid && [...hidden].some((p) => p.startsWith(grid)));
}

/**
 * The questions as a response may show them while values are withheld. An earlier, settled question about a value that's
 * open again (reported, sent back) keeps its outcome but not the answer or comparison, which hold the value. Notes about
 * a withheld value (an answer's, a send-back's, the "This looks wrong" report's: "Should be $104") have their numbers
 * blanked (blankNumbers) until its question is settled, and so does a contract problem's wording. A money term found on
 * a printed line that holds a withheld value quotes the PDF's text there, which prints the value: its numbers are blanked
 * too, in its question, its words and its answer's note (`evidence` says where each value is).
 */
export function blindReview(review: ReviewItem[], hidden: string[], evidence: ValueEvidence[] = []): ReviewItem[] {
  if (!hidden.length) return review;
  const h = new Set(hidden);
  return review.map((i) => {
    if (quotesWithheld(i, h, evidence)) {
      const { term, ...rest } = i;
      return {
        ...rest,
        question: blankNumbers(i.question),
        answer: i.answer && { ...i.answer, ...(i.answer.note ? { note: blankNumbers(i.answer.note) } : {}) },
        ...(term ? { term: { quote: blankNumbers(term.quote), amounts: [] } } : {}),
      };
    }
    if (!blindItem(i, h)) return i;
    const out = {
      ...i,
      answer: i.answer && { ...i.answer, ...(i.answer.note ? { note: blankNumbers(i.answer.note) } : {}) },
      sentBack: i.sentBack && { ...i.sentBack, note: blankNumbers(i.sentBack.note) },
      ...(i.reported ? { reported: { ...i.reported, note: blankNumbers(i.reported.note) } } : {}),
    };
    if (i.path && h.has(i.path) && settled(i)) Object.assign(out, { answer: out.answer && { ...out.answer, value: undefined, optionId: undefined }, compare: null });
    if (i.id.startsWith("anomaly:")) out.question = blankNumbers(i.question);
    return out;
  });
}

/**
 * Blind entry in the log: while a value's question is open on its draft (`open`: its withheld paths, questions and
 * evidence), an entry about it (its path, or the question it answered or sent back) shows no earlier answer, typed or
 * carried value (`before` / `after`), and its note, and a contract problem's wording, have their numbers blanked. An
 * answer to a money term quoted from a withheld value's line has the numbers in its question, note and bill-by-hand
 * term blanked. A send-back logged before it named its questions is blanked while anything on its draft is open.
 */
export function blindDetail(action: string, d: Record<string, unknown>, open: (Withheld & { hidden: Set<string> }) | undefined): Record<string, unknown> {
  if (!open?.hidden.size) return d;
  const h = open.hidden;
  // a correction that wasn't carried is asked again where its item is now (`askedAt`)
  const about = (x: Record<string, unknown>) => [x.path, x.askedAt].some((p) => typeof p === "string" && h.has(p));
  const strip = ({ before: _b, after: _a, ...x }: Record<string, unknown>) => (typeof x.note === "string" ? { ...x, note: blankNumbers(x.note) } : x);
  const ids = [d.itemId, ...(Array.isArray(d.itemIds) ? d.itemIds : [])];
  const blind = about(d) || open.review.some((i) => ids.includes(i.id) && blindItem(i, h)) || (action === "review.sent_back" && !Array.isArray(d.itemIds));
  const out = blind ? strip(d) : { ...d };
  for (const k of ["carried", "skipped"]) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map((x) => (isObj(x) && about(x) ? strip(x) : x));
  if (blind && typeof out.question === "string" && typeof out.itemId === "string" && out.itemId.startsWith("anomaly:")) out.question = blankNumbers(out.question);
  if (open.review.some((i) => ids.includes(i.id) && quotesWithheld(i, h, open.evidence)))
    for (const k of ["question", "note", "billByHand", "offBillByHand"]) if (typeof out[k] === "string") out[k] = blankNumbers(out[k] as string);
  return out;
}
