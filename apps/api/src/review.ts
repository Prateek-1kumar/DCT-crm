import type { TextPage } from "@dct/extraction";
import {
  AnswerReviewBody,
  type ContractAnomaly,
  ENUM_LABELS,
  type PageBox,
  type Provenance,
  type ReviewItem,
  Rulebook,
  type RulebookVersionDto,
  settled,
  type ValueEvidence,
  withheldPaths,
} from "@dct/shared";
import type { z } from "zod";
import type { ExtractionPort } from "./extraction/port.js";
import { labelFor } from "./lib/diff.js";
import { HttpError, isObj } from "./lib/http.js";
import { getAt, parsePointer, setAt } from "./lib/pointer.js";

/**
 * The review queue (ADR-001): the questions a person answers before a draft can be approved, how an answer is checked,
 * and blind entry (a value with an open question never leaves the server). Mirrors apps/web/src/lib/mock/server.ts.
 */

type Checked = Pick<RulebookVersionDto, "evidence" | "review" | "pdfCheck">;
type GridVisit = Rulebook["budgetGrids"][number]["visits"][number];

/** Value at a JSON pointer; undefined when the pointer doesn't fit the shape. */
export const at = (root: unknown, path: string): unknown => {
  try {
    return getAt(root, parsePointer(path));
  } catch {
    return undefined;
  }
};
/** One value, not an item or a section: what can be typed, reported or withheld. */
export const leaf = (v: unknown) => v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"));

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const box = (documentId: string, page: number): PageBox => ({ documentId, page, box: null });
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

/** Still needs a person: unanswered, answered differently, or a blocking "can't tell" (apps/web/src/lib/review.ts needsYou). */
export const openItems = (items: ReviewItem[]) => items.filter((i) => i.outcome === null || i.outcome === "differs" || (i.blocking && i.outcome === "cant_tell"));

/** For studies.needs_you: a by-hand draft still being typed counts as one thing to do (the typing), as in the web. */
export const needsYouOf = (v: { status: string; byHand: boolean; review: ReviewItem[] } | undefined) =>
  v?.status !== "draft" ? 0 : v.byHand && !v.review.length ? 1 : openItems(v.review).length;

// ---------- blind entry ----------

/** On a draft, every value with an open question: withheld from every response until it's answered (@dct/shared withheldPaths). */
export const hiddenPaths = withheldPaths;

// amounts and percentages: with a $ or %, grouped by commas, with decimals, or 3+ digits; not "V2", "Week 0" or "page 4"
const AMOUNTS = /\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%|(?<![\w.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.,])\d+\.\d+|(?<![\w.,])\d{3,}/g;
/** A question's numbers blanked, for when they could give a withheld value away. */
const blankAmounts = (s: string) => s.replace(AMOUNTS, "…");
const gridOf = (path: string | null) => /^\/budgetGrids\/\d+\//.exec(path ?? "")?.[0];

/**
 * The questions as a response may show them while values are withheld. An earlier, settled question about a value that's
 * open again (reported, sent back) keeps its outcome but not the answer or comparison, which hold the value. A contract
 * problem's question quotes the read numbers of its grid ("printed total $8,489.00 ≠ …"), so they're blanked while a
 * value in that grid is withheld.
 */
export function blindReview(review: ReviewItem[], hidden: string[]): ReviewItem[] {
  if (!hidden.length) return review;
  const h = new Set(hidden);
  return review.map((i) => {
    let out = i;
    if (i.path && h.has(i.path) && settled(i)) out = { ...out, answer: out.answer && { ...out.answer, value: undefined, optionId: undefined }, compare: null };
    if (i.id.startsWith("anomaly:")) out = { ...out, question: blindQuestion(i.id, out.question, h) };
    return out;
  });
}

/** A contract problem's question (item id `anomaly:<code>:<path>`), its numbers blanked while its value or a value in its grid is withheld. */
export function blindQuestion(itemId: string, question: string, hidden: Set<string>): string {
  const path = itemId.replace(/^anomaly:[A-Z_]+:/, "");
  const grid = gridOf(path);
  return hidden.has(path) || (grid && [...hidden].some((p) => p.startsWith(grid))) ? blankAmounts(question) : question;
}

/**
 * The rulebook with each hidden value set to null, and the quote of the item that holds it dropped (a rule's quote prints
 * its number). Item- and section-level paths (a grid header, a referenced document) aren't values and stay.
 */
