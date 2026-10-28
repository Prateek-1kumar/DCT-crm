import type { Span, TextPage } from "@dct/extraction";
import {
  alsoWithheld,
  amendmentDate,
  AnswerReviewBody,
  armKey,
  askedAsInterpretation,
  type ContractAnomaly,
  cryptoRandom,
  ENUM_LABELS,
  governingGrids,
  interpretations,
  leaf,
  type PageBox,
  pickSample,
  PROSPECTIVE,
  type Provenance,
  type ReviewItem,
  Rulebook,
  type RulebookVersionDto,
  SAMPLE,
  samePerson,
  settled,
  type Unclassified,
  type ValueEvidence,
  withheldPaths,
} from "@dct/shared";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { ExtractionPort } from "./extraction/port.js";
import { itemIds, labelFor } from "./lib/diff.js";
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
export { leaf };

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const box = (documentId: string, page: number): PageBox => ({ documentId, page, box: null });
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

/**
 * Still needs a person: unanswered, answered differently, or a blocking "can't tell" (apps/web/src/lib/review.ts needsYou).
 * A "can't tell" on a question not needed to approve waits for the approver, who still has to settle it: approval takes
 * every question settled (ADR-001 §6).
 */
const openItems = (items: ReviewItem[]) => items.filter((i) => i.outcome === null || i.outcome === "differs" || (i.blocking && i.outcome === "cant_tell"));

/** For studies.needs_you: a by-hand draft still being typed counts as one thing to do (the typing), as in the web. */
export const needsYouOf = (v: { status: string; byHand: boolean; review: ReviewItem[] } | undefined) =>
  v?.status !== "draft" ? 0 : v.byHand && !v.review.length ? 1 : openItems(v.review).length;

// ---------- blind entry ----------

/** On a draft, every value with an open question: withheld from every response until it's answered (@dct/shared withheldPaths). */
export const hiddenPaths = withheldPaths;

// The masking itself lives in @dct/shared, so the in-browser sample server withholds exactly the same.
export { blindItem, blindReview, mask } from "@dct/shared";

const gridOf = (path: string | null) => /^\/budgetGrids\/\d+\//.exec(path ?? "")?.[0];

// ---------- questions at extraction ----------

const fieldKey = (path: string) => {
  const t = path.split("/");
  const [last, prev] = [t.at(-1) ?? "", t.at(-2)];
  return last === "value" && prev && !/^\d+$/.test(prev) ? prev : last;
};
/** A cap's limit is cents when its kind says it caps an amount; every other value's unit is in its own name. */
const amountCap = (rb: Rulebook, path: string) => /\/cap\/n$/.test(path) && at(rb, path.replace(/n$/, "kind")) === "amount";
const inputFor = (rb: Rulebook, path: string, value: unknown): NonNullable<ReviewItem["input"]> => {
  const key = fieldKey(path);
  if (/date|appliesFrom/i.test(key)) return "date";
  if (/cents$/i.test(key) || path.includes("/cells/") || amountCap(rb, path)) return "money";
  if (/pct$/i.test(key)) return "percent";
  if (typeof value === "number" || (value === null && /days|value$|^n$|count|ratio/i.test(key))) return "number";
  return "text";
};

/** A value's label with any amount or % in its names blanked: they would give the answer away (as the binder's questions do). */
const blindLabel = (rb: unknown, path: string) => labelFor(rb, path).replace(/\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%/g, "…");

/**
 * A blind question about one value: "This looks wrong" (reason "reported"), the re-type sample of hand-typed values
 * ("spot_check") and of a read's confirmed values (SAMPLE), a required value the read didn't find. Yes/no and fixed-list
 * values are picked; the rest typed.
 */
export function askAbout(rb: Rulebook, evidence: ValueEvidence[], path: string, id: string, reason: string): ReviewItem {
  const value = at(rb, path);
  const label = blindLabel(rb, path);
  const list = typeof value === "string" ? ENUM_LABELS[fieldKey(path)] : undefined;
  const options =
    typeof value === "boolean" ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }]
    : list && (value as string) in list ? Object.entries(list).map(([k, l]) => ({ id: k, label: l }))
    : [];
  const input = options.length ? null : inputFor(rb, path, value);
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

/**
 * One flag per root cause: a check about a value that's being typed is covered by its question, and a total that doesn't
 * add up isn't asked while a number in its grid's visits, rows or per-patient totals is being typed (its overhead % alone
 * doesn't hold it back). Held back is never dropped: recheck runs these on the typed numbers. An overhead label that
 * doesn't match what the amounts compute to is asked whatever is being typed.
 * ponytail: per grid, not per visit. Upgrade: only the visit whose numbers are asked.
 */
