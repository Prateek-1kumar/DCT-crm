import type { ContractAnomaly } from "./anomaly";
import { leaf } from "./blind";
import { deepEqual, itemIds } from "./diff";
import { AnswerReviewBody, type ProofreadMark, type ReviewItem, samePerson, settled, type ValueEvidence } from "./evidence";
import { at, parsePointer, setAt } from "./pointer";
import { ARITHMETIC, recheck, sumAt } from "./problems";
import { alsoWithheld, amendmentDate, capFollowUps, empty, familyOf, PROSPECTIVE, SAMPLE, sampleMisses, sampleMissWords } from "./questions";
import { Rulebook, type Unclassified } from "./rulebook";

/**
 * Answering a question and the approval it gates (ADR-001 §6, I1–I6). Pure, so the API and the in-browser sample server
 * check an answer, write it, log it and refuse approval exactly the same. A refusal is a value (`{ refusal }`): the API
 * makes it an HttpError, the sample server a response.
 */

export type Refusal = { refusal: { status: 400 | 404 | 409; message: string } };
const refuse = (status: 400 | 404 | 409, message: string): Refusal => ({ refusal: { status, message } });

/** A draft as an answer reads and writes it. `proofread` says what a sample miss still holds back. */
export type AnswerDraft = { version: number; byHand: boolean; rulebook: Rulebook; review: ReviewItem[]; evidence: ValueEvidence[]; editors: string[]; proofread?: ProofreadMark[] };