export function mask(rb: Rulebook, hidden: string[]): Rulebook {
  const out = structuredClone(rb);
  for (const p of hidden) {
    const tokens = parsePointer(p);
    const v = at(rb, p);
    if (v === undefined || !leaf(v)) continue;
    setAt(out, tokens, null);
    for (let n = tokens.length - 1; n > 0; n--) {
      const node = getAt(out, tokens.slice(0, n));
      if (isObj(node) && isObj(node.prov)) {
        if (isObj(node.prov.source)) delete node.prov.source.quote;
        break;
      }
    }
  }
  return out;
}

// ---------- questions at extraction ----------

const fieldKey = (path: string) => {
  const t = path.split("/");
  const [last, prev] = [t.at(-1) ?? "", t.at(-2)];
  return last === "value" && prev && !/^\d+$/.test(prev) ? prev : last;
};
const inputFor = (path: string, value: unknown): NonNullable<ReviewItem["input"]> => {
  const key = fieldKey(path);
  if (/date|appliesFrom/i.test(key)) return "date";
  if (/cents$/i.test(key) || path.includes("/cells/")) return "money";
  if (/pct$/i.test(key)) return "percent";
  if (typeof value === "number" || (value === null && /days|value$|^n$|count|ratio/i.test(key))) return "number";
  return "text";
};

/**
 * A blind question about one value: "This looks wrong" (reason "reported"), the re-type sample of hand-typed values
 * ("spot_check"), a required value the read didn't find. Yes/no and fixed-list values are picked; the rest typed.
 */
export function askAbout(rb: Rulebook, evidence: ValueEvidence[], path: string, id: string, reason: string): ReviewItem {
  const value = at(rb, path);
  // An amount or % in a name would give the answer away (as the binder's questions do).
  const label = labelFor(rb, path).replace(/\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%/g, "…");
  const list = typeof value === "string" ? ENUM_LABELS[fieldKey(path)] : undefined;
  const options =
    typeof value === "boolean" ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }]
    : list && (value as string) in list ? Object.entries(list).map(([k, l]) => ({ id: k, label: l }))
    : [];
  const input = options.length ? null : inputFor(path, value);
  const ev = evidence.find((e) => e.path === path)?.where[0];
  const src = provOf(rb, path)?.source;
  return {
    ...BLANK, id, kind: "confirm_value", reason, path, blocking: true, input, options,
    question: `What ${input === "money" ? "amount" : input === "date" ? "date" : "value"} is printed for ${label}?`,
    where: ev ? [ev] : src ? [box(src.documentId, src.page)] : [],
  };
}

/** Provenance of the nearest item on the path that carries one ("/payment/netDays/value" → payment.netDays.prov). */
function provOf(rb: Rulebook, path: string): Provenance | null {
  let node: unknown = rb;
  let found: Provenance | null = null;
  for (const t of parsePointer(path)) {
    node = Array.isArray(node) ? node[Number(t)] : isObj(node) ? node[t] : undefined;
    if (isObj(node) && isObj(node.prov)) found = node.prov as Provenance;
  }
  return found;
}

/**
 * Scan pages: a grid value counts as confirmed only when the contract's own totals agree to the cent (a visit's parts add
 * up to its total and its cells to its subtotals; a per-patient total is the sum of every visit). A unit price is never
 * summed, so it counts only when a checked cell of its row prints the same amount. Everything else is typed by a person.
 */
function byTotals(rb: Rulebook) {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return (path: string) => {
    const [, top, gi, sub, i, field, key] = path.split("/");
    const g = top === "budgetGrids" ? rb.budgetGrids[Number(gi)] : undefined;
    if (!g) return false;
    const exact = (v: GridVisit | undefined) =>
      !!v &&
      v.procedureSubtotalCents !== null &&
      v.overheadCents !== null &&
      v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0) === v.totalCents &&
      sum(g.procedures.map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number")) === v.procedureSubtotalCents + (v.nonProcedureCents ?? 0);
    const visit = (code: string) => exact(g.visits.find((v) => v.code === code));
    if (sub === "visits") return exact(g.visits[Number(i)]);
    if (sub === "perPatientTotals") return g.visits.every(exact) && g.perPatientTotals[Number(i)]?.cents === sum(g.visits.map((v) => v.totalCents));
    const p = sub === "procedures" ? g.procedures[Number(i)] : undefined;
    if (!p) return false;
    if (field === "cells") return visit(key!.replace(/~1/g, "/").replace(/~0/g, "~"));
    return field === "unitCents" && Object.entries(p.cells).some(([k, c]) => c === p.unitCents && visit(k));
  };
}