function heldBack(a: ContractAnomaly, asked: Set<string>): boolean {
  if (a.code === "OVERHEAD_LABEL_MISMATCH") return false;
  if (a.path && asked.has(a.path)) return true;
  const grid = gridOf(a.path);
  return ARITHMETIC.has(a.code) && !!grid && [...asked].some((p) => p.startsWith(grid) && /^(visits|procedures|perPatientTotals)\//.test(p.slice(grid.length)));
}

// The cross-read, its text-layer page check and self-reported confidence are not evidence (ADR-001 §4, §6): the binder replaces them.
const SUPERSEDED = new Set<ContractAnomaly["code"]>(["TEXT_LAYER_MISMATCH", "AI_DISAGREEMENT", "LOW_CONFIDENCE"]);
const ARITHMETIC = new Set<ContractAnomaly["code"]>(["VISIT_TOTAL_MISMATCH", "PER_PATIENT_TOTAL_MISMATCH"]);
const AS_PRINTED = [{ id: "as_printed", label: "Yes, go ahead as printed" }];
/** The contract itself is wrong here, so the site asks the sponsor: the note is that query. */
const SPONSOR = "What should we ask the sponsor?";
const ASK_SPONSOR = { id: "ask_sponsor", label: "Ask the sponsor; until they answer, bill it as printed", note: SPONSOR };
/** A question that's not needed to approve clears by a choice, or by one of these reasons with a note (ADR-001 §6). */
const REVIEW_REASONS = [{ id: "as_printed", label: "Bill it as the contract prints it", note: "Why is that right?" }, ASK_SPONSOR];

type Visit = Rulebook["budgetGrids"][number]["visits"][number];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * What a total the contract prints should be, from the numbers it's made of: a visit's parts, a visit's grid rows (the
 * subtotal, less what isn't a procedure), or every visit for a per-patient total. undefined when it can't be worked out.
 * This is what "the sum governs" writes into the master (ARITHMETIC_MISMATCH), so billing uses it.
 */
function sumAt(rb: Rulebook, path: string): number | undefined {
  const m = /^\/budgetGrids\/(\d+)\/(?:visits\/(\d+)\/(totalCents|procedureSubtotalCents|nonProcedureCents)|perPatientTotals\/\d+\/cents)$/.exec(path);
  const g = m ? rb.budgetGrids[Number(m[1])] : undefined;
  if (!g || !m) return undefined;
  if (!m[2]) return sum(g.visits.map((v) => v.totalCents));
  const v: Visit | undefined = g.visits[Number(m[2])];
  if (!v) return undefined;
  const cells = (cat?: "non_procedure") => sum(g.procedures.filter((p) => !cat || p.category === cat).map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number"));
  const out =
    m[3] === "totalCents" ? (v.procedureSubtotalCents === null || v.overheadCents === null ? undefined : v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0))
    : m[3] === "procedureSubtotalCents" ? cells() - (v.nonProcedureCents ?? 0)
    : cells("non_procedure");
  return out !== undefined && out >= 0 ? out : undefined;
}

/** "Which number governs" for a total that doesn't add up, in words for the number it's about. */
const ARITHMETIC_WORDS = (path: string) =>
  /perPatientTotals/.test(path) ? { printed: "The per-patient total as printed", sum: "The visit totals added up" }
  : /totalCents$/.test(path) ? { printed: "The visit total as printed", sum: "Its subtotal, overhead and non-procedure amounts added up" }
  : { printed: "The subtotal as printed", sum: "The grid's rows added up" };

/**
 * One question per contract problem the checks found. A blocker clears by a typed value or a pick (I6); one that's not
 * needed to approve clears by a pick or a reason from a fixed list with a note, never free text alone (ADR-001 §6).
 * Picks the API can't carry out (remove a grid, bill a duplicate one way) aren't offered.
 */
export function fromAnomalies(anomalies: ContractAnomaly[], rb: Rulebook, asked: Set<string>): ReviewItem[] {
  const chosen = governingGrids(rb);
  return anomalies.flatMap((a): ReviewItem[] => {
    if (SUPERSEDED.has(a.code) || heldBack(a, asked)) return [];
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
      // an arm whose choice was carried from the live version, its grids unchanged (carryGrid), isn't asked again
      if (grids.some((g) => grids.some((x) => x.id === chosen.get(armKey(g))))) return [];
      const arm = grids.find((g) => g.arm)?.arm;
      // a choice, not a value: nothing to withhold, and one question per arm
      return [{ ...base, kind: "contract_problem", path: null, question: `${arm ? `${arm}: ` : ""}${grids.map((g) => g.label).join(" and ")} price the same visits and disagree. Which one should we bill from?`, options: grids.map((g) => ({ id: g.id, label: g.label })) }];
    }
    if (a.code === "RETROACTIVE_NO_DATE")
      return [{ ...base, kind: "contract_problem", question: "The amendment says its new prices apply retroactively, but gives no start date. From what date do they apply?", input: "date", options: [] }];
    if ((a.code === "AMBIGUOUS_TERM" || a.code === "REQUIRED_MISSING") && a.path && value !== undefined && leaf(value)) {
      const q = askAbout(rb, [], a.path, base.id, a.code);
      const ambiguous = a.code === "AMBIGUOUS_TERM";
      return [{ ...q, ...base, where: base.where.length ? base.where : q.where, kind: ambiguous ? "interpretation" : "confirm_value", input: q.input, question: ambiguous ? `${sentence(a.message)} What does the contract mean?` : q.question, options: q.options.filter((o) => o.id !== "unspecified") }];
    }
    if (ARITHMETIC.has(a.code) && a.path) {
      const words = ARITHMETIC_WORDS(a.path);
      const options = [{ id: "printed", label: words.printed, note: SPONSOR }, ...(sumAt(rb, a.path) !== undefined ? [{ id: "sum", label: words.sum, note: SPONSOR }] : [])];
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} Which should we bill?`, options }];
    }
    if (a.code === "OVERHEAD_LABEL_MISMATCH")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} Which governs?`, options: [{ id: "amounts", label: "The printed amounts: the label is wrong" }, ASK_SPONSOR] }];
    if (a.code === "MISSING_REFERENCED_DOC")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} How should we go on?`, options: [{ id: "later", label: "Go ahead; I'll upload it later" }, { id: "not_needed", label: "It doesn't affect billing", note: "Why doesn't it affect billing?" }] }];
    if (a.code === "DUPLICATE_ITEM")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} How should it be billed?`, options: [{ id: "both", label: "They're different items: bill both" }, { ...ASK_SPONSOR, label: "Ask the sponsor whether it's billed twice" }] }];
    const kind = a.code === "AMBIGUOUS_TERM" ? "interpretation" : "contract_problem";
    if (!base.blocking) return [{ ...base, kind, question: `${sentence(a.message)} How should we go on?`, options: REVIEW_REASONS }];
    return [{ ...base, kind, question: `${sentence(a.message)} Go ahead with the contract as printed?`, options: AS_PRINTED }];
  });
}