const norm = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase() : x);
/** Text ignores case and edge spaces; a list ignores the order of its items too. */
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a.map(norm).sort()) === JSON.stringify(b.map(norm).sort()) : JSON.stringify(norm(a)) === JSON.stringify(norm(b));

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
  if (ARITHMETIC.has(item.reason)) {
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

/** Answers that list a page or a sentence to bill by hand (ADR-001 §7): the term goes on the master's unclassified list. */
const BILL_BY_HAND = new Set(["UNACCOUNTED_TERM", "SCAN_PAGE", "PICTURE_PAGE", "CORRECTION_LOST"]);

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

const WHY = "Add a short note saying why the PDF text is wrong here.";
const WHERE = "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note.";

/**
 * POST .../review/:itemId on a draft. Mutates `v` (callers pass a draft they own) and returns what it did, or a refusal,
 * before changing anything. A typed value is compared with the PDF's own text at its spot, or, where nothing is printed
 * there, with the value we hold: matched, or differs (then picking a value settles it as chosen). Settling a differs
 * needs a note: keeping your own value over the PDF text says why the text is wrong; where the PDF's text prints nothing
 * (a scan, a value the check didn't find, a pick), either value says where the page prints it, and the answer is marked
 * `noPdfText` for the approver. Options are chosen; an option with a `note` needs one (a reason, ADR-001 §6). An
 * interpretation's pick is checked against the read's value like a typed one: one that differs is shown with it, and the
 * second pick settles it. A question with options and an input (the start date: typed, or "prospective only") takes
 * either. Can't tell is left for the approver, and doesn't clear anything. "Bill by hand" lists the term on the master;
 * answering it any other way takes it off again. A random spot check (SAMPLE) settled with a value other than the one the
 * PDF check confirmed has missed (`missed`, ADR-001 §6). Returns what was written to the master, the log entry (`log`),
 * and the miss's own entry and alert count (`incident`). `isoDate` reads a printed date as the binder does.
 */
export function answerQuestion(v: AnswerDraft, itemId: string, raw: unknown, { isoDate, now }: { isoDate: (text: string) => string | null; now: string }) {
  const item = v.review.find((i) => i.id === itemId);
  if (!item) return refuse(404, "Question not found");
  const parsed = AnswerReviewBody.safeParse(raw);
  if (!parsed.success) return refuse(400, "Say who is answering.");
  const b = parsed.data;
  // The blind re-type of hand-typed values must be done by someone who didn't type them, nor change any value since.
  const retype = v.byHand && item.reason === "spot_check";
  if (retype && v.editors.some((e) => samePerson(e, b.by))) {
    const typist = v.evidence.some((e) => e.note?.startsWith("Typed by hand by ") && samePerson(e.note.slice("Typed by hand by ".length), b.by));
    return refuse(409, typist ? `${b.by} typed these values, so someone else has to re-type them.` : `${b.by} changed a value on this contract, so someone else has to re-type the rest.`);
  }
  const was = v.rulebook;
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
    if (!option) return refuse(400, "Pick one of the options.");
    if (option.note && !note) return refuse(400, `Add a short note for this answer: ${option.note.replace(/^./, (c) => c.toLowerCase())}`);
    set = optionValue(v.rulebook, item, option.id, current);
    // A yes/no or fixed-list value is checked like a typed one: against the value we hold (a re-type of a hand-typed
    // value, "This looks wrong", an interpretation). A missing one has nothing to check against, nor does a read that
    // says the contract doesn't state it; a second pick after "differs" settles it.
    const checkable = set && (item.kind === "confirm_value" || item.kind === "interpretation") && item.reason !== "REQUIRED_MISSING" && !empty(current) && current !== "unspecified" && item.outcome !== "differs";
    // a pick is never in the PDF's text
    if (item.outcome === "differs" && !note) return refuse(400, WHERE);
    noPdfText = item.outcome === "differs";
    outcome = checkable && !same(set!.value, current) ? "differs" : checkable ? "matched" : "chosen";
    if (outcome === "differs") set = undefined;
  } else {
    if (value === undefined || value === null || value === "") return refuse(400, "Type a value, or say you can't tell.");
    if (item.path && !fits(v.rulebook, item.path, value)) return refuse(400, "That value can't go in this field. Check what you typed.");
    const printed = parsePrinted(item.input, ev?.printed ?? null, isoDate);
    // a missing value (or a placeholder of the blank form) holds nothing to compare with
    const truth = printed ?? (empty(current) || item.reason === "REQUIRED_MISSING" ? undefined : current);
    if (item.outcome === "differs") {
      if (printed === undefined && !note) return refuse(400, WHERE);
      if (printed !== undefined && !same(value, printed) && !note) return refuse(400, WHY);
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
    const had = (rb.unclassified ?? []).find((u) => u.itemId === item.id);
    rb.unclassified = (rb.unclassified ?? []).filter((u) => u.itemId !== item.id);
    if (outcome === "chosen" && b.optionId === "bill_by_hand") rb.unclassified.push(unclassifiedOf(rb, item, note));
    const is = rb.unclassified.find((u) => u.itemId === item.id);
    if (is && !had) listed = { added: is.label };
    else if (had && !is) listed = { removed: had.label };
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
  const written = set && { path: set.path, before: before ?? null, after: set.value };
  // A value written to the master is logged like a correction, so an amendment's read carries it forward (the API's
  // correctionsOf). The governing grids are carried by their labels instead (carryGrid), and the bill-by-hand list by
  // asking again: an amendment's read finds the same terms unaccounted.
  const correction =
    !written || deepEqual(written.before, written.after) ? {}
    : written.path === "/governingGridIds" ? { gridId: b.optionId }
    : { ...written, items: itemIds(was, parsePointer(written.path)) };
  const billByHand = listed?.added ? { billByHand: listed.added } : listed?.removed ? { offBillByHand: listed.removed } : {};
  const log = {
    by: b.by,
    action: changed ? "review.changed" : "review.answered",
    detail: { version: v.version, itemId: item.id, question: item.question, outcome: outcome.replace("_", " "), ...(note ? { note } : {}), ...correction, ...billByHand },
  };
  // An incident (ADR-001 §6): a value the PDF check confirmed is wrong by a person's blind reading. How silent errors are
  // measured, so it's logged and told to everyone; approval waits for its kind of value to be checked.
  const miss = missed ? sampleMisses(v).find((m) => m.family === familyOf(item.path!))! : undefined;
  const incident = miss && {
    count: miss.left.length,
    detail: { version: v.version, itemId: item.id, path: item.path, question: item.question, values: miss.label, "to check": miss.left.length },
  };
  return { item, outcome, changed, set: written, listed, missed, unchanged: false as const, log, incident };
}

/**
 * What an answer asks next, added to `v.review`: the grid's held-back totals, checked on the typed numbers once its last
 * one is answered (recheck, with the runtime's `checks`), and a cap's limit once its kind is known (capFollowUps, worded
 * by `ask`).
 */
export function followUps(
  v: Pick<AnswerDraft, "rulebook" | "review" | "evidence"> & { anomalies: ContractAnomaly[] },
  a: { item: ReviewItem; set?: { path: string; before: unknown; after: unknown } },
  checks: (rb: Rulebook) => ContractAnomaly[],
  ask: (path: string, id: string, reason: string) => ReviewItem,
): void {
  if (a.set) v.review.push(...recheck(checks, v, a.set.path));
  v.review.push(...capFollowUps(v, a.item, !!a.set && !deepEqual(a.set.before, a.set.after), ask));
}

/**
 * Approval (ADR-001 I1–I6), the first reason it's refused, in plain words, or null: a draft, as the approver saw it
 * (`asOf`, its `updatedAt` then); typing by hand re-typed blind; every question settled by a typed value, a pick or a
 * reason (a blocker by a value or a pick only: answerQuestion enforces how each clears), so nothing is withheld any more;
 * every number confirmed by the PDF's text or a person; after a random spot check missed, every value of its kind
 * proofread or typed; and with maker-checker on, not by anyone who answered (names compared as people type them). The
 * API refuses with it and the approve page explains with it, so the two say the same.
 */
export function signOffRefusal(
  v: { version: number; status: string; rulebook: unknown; updatedAt: string; byHand: boolean; review: ReviewItem[]; evidence: ValueEvidence[]; proofread?: ProofreadMark[]; editors: string[] },
  { asOf, by, makerChecker }: { asOf: string; by: string; makerChecker: boolean },
): string | null {
  if (v.status === "signed" || v.status === "superseded") return `Version ${v.version} is ${v.status} and immutable; changes need a new version (amendment)`;
  if (v.status !== "draft" || !v.rulebook) return `Version ${v.version} is ${v.status}; only draft versions can be changed`;
  if (v.updatedAt !== asOf) return "This contract changed since you opened it. Check it again.";
  if (v.byHand && !v.review.length) return "Typing isn't marked done yet, so nobody has re-typed the values.";
  const open = v.review.filter((i) => !settled(i)).length;
  if (open) return `${open} ${open === 1 ? "question still needs" : "questions still need"} an answer before this can be approved.`;
  const unconfirmed = v.evidence.filter((e) => e.status !== "confirmed" && e.status !== "attested").length;
  if (unconfirmed) return `${unconfirmed} ${unconfirmed === 1 ? "number isn't" : "numbers aren't"} confirmed by the PDF or a person yet.`;
  const miss = sampleMisses(v).find((m) => m.left.length);
  if (miss) return sampleMissWords(miss);
  if (makerChecker && v.editors.some((e) => samePerson(e, by))) return `Maker-checker is on: ${by} answered questions on this contract, so someone else has to approve it.`;
  return null;
}