// The cross-read, its text-layer page check and self-reported confidence are not evidence (ADR-001 §4, §6): the binder replaces them.
const SUPERSEDED = new Set<ContractAnomaly["code"]>(["TEXT_LAYER_MISMATCH", "AI_DISAGREEMENT", "LOW_CONFIDENCE"]);
const ARITHMETIC = new Set<ContractAnomaly["code"]>(["VISIT_TOTAL_MISMATCH", "PER_PATIENT_TOTAL_MISMATCH"]);
const AS_PRINTED = [{ id: "as_printed", label: "Yes, go ahead as printed" }];

/**
 * One question per contract problem the checks found. Each clears by a typed value or a pick (I6), never free text.
 * Picks the API can't carry out (remove a grid, bill a duplicate one way) aren't offered: "can't tell" leaves it for the approver.
 */
function fromAnomalies(anomalies: ContractAnomaly[], rb: Rulebook, asked: Set<string>): ReviewItem[] {
  return anomalies.flatMap((a): ReviewItem[] => {
    if (SUPERSEDED.has(a.code) || (a.path && asked.has(a.path))) return [];
    // One flag per root cause: a total that doesn't add up isn't asked while a number in its grid is being typed.
    // ponytail: per grid, not per visit. Upgrade: only the visit whose numbers are asked.
    const grid = /^\/budgetGrids\/\d+\//.exec(a.path ?? "")?.[0];
    if (ARITHMETIC.has(a.code) && grid && [...asked].some((p) => p.startsWith(grid))) return [];
    const base = {
      ...BLANK,
      id: `anomaly:${a.id}`,
      reason: a.code,
      path: a.path,
      where: a.refs.map((r) => box(r.documentId, r.page)),
      blocking: a.severity === "blocker" || a.code === "AMBIGUOUS_TERM" || a.code === "REQUIRED_MISSING",
      input: null,
    };
    const value = a.path ? at(rb, a.path) : undefined;
    if (a.code === "GRID_CONFLICT") {
      const grids = rb.budgetGrids.filter((g) => (a.detail.gridIds as string[]).includes(g.id));
      return [{ ...base, kind: "contract_problem", path: "/governingGridId", question: `${grids.map((g) => g.label).join(" and ")} price the same visits and disagree. Which one should we bill from?`, options: grids.map((g) => ({ id: g.id, label: g.label })) }];
    }
    if (a.code === "RETROACTIVE_NO_DATE")
      return [{ ...base, kind: "contract_problem", question: "The amendment says its new prices apply retroactively, but gives no start date. From what date do they apply?", input: "date", options: [] }];
    if ((a.code === "AMBIGUOUS_TERM" || a.code === "REQUIRED_MISSING") && a.path && value !== undefined && leaf(value)) {
      const q = askAbout(rb, [], a.path, base.id, a.code);
      const ambiguous = a.code === "AMBIGUOUS_TERM";
      return [{ ...q, ...base, where: base.where.length ? base.where : q.where, kind: ambiguous ? "interpretation" : "confirm_value", input: q.input, question: ambiguous ? `${sentence(a.message)} What does the contract mean?` : q.question, options: q.options.filter((o) => o.id !== "unspecified") }];
    }
    if (a.code === "MISSING_REFERENCED_DOC")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} How should we go on?`, options: [{ id: "later", label: "Go ahead; I'll upload it later" }, { id: "not_needed", label: "It doesn't affect billing" }] }];
    return [{ ...base, kind: a.code === "AMBIGUOUS_TERM" ? "interpretation" : "contract_problem", question: `${sentence(a.message)} Go ahead with the contract as printed?`, options: AS_PRINTED }];
  });
}

/** Scan pages can't be swept for money terms, so a person attests each one (ADR-001 §3, I5); hidden text is shown to a person. */
function pageItems(pages: TextPage[], docs: { id: string; filename: string }[]): ReviewItem[] {
  const name = (id: string) => `“${docs.find((d) => d.id === id)?.filename ?? "the contract"}”`;
  return pages.flatMap((p): ReviewItem[] => {
    const base = { ...BLANK, path: null, blocking: true, input: null, where: [box(p.documentId, p.page)] };
    if (p.source !== "text")
      return [{
        ...base, id: `page:${p.documentId}:${p.page}`, kind: "unaccounted", reason: "SCAN_PAGE",
        question: `Page ${p.page} of ${name(p.documentId)} is a scan, so it can't be searched for money terms. Does it have any that the invoicing master doesn't hold?`,
        options: [{ id: "none", label: "No, nothing the invoicing master doesn't hold" }, { id: "bill_by_hand", label: "Yes: list this page to bill by hand" }],
      }];
    if (p.hidden)
      return [{
        ...base, id: `hidden:${p.documentId}:${p.page}`, kind: "contract_problem", reason: "HIDDEN_TEXT",
        question: `Page ${p.page} of ${name(p.documentId)} has ${p.hidden} ${p.hidden === 1 ? "word" : "words"} no reader can see (white, tiny or invisible text). They're never used as evidence. Do they change any money terms?`,
        options: [{ id: "nothing", label: "No, they change nothing" }],
      }];
    return [];
  });
}