/** Checks whose truth depends on numbers a person may type: held back while they're open (heldBack), then run again. */
const RECHECKED = new Set<ContractAnomaly["code"]>([...ARITHMETIC, "OVERHEAD_LABEL_MISMATCH"]);

/**
 * The checks don't run again by themselves, so a total held back while its grid's numbers were typed would never be
 * asked. Once the last number of a grid is answered, its arithmetic checks run on the typed numbers, and each finding is
 * asked unless it's a question here already, or the read found it on the same numbers and asked it then (a correction
 * draft's checks were settled on the live version). New findings (typed numbers that no longer add up) are asked too.
 * A contract typed by hand ran its checks when typing was marked done (`anomalies`), so the same holds for it.
 */
export function recheck(checks: (rb: Rulebook) => ContractAnomaly[], v: Pick<Draft, "rulebook" | "review"> & { anomalies: ContractAnomaly[] }, path: string): ReviewItem[] {
  const grid = gridOf(path);
  if (!grid || openItems(v.review).some((i) => i.kind === "confirm_value" && i.path?.startsWith(grid))) return [];
  // what the read asked: its value questions, and the checks it didn't hold back
  const readAsked = new Set(v.review.flatMap((i) => (/^(confirm|spot|missing):/.test(i.id) && i.path ? [i.path] : [])));
  const askedAtRead = new Set(v.anomalies.filter((a) => !SUPERSEDED.has(a.code) && !heldBack(a, readAsked)).map((a) => a.id));
  const read = new Map(v.anomalies.map((a) => [a.id, a.message]));
  const have = new Set(v.review.map((i) => i.id));
  const found = checks(v.rulebook).filter(
    (a) => RECHECKED.has(a.code) && gridOf(a.path) === grid && !have.has(`anomaly:${a.id}`) && !(read.get(a.id) === a.message && askedAtRead.has(a.id)),
  );
  return fromAnomalies(found, v.rulebook, new Set());
}

/** Answers that list a page or a sentence to bill by hand (ADR-001 §7): the term goes on the master's unclassified list. */
const BILL_BY_HAND = new Set(["UNACCOUNTED_TERM", "SCAN_PAGE", "PICTURE_PAGE", "CORRECTION_LOST"]);
/** A page nothing can search (a scan, a picture) has no words to list, so the person says what's on it. */
const PAGE_OPTIONS = [
  { id: "none", label: "No, nothing the invoicing master doesn't hold" },
  { id: "bill_by_hand", label: "Yes: list this page to bill by hand", note: "What on this page is billed by hand? Name each term and its amount." },
];

/**
 * Scan pages can't be swept for money terms, so a person attests each one (ADR-001 §3, I5), and so does a text page with a
 * picture big enough to hold prices (a budget pasted in as an image: `largePicture`, from the text layer). Hidden text is
 * shown to a person.
 */
function pageItems(pages: TextPage[], docs: { id: string; filename: string }[]): ReviewItem[] {
  const name = (id: string) => `“${docs.find((d) => d.id === id)?.filename ?? "the contract"}”`;
  return pages.flatMap((p): ReviewItem[] => {
    const base = { ...BLANK, path: null, blocking: true, input: null, where: [box(p.documentId, p.page)] };
    if (p.source !== "text")
      return [{
        ...base, id: `page:${p.documentId}:${p.page}`, kind: "unaccounted", reason: "SCAN_PAGE",
        question: `Page ${p.page} of ${name(p.documentId)} is a scan, so it can't be searched for money terms. Does it have any that the invoicing master doesn't hold?`,
        options: PAGE_OPTIONS,
      }];
    const out: ReviewItem[] = [];
    if (p.largePicture)
      out.push({
        ...base, id: `picture:${p.documentId}:${p.page}`, kind: "unaccounted", reason: "PICTURE_PAGE",
        question: `Page ${p.page} of ${name(p.documentId)} has a picture that may contain prices, and a picture can't be searched for money terms. Does it have any that the invoicing master doesn't hold?`,
        options: PAGE_OPTIONS,
      });
    if (p.hidden)
      out.push({
        ...base, id: `hidden:${p.documentId}:${p.page}`, kind: "contract_problem", reason: "HIDDEN_TEXT",
        question: `Page ${p.page} of ${name(p.documentId)} has ${p.hidden} ${p.hidden === 1 ? "word" : "words"} no reader can see (white, tiny or invisible text). They're never used as evidence. Do they change any money terms?`,
        options: [{ id: "nothing", label: "No, they change nothing" }],
      });
    return out;
  });
}

