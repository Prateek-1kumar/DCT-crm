import type { Span, TextPage } from "@dct/extraction";
import {
  alsoWithheld,
  type AnswerDraft,
  answerQuestion,
  askAbout,
  askedAsInterpretation,
  at,
  blindLabel,
  type ContractAnomaly,
  cryptoRandom,
  ENUM_LABELS,
  fieldKey,
  fromAnomalies,
  interpretations,
  itemIds,
  leaf,
  openItems,
  type PageBox,
  pickSample,
  provOf,
  type ReviewItem,
  type Rulebook,
  type RulebookVersionDto,
  SAMPLE,
  type ValueEvidence,
  withheldPaths,
} from "@dct/shared";
import { isDeepStrictEqual } from "node:util";
import type { ExtractionPort } from "./extraction/port.js";
import { HttpError, isObj } from "./lib/http.js";
import { getAt, parsePointer } from "./lib/pointer.js";

/**
 * The review queue (ADR-001): the questions a person answers before a draft can be approved after a read or after typing
 * by hand, and blind entry (a value with an open question never leaves the server). How an answer is checked, contract
 * problems as questions and the value questions are in @dct/shared (answer.ts, problems.ts, questions.ts), so the
 * in-browser sample server (apps/web/src/lib/mock/server.ts) runs the same code.
 */

type Checked = Pick<RulebookVersionDto, "evidence" | "review" | "pdfCheck">;
type GridVisit = Rulebook["budgetGrids"][number]["visits"][number];

export { askAbout, at, empty, fromAnomalies, leaf, recheck } from "@dct/shared";

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const box = (documentId: string, page: number): PageBox => ({ documentId, page, box: null });

/** For studies.needs_you: a by-hand draft still being typed counts as one thing to do (the typing), as in the web. */
export const needsYouOf = (v: { status: string; byHand: boolean; review: ReviewItem[] } | undefined) =>
  v?.status !== "draft" ? 0 : v.byHand && !v.review.length ? 1 : openItems(v.review).length;

// ---------- blind entry ----------

/** On a draft, every value with an open question: withheld from every response until it's answered (@dct/shared withheldPaths). */
export const hiddenPaths = withheldPaths;

// The masking itself lives in @dct/shared, so the in-browser sample server withholds exactly the same.
export { blindItem, blindReview, mask } from "@dct/shared";

// ---------- questions at extraction ----------

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

/** answerQuestion (@dct/shared) for the API: a refusal is an HttpError. Mutates `v`. */
export function answer(v: AnswerDraft, itemId: string, raw: unknown, isoDate: (text: string) => string | null, now = new Date().toISOString()) {
  const r = answerQuestion(v, itemId, raw, { isoDate, now });
  if ("refusal" in r) throw new HttpError(r.refusal.status, r.refusal.message);
  return r;
}