/**
 * After a read: every money value bound to the PDF's own text (or, on scan pages, to the contract's totals), and the
 * questions for a person: values not confirmed, money terms the master doesn't hold, contract problems, scan pages.
 */
export function reviewDraft(port: Pick<ExtractionPort, "bindEvidence" | "reviewFromEvidence">, rb: Rulebook, anomalies: ContractAnomaly[], pages: TextPage[], docs: { id: string; filename: string }[]): Checked {
  const key = (w: { documentId: string; page: number } | undefined) => (w ? `${w.documentId}#${w.page}` : "");
  const textPages = new Set(pages.filter((p) => p.source === "text").map(key));
  const scanPages = new Set(pages.filter((p) => p.source !== "text").map(key));
  const bound = port.bindEvidence(rb, pages);
  const totals = byTotals(rb);
  // A cited page that doesn't exist is neither: its values stay ungrounded and are asked.
  const onScan = (e: ValueEvidence) => scanPages.has(key(e.where[0]));
  const evidence = bound.evidence.map((e): ValueEvidence => (onScan(e) && e.status === "ungrounded" && totals(e.path) ? { ...e, status: "confirmed", note: "Checked by the contract's own totals (scanned page)" } : e));
  const scan = new Set(evidence.filter(onScan).map((e) => e.path));
  const values = port.reviewFromEvidence(evidence, bound.unaccounted, rb).map((i) => (i.path && scan.has(i.path) ? { ...i, reason: "SCAN_VALUE" } : i));
  const asked = new Set(values.flatMap((i) => (i.path ? [i.path] : [])));
  const checked = evidence.filter((e) => textPages.has(key(e.where[0])));
  return {
    evidence,
    review: [...values, ...fromAnomalies(anomalies, rb, asked), ...pageItems(pages, docs)],
    pdfCheck: checked.length ? { values: checked.length, matched: checked.filter((e) => e.status === "confirmed").length } : null,
  };
}

// ---------- answering ----------