const whereKey = (w: PageBox) => JSON.stringify([w.documentId, w.page, w.box]);
const cents = (t: string) => Math.round(Number(t.replace(/[^\d.]/g, "")) * 100);

/** The words and figures of a money term the master doesn't hold, from the PDF's text: what a "bill by hand" answer lists. */
function termOf(spans: Span[]): NonNullable<ReviewItem["term"]> | undefined {
  if (!spans.length) return undefined;
  const text = (s: Span) => s.words.map((w) => w.text).join("");
  // a number in a table row is an amount only when it's printed like one
  const amounts = spans.filter((s) => s.kind === "amount" || (s.kind === "grid_number" && /\$|\d,\d{3}|\.\d{2}\)?$/.test(text(s)))).map((s) => cents(text(s)));
  const pct = spans.find((s) => s.kind === "percent");
  const days = spans.map((s) => (s.kind === "days" ? /(\d+)\)?[\s-]*(?:calendar|business|working)?\s*days?\b/i.exec(s.words.map((w) => w.text).join(" ")) : null)).find(Boolean);
  return {
    quote: spans[0]!.text,
    amounts: amounts.filter((c) => Number.isSafeInteger(c)),
    ...(pct ? { pct: Number(text(pct).replace(/[^\d.]/g, "")) } : {}),
    ...(days ? { days: Number(days[1]) } : {}),
  };
}

/** A correction the amendment's read couldn't carry over (domain.ts carryCorrections' `skipped`). */
export type Skipped = { path: string; before: unknown; after: unknown; by?: string; items?: string[]; reason: string };
/** An amendment's read: the live version it follows, and what of its corrections didn't carry. */
export type Carried = { from: number; live: Rulebook; skipped: Skipped[] };

/**
 * Test seam: the randomness the blind sample is drawn with. Cryptographic, so nobody can foresee which values are
 * re-typed; tests pin it to see which ones are.
 */
export const sampling: { random: () => number } = { random: cryptoRandom };

/** A cap's limit or ratio while its kind is asked: its question would name the kind, so it waits for that answer (followUps). */
const capWaits = (path: string, asking: ReadonlySet<string>) => /\/cap\/(?:n|ratio)$/.test(path) && asking.has(path.replace(/(?:n|ratio)$/, "kind"));

/**
 * After a read: every money value bound to the PDF's own text (or, on scan pages, to the contract's totals), and the
 * questions for a person: values not confirmed, money terms the master doesn't hold (with their words, to list them to
 * bill by hand), contract problems, the interpretations picked blind, pages nothing can search, corrections an
 * amendment's read couldn't carry over, and the blind re-type of up to 10 confirmed values (ADR-001 §6). `amendment`:
 * the read includes an amendment. Returns what to say on the draft (`warnings`) and the skipped corrections with where
 * each is asked now (`skipped`, for the log).
 */
