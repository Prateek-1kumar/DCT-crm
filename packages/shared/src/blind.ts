import { blankNumbers, type ReviewItem, settled, type ValueEvidence } from "./evidence";
import type { Rulebook } from "./rulebook";

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

/**
 * The rulebook with each withheld value set to null. The item that holds it (the nearest object with a provenance) can
 * restate the number in its other words, so there: the quote is dropped, the numbers in its location and in its other
 * text fields are blanked (blankNumbers; in names only amounts and %), and its page stays, so the clause can still be
 * found. Ids, codes and fixed-list values stay. Item- and section-level paths (a grid header, a referenced document) aren't
 * values and stay as they are.
 */
export function mask(rb: Rulebook, hidden: string[]): Rulebook {
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

type Box = NonNullable<ValueEvidence["where"][number]["box"]>;
const sameLine = (a: Box, b: Box) => a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/**
 * The questions as a response may show them while values are withheld. An earlier, settled question about a value that's
 * open again (reported, sent back) keeps its outcome but not the answer or comparison, which hold the value. Notes about
 * a withheld value (an answer's, a send-back's, the "This looks wrong" report's: "Should be $104") have their numbers
 * blanked (blankNumbers) until its question is settled, and so does a contract problem's wording. A money term found on
 * the same printed line as a withheld value quotes the PDF's text there, which is the value's printed text: its numbers
 * are blanked too (`evidence` says where each value is printed).
 */
export function blindReview(review: ReviewItem[], hidden: string[], evidence: ValueEvidence[] = []): ReviewItem[] {
  if (!hidden.length) return review;
  const h = new Set(hidden);
  // where a withheld value's own text is printed (a value with no printed text can't be quoted from the PDF)
  const printedAt = evidence.filter((e) => h.has(e.path) && e.printed !== null).flatMap((e) => e.where);
  const onLine = (i: ReviewItem) =>
    i.kind === "unaccounted" && i.where.some((w) => printedAt.some((x) => x.documentId === w.documentId && x.page === w.page && !!x.box && !!w.box && sameLine(x.box, w.box)));
  return review.map((i) => {
    if (onLine(i)) {
      const { term, ...rest } = i;
      return { ...rest, question: blankNumbers(i.question), ...(term ? { term: { quote: blankNumbers(term.quote), amounts: [] } } : {}) };
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