const norm = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase() : x);
/** Text ignores case and edge spaces; a list ignores the order of its items too. */
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a.map(norm).sort()) === JSON.stringify(b.map(norm).sort()) : JSON.stringify(norm(a)) === JSON.stringify(norm(b));
export const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** The PDF text at the value's spot as the input type, parsed the way the web parses it (lib/review.ts parseAnswer); undefined when it doesn't parse. */
function parsePrinted(input: ReviewItem["input"], printed: string | null): unknown {
  // the sentence's full stop or comma after the number isn't part of it ("$7,455.00.")
  const t = printed?.trim().replace(/[.,;:]+$/, "");
  if (!t) return undefined;
  if (input === "money") {
    const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(t.replace(/[$,\s]/g, ""));
    if (!m || (m[2] === "" && !m[3])) return undefined;
    const cents = Number.parseInt(m[2] || "0", 10) * 100 + Number.parseInt((m[3] ?? "").padEnd(2, "0") || "0", 10);
    return m[1] ? -cents : cents;
  }
  if (input === "percent" || input === "number") {
    const n = Number(t.replace(/[,%\s]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (input === "date") return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
  return t;
}

/** What picking an option writes: the governing grid, or the value itself for a yes/no or fixed-list question. */
function optionValue(item: ReviewItem, optionId: string, current: unknown): { path: string; value: unknown } | undefined {
  if (item.reason === "GRID_CONFLICT") return { path: "/governingGridId", value: optionId };
  if (!item.path || (item.kind !== "confirm_value" && item.kind !== "interpretation") || current === undefined || !leaf(current)) return undefined;
  return { path: item.path, value: typeof current === "boolean" ? optionId === "true" : optionId };
}

export type Draft = { version: number; byHand: boolean; rulebook: Rulebook; review: ReviewItem[]; evidence: ValueEvidence[]; editors: string[] };

/**
 * POST .../review/:itemId on a draft (mutates `v`). A typed value is compared with the PDF's own text at its spot, or,
 * where nothing is printed there, with the value we hold: matched, or differs (then picking a value settles it as chosen;
 * keeping your own over the PDF text needs a note). Options are chosen. Can't tell is left for the approver. Answering
 * again changes the answer. Returns what was written to the master, for the audit log.
 */
export function answer(v: Draft, itemId: string, raw: unknown, now = new Date().toISOString()) {
  const item = v.review.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, "Question not found");
  const parsed = AnswerReviewBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Say who is answering.");
  const b: z.infer<typeof AnswerReviewBody> = parsed.data;
  // The blind re-type of hand-typed values must be done by someone who didn't type them.
  const retype = v.byHand && item.reason === "spot_check";
  if (retype && v.editors.includes(b.by)) throw new HttpError(409, `${b.by} typed these values, so someone else has to re-type them.`);
  const current = item.path ? at(v.rulebook, item.path) : undefined;
  let value = b.value;
  if (Array.isArray(current) && typeof value === "string") value = value.split(",").map((x) => x.trim()).filter(Boolean);
  const ev = item.path ? v.evidence.find((e) => e.path === item.path) : undefined;
  let outcome: NonNullable<ReviewItem["outcome"]>;
  let set: { path: string; value: unknown } | undefined;
  if (b.cantTell) outcome = "cant_tell";
  else if (item.options.length) {
    if (!item.options.some((o) => o.id === b.optionId)) throw new HttpError(400, "Pick one of the options.");
    set = optionValue(item, b.optionId!, current);
    // A yes/no or fixed-list value is checked like a typed one: against the value we hold (a re-type of a hand-typed
    // value, "This looks wrong"). A missing one has nothing to check against; a second pick after "differs" settles it.
    const checkable = set && item.kind === "confirm_value" && item.reason !== "REQUIRED_MISSING" && !empty(current) && item.outcome !== "differs";
    outcome = checkable && !same(set!.value, current) ? "differs" : checkable ? "matched" : "chosen";
    if (outcome === "differs") set = undefined;
  } else {
    if (value === undefined || value === null || value === "") throw new HttpError(400, "Type a value, or say you can't tell.");
    if (item.path && !fits(v.rulebook, item.path, value)) throw new HttpError(400, "That value can't go in this field. Check what you typed.");
    const printed = parsePrinted(item.input, ev?.printed ?? null);
    const truth = printed ?? (empty(current) ? undefined : current);
    if (item.outcome === "differs") {
      if (printed !== undefined && !same(value, printed) && !b.note?.trim()) throw new HttpError(400, "Add a short note saying why the PDF text is wrong here.");
      outcome = "chosen";
    } else if (truth === undefined) outcome = "chosen";
    else outcome = same(value, truth) ? "matched" : "differs";
    if (outcome !== "differs" && item.path) set = { path: item.path, value };
  }
  const changed = settled(item);
  const picked = item.options.length && !b.cantTell ? optionValue(item, b.optionId!, current)?.value : undefined;
  item.compare = outcome === "differs" ? { typed: picked ?? value, read: current ?? null, printed: ev?.printed ?? null } : null;
  // Only what was answered is kept: a value sent along with a pick or "can't tell" isn't stored.
  const typed = !b.cantTell && !item.options.length;
  item.answer = { value: typed ? value : undefined, optionId: b.optionId, cantTell: b.cantTell, note: b.note?.trim() || undefined, by: b.by, at: now };
  item.sentBack = null;
  item.outcome = outcome;
  const before = set ? at(v.rulebook, set.path) : undefined;
  if (set) {
    const rb = structuredClone(v.rulebook);
    setAt(rb, parsePointer(set.path), set.value);
    v.rulebook = Rulebook.parse(rb);
  }
  if (ev && settled(item)) Object.assign(ev, { status: "attested", note: `Typed by ${b.by}` });
  if (outcome !== "cant_tell" && !retype && !v.editors.includes(b.by)) v.editors.push(b.by);
  return { item, outcome, changed, set: set && { path: set.path, before: before ?? null, after: set.value } };
}

/** Whether `value` can stand at `path` in a valid invoicing master. */
function fits(rb: Rulebook, path: string, value: unknown) {
  const copy = structuredClone(rb);
  try {
    setAt(copy, parsePointer(path), value);
  } catch {
    return false;
  }
  return Rulebook.safeParse(copy).success;
}