export function reviewDraft(
  port: Pick<ExtractionPort, "bindEvidence" | "reviewFromEvidence">,
  rb: Rulebook,
  anomalies: ContractAnomaly[],
  pages: TextPage[],
  docs: { id: string; filename: string }[],
  opts: { amendment?: boolean; carried?: Carried | null } = {},
): Checked & { warnings: string[]; skipped: (Skipped & { askedAt?: string })[] } {
  const key = (w: { documentId: string; page: number } | undefined) => (w ? `${w.documentId}#${w.page}` : "");
  const textPages = new Set(pages.filter((p) => p.source === "text").map(key));
  const scanPages = new Set(pages.filter((p) => p.source !== "text").map(key));
  const bound = port.bindEvidence(rb, pages);
  const totals = byTotals(rb);
  // A cited page that doesn't exist is neither: its values stay ungrounded and are asked.
  const onScan = (e: ValueEvidence) => scanPages.has(key(e.where[0]));
  const evidence = bound.evidence.map((e): ValueEvidence => (onScan(e) && e.status === "ungrounded" && totals(e.path) ? { ...e, status: "confirmed", note: "Checked by the contract's own totals (scanned page)" } : e));
  const scan = new Set(evidence.filter(onScan).map((e) => e.path));
  // each money-term question is about the spans at its spots (reviewFromEvidence groups them by line or sentence)
  const spans = new Map(bound.unaccounted.map((s) => [whereKey(s.where), s]));
  const values = port.reviewFromEvidence(evidence, bound.unaccounted, rb).map((i): ReviewItem => {
    if (i.path && scan.has(i.path)) return { ...i, reason: "SCAN_VALUE" };
    if (i.reason !== "UNACCOUNTED_TERM") return i;
    const term = termOf(i.where.flatMap((w) => spans.get(whereKey(w)) ?? []));
    return term ? { ...i, term } : i;
  });
  const asked = new Set(values.flatMap((i) => (i.path ? [i.path] : [])));
  const checked = evidence.filter((e) => textPages.has(key(e.where[0])));
  const interp = interpretations(rb, { amendment: !!opts.amendment, anomalies });
  const asking = new Set(interp.map((i) => i.path!));
  const review = [
    // a value asked as an interpretation is asked once, there (the start date: typed, or "prospective only")
    ...values.filter((i) => !(i.path && (asking.has(i.path) || capWaits(i.path, asking)))),
    ...fromAnomalies(anomalies.filter((a) => !askedAsInterpretation(a, asking)), rb, asked),
    ...interp,
    ...pageItems(pages, docs),
  ];
  const lost = opts.carried ? uncarried(rb, evidence, opts.carried, new Set(review.flatMap((i) => (i.path ? [i.path] : []))), asking) : { items: [], warnings: [], skipped: [] };
  review.push(...lost.items);
  // Drawn once, here, and kept as questions: a reload or a repeat never draws again. Never a value with a question (nor
  // one held back with it): it's typed blind already.
  const taken = new Set(review.flatMap((i) => (i.path ? [i.path, ...alsoWithheld(i.path)] : [])));
  review.push(...pickSample(evidence, taken, sampling.random).map((p) => askAbout(rb, evidence, p, `sample:${p}`, SAMPLE)));
  return {
    evidence,
    review,
    pdfCheck: checked.length ? { values: checked.length, matched: checked.filter((e) => e.status === "confirmed").length } : null,
    warnings: lost.warnings,
    skipped: lost.skipped,
  };
}

/** A value billing reads: a number, yes/no, a fixed-list value, a date or a cell, or what the holdback is taken from. */
function billing(path: string, values: unknown[]) {
  const key = fieldKey(path);
  if (/^\/study\/(?!effectiveDate)|^\/(?:documents|referencedDocuments)\//.test(path)) return false;
  return path === "/holdback/appliesTo" || path.includes("/cells/") || !!ENUM_LABELS[key] || /date|appliesFrom|kind$/i.test(key) || values.some((v) => typeof v === "number" || typeof v === "boolean");
}

/**
 * Where an item a correction was about is in the new read, when it moved (the amendment added a fee in front, say): the
 * one place whose items have the same identities (itemIds). undefined when there's none, or more than one.
 */
function movedTo(rb: Rulebook, path: string, items: string[] | undefined): string | undefined {
  if (!items) return undefined;
  try {
    let found: string[][] = [[]];
    for (const t of parsePointer(path))
      found = found.flatMap((p) => {
        const node = getAt(rb, p);
        if (!Array.isArray(node)) return [[...p, t]];
        return node.map((_, i) => [...p, String(i)]).filter((q) => isDeepStrictEqual(itemIds(rb, q), items.slice(0, itemIds(rb, q).length)));
      });
    const hits = found.filter((p) => getAt(rb, p) !== undefined && isDeepStrictEqual(itemIds(rb, p), items));
    return hits.length === 1 ? `/${hits[0]!.map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : undefined;
  } catch {
    return undefined; // the path no longer fits the new read's shape
  }
}

/**
 * Corrections made on the live version that an amendment's read couldn't carry over (anything but "already equal"): each
 * is said on the draft in plain words, so nobody takes it as carried. One about a value billing reads is asked: blind,
 * where the new read has that value (a moved item found by its identity), unless it's asked already (a cap's limit once
 * its kind is: its evidence stops counting as confirmed); or, where the new read doesn't have it at all, whether it's
 * still in the contract (bill it by hand if so). No value is put in words.
 */
function uncarried(rb: Rulebook, evidence: ValueEvidence[], c: Carried, asked: Set<string>, asking: ReadonlySet<string>) {
  const items: ReviewItem[] = [];
  const warnings: string[] = [];
  const skipped: (Skipped & { askedAt?: string })[] = [];
  for (const k of c.skipped) {
    if (k.reason === "already_equal") {
      skipped.push(k);
      continue;
    }
    const who = k.by ?? "Someone";
    const label = blindLabel(c.live, k.path);
    const said = `A correction from version ${c.from} wasn't carried over: ${label}, corrected by ${who}.`;
    const now = k.reason === "item_moved" ? movedTo(rb, k.path, k.items) : k.reason === "path_missing" ? undefined : k.path;
    const value = now === undefined ? undefined : at(rb, now);
    if (!billing(k.path, [k.before, k.after])) {
      warnings.push(`${said} Check it in the invoicing master.`);
      skipped.push(k);
    } else if (now !== undefined && value !== undefined && leaf(value)) {
      // a cap's limit waits for its kind (capWaits): not confirmed any more, it's asked once the kind is answered
      if (capWaits(now, asking)) {
        const e = evidence.find((x) => x.path === now);
        const note = `A correction from version ${c.from} wasn't carried over`;
        if (!e) evidence.push({ path: now, status: "ungrounded", where: [], printed: null, note });
        else if (e.status === "confirmed") Object.assign(e, { status: "ungrounded", note });
      } else if (!asked.has(now))
        items.push({
          ...askAbout(rb, evidence, now, `carried:${now}`, "CORRECTION_NOT_CARRIED"),
          question: `${who} corrected ${label} on version ${c.from}, but the amendment's reading has a different value there, so the correction wasn't carried over. What does the contract print for it now?`,
        });
      asked.add(now);
      warnings.push(`${said} The amendment's reading has a different value there, so it's asked again in Needs you.`);
      skipped.push({ ...k, askedAt: now });
    } else {
      const src = provOf(c.live, k.path)?.source;
      items.push({
        ...BLANK,
        id: `lost:${k.path}`,
        kind: "unaccounted",
        reason: "CORRECTION_LOST",
        path: null,
        question: `${who} corrected ${label} on version ${c.from}, but the amendment's reading doesn't have it any more. Is it still in the contract?`,
        input: null,
        // listing it needs a page to point at
        options: [{ id: "removed", label: "No, the amendment removed it" }, ...(src ? [{ id: "bill_by_hand", label: "Yes: list it to bill by hand", note: "What is billed by hand? Name the term and its amount." }] : [])],
        where: src ? [box(src.documentId, src.page)] : [],
        blocking: true,
      });
      warnings.push(`${said} The amendment's reading doesn't have it any more, so Needs you asks whether it's still in the contract.`);
      skipped.push(k);
    }
  }
  return { items, warnings, skipped };
}

/**
 * Placeholders in a contract typed by hand: the blank form (manualRulebook, and the web's blank pieces) has to put a number
 * where the schema allows no empty (a visit's total 0, a holdback's % 0), and the form shows every number nobody typed as
 * an empty box. So any number in it that nobody typed (no evidence row at its path) was never seen by a person and must
 * be asked like a missing value. Not numbers that only order or describe the master (schemaVersion, a visit's order,
 * provenance).
 */
export function placeholders(rb: Rulebook, evidence: ValueEvidence[]): string[] {
  const typed = new Set(evidence.map((e) => e.path));
  const out: string[] = [];
  const walk = (node: unknown, path: string, key: string) => {
    if (key === "prov" || key === "schemaVersion" || key === "order") return;
    if (typeof node === "number") return void (typed.has(path) || out.push(path));
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}/${i}`, String(i)));
    else if (isObj(node)) for (const [k, x] of Object.entries(node)) walk(x, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, k);
  };
  walk(rb, "", "");
  return out;
}

/**
 * When typing by hand is marked done: the contract's checks run on what was typed, as they do after a read, and each
 * placeholder is asked as a missing value. `asked`: the re-typed sample's paths, which hold back checks about them.
 */
export function byHandQuestions(rb: Rulebook, evidence: ValueEvidence[], anomalies: ContractAnomaly[], asked: Set<string>): ReviewItem[] {
  const missing = placeholders(rb, evidence).map((p) => askAbout(rb, evidence, p, `missing:${p}`, "REQUIRED_MISSING"));
  return [...missing, ...fromAnomalies(anomalies, rb, new Set([...asked, ...missing.map((i) => i.path!)]))];
}

// ---------- answering ----------

const norm = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase() : x);
/** Text ignores case and edge spaces; a list ignores the order of its items too. */
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a.map(norm).sort()) === JSON.stringify(b.map(norm).sort()) : JSON.stringify(norm(a)) === JSON.stringify(norm(b));
export const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/**
 * The PDF text at the value's spot as the input type, parsed the way the web parses it (lib/review.ts parseAnswer), and a
 * date the way the binder reads it ("August 22, 2025"); undefined when it doesn't parse.
 */
function parsePrinted(input: ReviewItem["input"], printed: string | null, isoDate: (text: string) => string | null): unknown {
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
  if (input === "date") return isoDate(t) ?? undefined;
  return t;
}

/**
 * What picking an option writes: the arm's governing grid (the other arms' picks stay), the sum of a total's parts when
 * the sum governs, or the value itself for a yes/no or fixed-list question.
 */
function optionValue(rb: Rulebook, item: ReviewItem, optionId: string, current: unknown): { path: string; value: unknown } | undefined {
  if (item.reason === "GRID_CONFLICT") {
    const arm = new Set(item.options.map((o) => o.id));
    return { path: "/governingGridIds", value: [...(rb.governingGridIds ?? []).filter((id) => !arm.has(id)), optionId] };
  }
  if (ARITHMETIC.has(item.reason as ContractAnomaly["code"])) {
    const value = optionId === "sum" && item.path ? sumAt(rb, item.path) : undefined;
    return value === undefined ? undefined : { path: item.path!, value };
  }
  // "prospective only": the amendment's own date, as its label shows it
  if (optionId === PROSPECTIVE && item.path === "/appliesFrom/value") {
    const d = amendmentDate(rb);
    return d ? { path: item.path, value: d } : undefined;
  }
  if (!item.path || (item.kind !== "confirm_value" && item.kind !== "interpretation") || current === undefined || !leaf(current)) return undefined;
  return { path: item.path, value: typeof current === "boolean" ? optionId === "true" : optionId };
}

/** A few words for a term on the bill-by-hand list: its sentence, cut at a word. */
const shortLabel = (quote: string) => {
  const t = quote.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, "")}…`;
};

/** The entry a "bill by hand" answer puts on the master's unclassified list: the term's own words, or the page to read. */
function unclassifiedOf(rb: Rulebook, item: ReviewItem, note: string | undefined): Unclassified {
  const w = item.where[0]!;
  const title = rb.documents.find((d) => d.id === w.documentId)?.title ?? "the contract";
  const t = item.term;
  return {
    label: t ? shortLabel(t.quote) : `Page ${w.page} of “${title}”`,
    quote: t?.quote ?? "",
    page: w.page,
    amounts: t?.amounts ?? [],
    ...(t?.pct !== undefined ? { pct: t.pct } : {}),
    ...(t?.days !== undefined ? { days: t.days } : {}),
    note: note ?? "",
    prov: { source: { documentId: w.documentId, page: w.page }, confidence: 1, method: "manual", crossCheck: "not_checked" },
    itemId: item.id,
  };
}

type Draft = { version: number; byHand: boolean; rulebook: Rulebook; review: ReviewItem[]; evidence: ValueEvidence[]; editors: string[] };

const WHY = "Add a short note saying why the PDF text is wrong here.";
const WHERE = "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note.";

/**
 * POST .../review/:itemId on a draft (mutates `v`). A typed value is compared with the PDF's own text at its spot, or,
 * where nothing is printed there, with the value we hold: matched, or differs (then picking a value settles it as chosen).
 * Settling a differs needs a note: keeping your own value over the PDF text says why the text is wrong; where the PDF's
 * text prints nothing (a scan, a value the check didn't find, a pick), either value says where the page prints it, and the
 * answer is marked `noPdfText` for the approver. Options are chosen; an option with a `note` needs one (a reason, ADR-001
 * §6). An interpretation's pick is checked against the read's value like a typed one: one that differs is shown with it,
 * and the second pick settles it. A question with options and an input (the start date: typed, or "prospective only")
 * takes either. Can't tell is left for the approver, and doesn't clear anything. "Bill by hand" lists the term on the
 * master; answering it any other way takes it off again. A random spot check (SAMPLE) settled with a value other than the
 * one the PDF check confirmed has missed (`missed`, ADR-001 §6). Returns what was written to the master, for the audit
 * log, and whether the sample has just missed.
 */
export function answer(v: Draft, itemId: string, raw: unknown, isoDate: (text: string) => string | null, now = new Date().toISOString()) {
  const item = v.review.find((i) => i.id === itemId);
  if (!item) throw new HttpError(404, "Question not found");
  const parsed = AnswerReviewBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Say who is answering.");
  const b: z.infer<typeof AnswerReviewBody> = parsed.data;
  // The blind re-type of hand-typed values must be done by someone who didn't type them, nor change any value since.
  const retype = v.byHand && item.reason === "spot_check";
  if (retype && v.editors.some((e) => samePerson(e, b.by))) {
    const typist = v.evidence.some((e) => e.note?.startsWith("Typed by hand by ") && samePerson(e.note.slice("Typed by hand by ".length), b.by));
    throw new HttpError(409, typist ? `${b.by} typed these values, so someone else has to re-type them.` : `${b.by} changed a value on this contract, so someone else has to re-type the rest.`);
  }
  const current = item.path ? at(v.rulebook, item.path) : undefined;
  let value = b.value;
  if (Array.isArray(current) && typeof value === "string") value = value.split(",").map((x) => x.trim()).filter(Boolean);
  const ev = item.path ? v.evidence.find((e) => e.path === item.path) : undefined;
  const note = b.note?.trim();
  // The same answer again, from the same person, to a question it settled (a retry, another tab) changes nothing. Checked
  // again, a value kept over the PDF's text would read as differing from it once more, and reopen the question.
  const a = item.answer;
  if (settled(item) && a && samePerson(a.by, b.by) && !b.cantTell && (a.optionId ?? null) === (b.optionId ?? null) && (a.note ?? "") === (note ?? "") && (b.optionId !== undefined || same(a.value, value)))
    return { item, outcome: item.outcome!, changed: false, set: undefined, listed: undefined, missed: false, unchanged: true as const };
  // a pick, unless the question also takes a typed value and none was picked
  const pick = item.options.length > 0 && (b.optionId !== undefined || !item.input);
  let outcome: NonNullable<ReviewItem["outcome"]>;
  let set: { path: string; value: unknown } | undefined;
  let noPdfText = false;
  if (b.cantTell) outcome = "cant_tell";
  else if (pick) {
    const option = item.options.find((o) => o.id === b.optionId);
    if (!option) throw new HttpError(400, "Pick one of the options.");
    if (option.note && !note) throw new HttpError(400, `Add a short note for this answer: ${option.note.replace(/^./, (c) => c.toLowerCase())}`);
    set = optionValue(v.rulebook, item, option.id, current);
    // A yes/no or fixed-list value is checked like a typed one: against the value we hold (a re-type of a hand-typed
    // value, "This looks wrong", an interpretation). A missing one has nothing to check against, nor does a read that
    // says the contract doesn't state it; a second pick after "differs" settles it.
    const checkable = set && (item.kind === "confirm_value" || item.kind === "interpretation") && item.reason !== "REQUIRED_MISSING" && !empty(current) && current !== "unspecified" && item.outcome !== "differs";
    // a pick is never in the PDF's text
    if (item.outcome === "differs" && !note) throw new HttpError(400, WHERE);
    noPdfText = item.outcome === "differs";
    outcome = checkable && !same(set!.value, current) ? "differs" : checkable ? "matched" : "chosen";
    if (outcome === "differs") set = undefined;
  } else {
    if (value === undefined || value === null || value === "") throw new HttpError(400, "Type a value, or say you can't tell.");
    if (item.path && !fits(v.rulebook, item.path, value)) throw new HttpError(400, "That value can't go in this field. Check what you typed.");
    const printed = parsePrinted(item.input, ev?.printed ?? null, isoDate);
    // a missing value (or a placeholder of the blank form) holds nothing to compare with
    const truth = printed ?? (empty(current) || item.reason === "REQUIRED_MISSING" ? undefined : current);
    if (item.outcome === "differs") {
      if (printed === undefined && !note) throw new HttpError(400, WHERE);
      if (printed !== undefined && !same(value, printed) && !note) throw new HttpError(400, WHY);
      noPdfText = printed === undefined;
      outcome = "chosen";
    } else if (truth === undefined) outcome = "chosen";
    else outcome = same(value, truth) ? "matched" : "differs";
    if (outcome !== "differs" && item.path) set = { path: item.path, value };
  }
  const changed = settled(item);
  const picked = pick && !b.cantTell ? optionValue(v.rulebook, item, b.optionId!, current)?.value : undefined;
  item.compare = outcome === "differs" ? { typed: picked ?? value, read: current ?? null, printed: ev?.printed ?? null } : null;
  // Only what was answered is kept: a value sent along with a pick or "can't tell" isn't stored.
  const typed = !b.cantTell && !pick;
  item.answer = { value: typed ? value : undefined, optionId: b.optionId, cantTell: b.cantTell, note: note || undefined, ...(noPdfText ? { noPdfText } : {}), by: b.by, at: now };
  item.sentBack = null;
  item.outcome = outcome;
  const before = set ? at(v.rulebook, set.path) : undefined;
  const rb = structuredClone(v.rulebook);
  if (set) setAt(rb, parsePointer(set.path), set.value);
  // No limit: a cap's figures go with its kind. Nothing is billed by them, so nothing is left to confirm or to ask.
  if (set && /\/cap\/kind$/.test(set.path) && set.value === "none")
    for (const p of alsoWithheld(set.path)) {
      setAt(rb, parsePointer(p), null);
      v.evidence = v.evidence.filter((e) => e.path !== p);
    }
  // the arm's choice replaces a version's single pick from before per-arm choices, if that was one of this arm's grids
  if (item.reason === "GRID_CONFLICT" && set && item.options.some((o) => o.id === rb.governingGridId)) rb.governingGridId = null;
  // the bill-by-hand list follows the answer: on for "bill by hand", off for anything else
  let listed: { added?: string; removed?: string } | undefined;
  if (BILL_BY_HAND.has(item.reason)) {
    const was = (rb.unclassified ?? []).find((u) => u.itemId === item.id);
    rb.unclassified = (rb.unclassified ?? []).filter((u) => u.itemId !== item.id);
    if (outcome === "chosen" && b.optionId === "bill_by_hand") rb.unclassified.push(unclassifiedOf(rb, item, note));
    const is = rb.unclassified.find((u) => u.itemId === item.id);
    if (is && !was) listed = { added: is.label };
    else if (was && !is) listed = { removed: was.label };
  }
  if (set || listed) v.rulebook = Rulebook.parse(rb);
  if (item.path && settled(item)) {
    // what a person typed or chose is attested; one with no ledger entry yet (a value the read never had) gets one
    if (ev) Object.assign(ev, { status: "attested", note: `Typed by ${b.by}` });
    else if (set?.path === item.path) v.evidence.push({ path: item.path, status: "attested", where: item.where, printed: null, note: `Typed by ${b.by}` });
  }
  // Maker-checker: everyone who decides something is an editor. A re-typer (of hand-typed values, or of the read's random
  // sample) isn't, unless their answer changes a value: then they corrected it.
  const wrote = !!set && !same(before ?? null, set.value);
  if (outcome !== "cant_tell" && (!(retype || item.reason === SAMPLE) || wrote) && !v.editors.some((e) => samePerson(e, b.by))) v.editors.push(b.by);
  // The sample missed: a value the PDF check confirmed, kept different after looking again. Once missed, it stays missed.
  const missed = item.reason === SAMPLE && !item.missed && outcome === "chosen" && wrote;
  if (missed) item.missed = true;
  return { item, outcome, changed, set: set && { path: set.path, before: before ?? null, after: set.value }, listed, missed, unchanged: false as const };
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
