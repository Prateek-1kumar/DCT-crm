import type { ContractAnomaly } from "./anomaly";
import { labelFor } from "./diff";
import { type BlankCheck, checkedByMachine, openItems, type PageBox, type ProofreadMark, type ReviewItem, settled, type TableCheck, type ValueEvidence } from "./evidence";
import { ENUM_LABELS } from "./labels";
import { at, leaf, parsePointer } from "./pointer";
import { Cap, OverheadAppliesTo, Payment, type Provenance, Rulebook, ScreenFail, SiteFee } from "./rulebook";

/**
 * The review lists that aren't flags (ADR-001 §6): the interpretations a person picks after every read, the table and
 * blank checks, one-value questions, and what we suggest for each (ADR-003). Pure, so the
 * API and the web ask and refuse by one rule.
 */

export const INTERPRETATION = "INTERPRETATION";
/**
 * One term, two dates in one contract: the effective date the master holds, and the last signature its e-signature record
 * prints, where the contract ties the date to signing. A pick of either date (its ISO date is the option's id) writes it;
 * nothing is suggested, since page 1 may print a "dated as of" date that governs.
 */
export const SIGNED_DATE_DIFFERS = "SIGNED_DATE_DIFFERS";
/** The option of the start-date question that means "from the amendment's own date". */
export const PROSPECTIVE = "prospective";

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
// An amount or % in a name would give a value away, as the value questions blank them.
const named = (name: string) => `“${name.trim()}”`;
const listOf = (values: readonly string[], labels: Record<string, string> | undefined) => values.map((id) => ({ id, label: labels?.[id] ?? id }));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The newest amendment's own date, as the read gives it (ISO only): what a "prospective only" answer's typed date is
 * checked against. Nothing checks it against the PDF, so it's never written as it is.
 */
export const amendmentDate = (rb: Pick<Rulebook, "documents">): string | null =>
  rb.documents.flatMap((d) => (d.kind === "amendment" && d.date && ISO.test(d.date) ? [d.date] : [])).sort().at(-1) ?? null;

/** The note of a value the binder placed by its row's own arithmetic: the row's quantity × unit price = its total (`rowMath`, binder.ts). */
export const ROW_ARITHMETIC = "its row prints quantity × unit price = total, which tells which figure this is";

type Field = {
  path: string; question: string; prov: Provenance | null | undefined; options?: { id: string; label: string }[]; input?: "text" | "date"; kind?: ReviewItem["kind"]; reason?: string;
  /** The value whose confirmation says the clause states this field outright (see `interpretations`); none: always asked. */
  stated?: string;
  /** A cap's figure that states its kind when the binder placed it by its row's own arithmetic (ROW_ARITHMETIC), quote or not. */
  byRow?: string;
};

/**
 * The fields whose wording decides how a term is billed (ADR-001 §6): overhead scope, how visits are paid, each fee's
 * trigger, each cap's kind where there's a cap, the screen-fail basis and whether screen failures are invoiced, what the
 * holdback is taken from, rounding, and from when an amendment's terms apply. An empty cap or holdback is the absence
 * sweep's to question (I4), not this list's.
 */
function fields(rb: Rulebook, amendment: boolean, retroactive: boolean): Field[] {
  const L = ENUM_LABELS;
  const out: Field[] = [
    { path: "/overhead/appliesTo/value", question: "Which lines does the overhead apply to?", options: listOf(OverheadAppliesTo.options, L.appliesTo), prov: rb.overhead.appliesTo.prov },
    { path: "/payment/visitPayment/value", question: "How are visits paid?", options: listOf(Payment.shape.visitPayment.shape.value.options, L.visitPayment), prov: rb.payment.visitPayment.prov },
  ];
  rb.siteFees.forEach((f, i) => out.push({ path: `/siteFees/${i}/trigger`, question: `When is the site fee ${named(f.name)} billed?`, options: listOf(SiteFee.shape.trigger.options, L.trigger), prov: f.prov }));
  rb.invoiceables.forEach((x, i) => {
    // Only these two kinds are told by the figure in the quote: an amount limit is a dollar figure there, a ratio limit a "1:3"
    // or "per … randomized" one, and the binder finds each only in that form. A count and "blocks" both read as a bare
    // number, and a count in a sentence can as well be a ratio, so those are asked; except an amount or a count that is the
    // item's own table row's total or quantity, placed there by the row's quantity × unit price = total (`byRow`).
    const stated = x.cap.kind === "amount" ? `/invoiceables/${i}/cap/n` : x.cap.kind === "ratio_to_randomized" ? `/invoiceables/${i}/cap/ratio` : undefined;
    const byRow = x.cap.kind === "amount" || x.cap.kind === "count" ? `/invoiceables/${i}/cap/n` : undefined;
    if (x.cap.kind !== "none") out.push({ path: `/invoiceables/${i}/cap/kind`, question: `What limit does the contract put on billing ${named(x.name)}?`, options: listOf(Cap.shape.kind.options, L.capKind), prov: x.prov, stated, byRow });
  });
  const sf = rb.screenFail;
  if (sf) {
    out.push({ path: "/screenFail/basis", question: "How are screen failures paid for?", options: listOf(ScreenFail.shape.basis.options, L.basis), prov: sf.prov });
    if (sf.cap.kind !== "none") out.push({ path: "/screenFail/cap/kind", question: "What limit does the contract put on paying for screen failures?", options: listOf(Cap.shape.kind.options, L.capKind), prov: sf.prov });
    // paid automatically when it should be invoiced means screen failures are never billed at all
    out.push({ path: "/screenFail/paidVia", question: "Are screen failures paid automatically, or do we invoice them?", options: listOf(ScreenFail.shape.paidVia.options, L.paidVia), prov: sf.prov });
  }
  // free text in the master, so it's typed; a differing answer is confirmed against the reading like any typed value
  if (rb.holdback) out.push({ path: "/holdback/appliesTo", question: "Which payments is the holdback taken from? Type it as the contract words it.", input: "text", prov: rb.holdback.prov });
  out.push({ path: "/rounding/value", question: "How does the contract say amounts are rounded?", options: listOf(Rulebook.shape.rounding.shape.value.options, L.rounding), prov: rb.rounding.prov });

  // From when the terms apply. With no date on an amendment, billing would fall back to the contract's effective date,
  // which can be the base contract's: retroactive to the start. That's a blocker (RETROACTIVE_NO_DATE): typed, or
  // "prospective only", where the person also types the amendment's own date, blind: the read's date of a document is
  // checked by nothing, so it's never written as theirs.
  const af = rb.appliesFrom.value;
  if (amendment || retroactive || af !== null) {
    const options = amendment || retroactive ? [{ id: PROSPECTIVE, label: "Prospective only: from the amendment's own date" }] : [];
    const base = { path: "/appliesFrom/value", input: "date" as const, options, prov: rb.appliesFrom.prov };
    out.push(
      af === null
        ? {
            ...base,
            kind: "contract_problem",
            reason: "RETROACTIVE_NO_DATE",
            question: retroactive
              ? "The amendment says its new prices apply retroactively, but gives no start date. From what date do they apply?"
              : "The amendment doesn't say from what date its new terms apply. From what date do they apply?",
          }
        : { ...base, question: amendment ? "From what date do the amendment's new terms apply?" : "From what date do this contract's terms apply?", stated: "/appliesFrom/value" },
    );
  }
  return out;
}

const pageOf = (r: { documentId: string; page: number }): PageBox => ({ documentId: r.documentId, page: r.page, box: null });
/**
 * Whether an anomaly is about the value at `path`: that value, or anything holding it. The read flags a {value, prov}
 * wrapper ("/overhead/appliesTo"), a cap ("/invoiceables/0/cap") or a whole fee ("/siteFees/1"), and the field under it
 * must still be asked as unclear, never taken as stated outright. A whole list ("/siteFees": "IRB fees have no amount") is
 * about the list, not each item in it (the path under it starts with an index): fromAnomalies asks it once, on its own.
 */
const about = (a: Pick<ContractAnomaly, "path">, path: string) => !!a.path && (a.path === path || (path.startsWith(`${a.path}/`) && !/^\d/.test(path.slice(a.path.length + 1))));

/**
 * One pick per interpretation field, next to its quote, nothing preselected; the read's value is shown as our suggestion
 * (suggest). An AMBIGUOUS_TERM
 * about the same value, or about anything holding it (a cap, a fee, a section: `about`), is this question, marked
 * ambiguous (reason AMBIGUOUS_TERM, its message first, and no "not stated"); a RETROACTIVE_NO_DATE is the start-date
 * question. `amendment`: the read includes an amendment.
 *
 * Two tiers (ADR-002 §4). A clause that states a parameter outright is not asked: the field is "explicit and confirmed"
 * when all of these hold, and then it's an ordinary confirmed value: (1) the
 * read gives a value that isn't "not stated"; (2) the read cites the clause's exact words (`prov.source.quote`); (3) the
 * figure that decides the field (`Field.stated`) is confirmed (`confirmed` or `confirmed_by_math`) in `evidence`, which
 * the binder gives for a figure found inside that quote on the cited page; or, for an invoiceable's amount or count cap,
 * its figure is confirmed as its own row's total or quantity by the row's quantity × unit price = total (`Field.byRow`,
 * note ROW_ARITHMETIC; quote or not, and never a count found in a sentence); or, for a fee's trigger, its row prints
 * words beside its confirmed amount (`opts.printed`) that name one trigger, the read's (`triggerOf`, ADR-003); (4) no
 * AMBIGUOUS_TERM or RETROACTIVE_NO_DATE is about it. Everything else keeps its question: a clause that is silent,
 * conditional or worded two ways, any field with no deciding figure (overhead scope, how visits are paid, a fee's trigger
 * with no such words, a count cap not placed by its row, the screen-fail terms, rounding, the holdback's scope), and any read made without
 * `evidence`. Rounding the contract never mentions (`roundingSaid` false, and no quote) isn't asked: it's a notice.
 * Each question with a quote cites it (`cites`), so questions on one clause are one card (cards).
 */
export function interpretations(
  rb: Rulebook,
  opts: { amendment: boolean; anomalies?: Pick<ContractAnomaly, "code" | "path" | "message" | "refs">[]; evidence?: (Pick<ValueEvidence, "path" | "status"> & { note?: string | null })[]; printed?: ReadonlyMap<string, string>; roundingSaid?: boolean },
): ReviewItem[] {
  const anomalies = opts.anomalies ?? [];
  const retroactive = anomalies.some((a) => a.code === "RETROACTIVE_NO_DATE");
  const sure = new Set((opts.evidence ?? []).filter((e) => checkedByMachine(e.status)).map((e) => e.path));
  const byRow = new Set((opts.evidence ?? []).filter((e) => e.status === "confirmed" && e.note === ROW_ARITHMETIC).map((e) => e.path));
  const unclear = (f: Field) => anomalies.some((a) => (a.code === "AMBIGUOUS_TERM" || a.code === "RETROACTIVE_NO_DATE") && about(a, f.path));
  // a fee's trigger the page prints beside its confirmed amount, in words that name one trigger, the read's (ADR-003)
  const fee = (f: Field) => /^\/siteFees\/(\d+)\/trigger$/.exec(f.path);
  const printedTrigger = (f: Field) => {
    const m = fee(f);
    const words = opts.printed?.get(f.path);
    return !!m && !!words && sure.has(`/siteFees/${m[1]}/amountCents`) && triggerOf(words) === rb.siteFees[Number(m[1])]?.trigger;
  };
  const explicit = (f: Field) =>
    !unclear(f) && f.reason !== "RETROACTIVE_NO_DATE" && ((!!f.stated && sure.has(f.stated) && !!f.prov?.source?.quote?.trim()) || (!!f.byRow && byRow.has(f.byRow)) || printedTrigger(f));
  // Rounding the contract is silent on (owner, 2026-11-02): the read quotes nothing about it and the contract's text never
  // mentions rounding (`roundingSaid` false; not known: asked). Printed figures are billed to the cent, said as a notice
  // (notices), not asked. Wording that mentions it anywhere, or that is flagged unclear, keeps the question.
  const silent = (f: Field) => f.path === "/rounding/value" && opts.roundingSaid === false && !f.prov?.source?.quote?.trim() && !unclear(f);
  return fields(rb, opts.amendment || rb.documents.some((d) => d.kind === "amendment"), retroactive).filter((f) => !explicit(f) && !silent(f)).map((f): ReviewItem => {
    const unclear = anomalies.find((a) => a.code === "AMBIGUOUS_TERM" && about(a, f.path));
    const refs = anomalies.filter((a) => a === unclear || (f.reason === "RETROACTIVE_NO_DATE" && a.code === "RETROACTIVE_NO_DATE")).flatMap((a) => a.refs);
    const spots = [...(f.prov?.source ? [f.prov.source] : []), ...refs];
    const quote = f.prov?.source?.quote?.trim();
    return {
      ...BLANK,
      id: `interpret:${f.path}`,
      kind: f.kind ?? "interpretation",
      reason: unclear ? "AMBIGUOUS_TERM" : (f.reason ?? INTERPRETATION),
      path: f.path,
      question: [unclear && sentence(unclear.message), f.question, quote && `The contract says: “${quote}”`].filter(Boolean).join(" "),
      input: f.input ?? null,
      options: (f.options ?? []).filter((o) => !unclear || o.id !== "unspecified"),
      where: [...new Map(spots.map((r) => [`${r.documentId}#${r.page}`, pageOf(r)])).values()],
      ...(quote && f.prov?.source ? { cites: { documentId: f.prov.source.documentId, page: f.prov.source.page, quote } } : {}),
      blocking: true,
    };
  });
}

/**
 * Needs you as cards: questions that cite the identical quote on the same page (`cites`: a screen-fail clause's basis,
 * cap and how it's paid; fees sharing one footnote) are one card, placed where its first question is. A money term's
 * sentence (UNACCOUNTED_TERM, `term.quote`) joins the first card quoting it word for word on any page of any document (an
 * amendment that repeats the base contract's payment paragraph). Any other question is a card of its own. Only the same
 * words group (spacing aside), never wording that is merely alike or a field's name. Each question is still answered,
 * checked and logged on its own (answerQuestion), and approval needs every one settled (signOffRefusal); the cards only
 * count and show them.
 */
export function cards<T extends Pick<ReviewItem, "id" | "cites" | "reason" | "term">>(items: T[]): T[][] {
  const norm = (q: string) => q.replace(/\s+/g, " ").trim();
  const cited = (i: T) => (i.cites ? JSON.stringify([i.cites.documentId, i.cites.page, norm(i.cites.quote)]) : undefined);
  // each quote's first card, for a money term's sentence to join (never two cited cards: those stay page by page)
  const first = new Map<string, string>();
  for (const i of items) if (i.cites && !first.has(norm(i.cites.quote))) first.set(norm(i.cites.quote), cited(i)!);
  const out = new Map<string, T[]>();
  for (const i of items) {
    const term = i.reason === "UNACCOUNTED_TERM" && i.term?.quote.trim() ? norm(i.term.quote) : undefined;
    const k = cited(i) ?? (term !== undefined ? (first.get(term) ?? JSON.stringify(["term", term])) : `item:${i.id}`);
    out.set(k, [...(out.get(k) ?? []), i]);
  }
  return [...out.values()];
}

/** The cards with a question still open (openItems): what "needs you" counts, in the API and the web alike. */
export const openCards = (items: ReviewItem[]) => cards(openItems(items));

type Trigger = Rulebook["siteFees"][number]["trigger"];

/**
 * The one trigger a fee's printed frequency names, by fixed, generic phrases ("one-time payment", "per year", "per sample",
 * "at close-out"), or null when it names none or more than one ("paid per terms of the exhibit": per what?). Never a guess:
 * a match skips the "When is the fee billed?" question, so anything that could mean another trigger leaves it asked.
 */
export function triggerOf(words: string): Trigger | null {
  const t = words.toLowerCase();
  // a period the triggers don't hold ("per month", "quarterly"): billed by none of them, so a person says how
  if (/\b(?:per|each|every|a)\s+(?:calendar\s+)?(?:month|quarter|week|day)\b|\b(?:monthly|quarterly|weekly|daily|semi[\s-]?annual(?:ly)?|bi[\s-]?annual(?:ly)?)\b/.test(t)) return null;
  // "execution of each amendment" is a later document's signing, not the agreement's
  if (/\bexecution\b/.test(t) && /\b(?:amendments?|renewals?|extensions?)\b/.test(t)) return null;
  const hits = new Set<Trigger>();
  // not bare "once": "paid once the IRB approves" is a condition, not a single payment
  if (/\bone[\s-]?time\b|\bonce\s+only\b|\bonly\s+once\b|\bsingle\s+(?:payment|fee)\b|\bnon[\s-]?recurring\b/.test(t)) hits.add("one_time");
  if (/\b(?:per|each|every)\s+(?:year|annum)\b|\bannual(?:ly)?\b|\byearly\b/.test(t)) hits.add("annual");
  if (/\bclose[\s-]?out\b/.test(t)) hits.add("closeout");
  if (/\b(?:study|site)\s+initiation\b/.test(t)) hits.add("study_initiation");
  if (/\bexecution\b/.test(t)) hits.add("agreement_execution");
  if (/\bregulatory\s+(?:package|documents?)\b/.test(t)) hits.add("regulatory_package");
  if (/\bactual\s+cost|\bas\s+incurred\b|\bat\s+cost\b/.test(t)) hits.add("actual_cost");
  // Per event only for a countable thing on this list, a word or two after "per", "each" or "every" ("per enrolled
  // patient"), and never beside a reference to a document or its terms: "per Exhibit B", "per protocol" and "per site"
  // name no event. An allow-list fails closed: a new kind of event is asked, never guessed.
  const reference = /\b(?:exhibits?|sections?|schedules?|appendix|appendices|attachments?|articles?|paragraphs?|clauses?|protocol|agreement|contract|budget|terms?)\b/.test(t);
  const event = /\b(?:per|each|every)\s+(?:[a-z-]+\s+){0,2}?(?:patients?|subjects?|participants?|visits?|samples?|specimens?|occurrences?|events?|procedures?|submissions?|resubmissions?|amendments?|shipments?|hours?|miles?|saes?|kits?|scans?|ads?|reports?|pickups?)\b/;
  if (!reference && event.test(t)) hits.add("per_event");
  if (hits.size > 1 && hits.has("per_event") && [...hits].some((h) => h !== "per_event" && h !== "one_time")) hits.delete("per_event");
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Whether a contract check is the interpretation question asked at `paths` (so it isn't asked twice). */
export const askedAsInterpretation = (a: Pick<ContractAnomaly, "code" | "path">, paths: ReadonlySet<string>) =>
  (a.code === "AMBIGUOUS_TERM" || a.code === "RETROACTIVE_NO_DATE") && [...paths].some((p) => about(a, p));

/**
 * Values whose meaning an open question decides: a cap's limit and ratio while its kind is asked (the limit is cents for
 * an amount cap, a count otherwise); every visit's "paid automatically" while how visits are paid is asked, and every
 * grid row's "overhead added" while what the overhead applies to is (`rb`'s grids); and each amendment's own date while
 * the start date is asked. Marked as waiting with the question (openPaths), and cleared with a cap's "No limit".
 */
export function decidedBy(path: string, rb?: unknown): string[] {
  if (/\/cap\/kind$/.test(path)) return [path.replace(/kind$/, "n"), path.replace(/kind$/, "ratio")];
  const r = rb as Partial<Rulebook> | null | undefined;
  if (path === "/appliesFrom/value") return (r?.documents ?? []).flatMap((d, i) => (d.kind === "amendment" ? [`/documents/${i}/date`] : []));
  const grids = r?.budgetGrids ?? [];
  if (path === "/payment/visitPayment/value") return grids.flatMap((g, gi) => g.visits.map((_, vi) => `/budgetGrids/${gi}/visits/${vi}/autopay`));
  if (path === "/overhead/appliesTo/value") return grids.flatMap((g, gi) => g.procedures.map((_, pi) => `/budgetGrids/${gi}/procedures/${pi}/overheadApplied`));
  return [];
}

const valueAt = (root: unknown, path: string) =>
  path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")).reduce<unknown>((n, t) => (n !== null && typeof n === "object" ? (n as Record<string, unknown>)[t] : undefined), root);

/**
 * A cap's limit and ratio once its kind is answered (`ask` words the question): asked if the read's figure isn't
 * confirmed (its question waited for the kind, as its wording names the kind), if the person's kind isn't the read's
 * (`kindChanged`): the limit is cents for an amount cap and a count otherwise, so the read's figure means something else
 * now, and a ratio cap needs its ratio; or if the kind needs a figure the master doesn't have (a limit for a count, an
 * amount or blocks, a ratio for a ratio cap), which would be approved as "at most ?". Not while one is open already;
 * asked anew if an earlier one was settled.
 */
export function capFollowUps(
  v: { rulebook: Rulebook; review: ReviewItem[]; evidence: ValueEvidence[] },
  item: ReviewItem,
  kindChanged: boolean,
  ask: (path: string, id: string, reason: string) => ReviewItem,
): ReviewItem[] {
  if (!item.path || !/\/cap\/kind$/.test(item.path) || !settled(item)) return [];
  const kind = valueAt(v.rulebook, item.path);
  if (kind === "none") return [];
  return (["n", "ratio"] as const).flatMap((f) => {
    const path = item.path!.replace(/kind$/, f);
    const ev = v.evidence.find((e) => e.path === path);
    const waited = !!ev && !checkedByMachine(ev.status) && ev.status !== "attested";
    const needs = f === "n" ? kind !== "ratio_to_randomized" : kind === "ratio_to_randomized";
    const missing = needs && valueAt(v.rulebook, path) === null;
    const needed = kindChanged && (needs || (f === "n" && valueAt(v.rulebook, path) !== null));
    if (!(waited || needed || missing) || v.review.some((i) => i.path === path && !settled(i))) return [];
    const earlier = v.review.filter((i) => i.id.startsWith(`cap:${path}`)).length;
    const reason = waited ? (ev.status === "conflict" ? "VALUE_CONFLICT" : "UNGROUNDED_VALUE") : needed ? "CAP_KIND_CHANGED" : "REQUIRED_MISSING";
    return [ask(path, `cap:${path}${earlier ? `:${earlier + 1}` : ""}`, reason)];
  });
}

/** A cap's limit or ratio while its kind is "No limit": nothing is billed by them, so nothing is written or asked there. */
export const noLimit = (rb: unknown, path: string) => /\/cap\/(?:n|ratio)$/.test(path) && valueAt(rb, path.replace(/(?:n|ratio)$/, "kind")) === "none";

/**
 * Typing by hand (PATCH …/values): what's refused when a typed value at `path`
 * leaves a cap it touches with "No limit" and a limit or ratio, `after` being the master with it, `before` without. The
 * export bills such a cap as "No cap", and its figure could never be re-typed (answerQuestion refuses one there), so
 * it's refused whichever is typed second, the figure or the kind. A cap that was so already (typed before this rule)
 * can still be cleared a figure at a time.
 */
export function noLimitTyped(before: Rulebook, after: Rulebook, path: string): string | null {
  const caps = [...(after.screenFail ? [["/screenFail/cap", after.screenFail.cap] as const] : []), ...after.invoiceables.map((x, i) => [`/invoiceables/${i}/cap`, x.cap] as const)];
  const touched = (p: string) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`);
  const added = (p: string, c: (typeof caps)[number][1]) => {
    const was = valueAt(before, p) as typeof c | undefined;
    return was?.kind !== "none" || (c.n !== null && c.n !== was.n) || (c.ratio !== null && c.ratio !== was.ratio);
  };
  const hit = caps.find(([p, c]) => c.kind === "none" && (c.n !== null || c.ratio !== null) && touched(p) && added(p, c));
  if (!hit) return null;
  return path === `${hit[0]}/kind`
    ? "This cap still has a limit typed, so it can't be “No limit”. Clear the limit first, or pick the kind of limit the contract sets."
    : "This cap is set to “No limit”, so there's no limit to type here. If the contract does set one, change the cap's kind first.";
}

// ---------- a question about one value ----------

/** Nothing there to compare with or to re-type: no value, an empty text, an empty list. */
export const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** Field name a pointer ends at: "/payment/netDays/value" → "netDays", "/deadlines/0/value" → "value". */
export const fieldKey = (path: string) => {
  const t = path.split("/");
  const [last, prev] = [t.at(-1) ?? "", t.at(-2)];
  return last === "value" && prev && !/^\d+$/.test(prev) ? prev : last;
};
/** A cap's limit is cents when its kind says it caps an amount; every other value's unit is in its own name. */
const amountCap = (rb: Rulebook, path: string) => /\/cap\/n$/.test(path) && at(rb, path.replace(/n$/, "kind")) === "amount";
/** A field the master holds a date in, YYYY-MM-DD (the web's by-hand form gives it a date picker by the same rule). */
export const dateField = (path: string) => /date|appliesFrom/i.test(fieldKey(path));
const inputFor = (rb: Rulebook, path: string, value: unknown): NonNullable<ReviewItem["input"]> => {
  const key = fieldKey(path);
  if (dateField(path)) return "date";
  if (/cents$/i.test(key) || path.includes("/cells/") || amountCap(rb, path)) return "money";
  if (/pct$/i.test(key)) return "percent";
  if (typeof value === "number" || (value === null && /days|value$|^n$|count|ratio/i.test(key))) return "number";
  return "text";
};


const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Provenance of the nearest item on the path that carries one ("/payment/netDays/value" → payment.netDays.prov). */
export function provOf(rb: Rulebook, path: string): Provenance | null {
  let node: unknown = rb;
  let found: Provenance | null = null;
  for (const t of parsePointer(path)) {
    node = Array.isArray(node) ? node[Number(t)] : isObj(node) ? node[t] : undefined;
    if (isObj(node) && isObj(node.prov)) found = node.prov as Provenance;
  }
  return found;
}

/** The plain words of a fixed-list value's choices: a cap's kind has its own (its field is `kind`, like a deadline's). */
export const choicesOf = (path: string) => ENUM_LABELS[/\/cap\/kind$/.test(path) ? "capKind" : fieldKey(path)];

/**
 * A question about one value: "This looks wrong" (reason "reported"), a required value the read didn't find.
 * Yes/no and fixed-list values are picked; the rest typed.
 */
export function askAbout(rb: Rulebook, evidence: ValueEvidence[], path: string, id: string, reason: string): ReviewItem {
  const value = at(rb, path);
  const label = labelFor(rb, path);
  const list = typeof value === "string" ? choicesOf(path) : undefined;
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
    where: ev ? [ev] : src ? [pageOf(src)] : [],
  };
}

// ---------- randomness ----------

/** Uniform in [0, 1), from the platform's cryptographic generator (Node and browsers alike). */
export const cryptoRandom = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

const shuffle = <T>(xs: T[], random: () => number) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/**
 * What nobody decided in a contract typed by hand (no evidence row at its path): the blank form has to fill what the
 * schema allows no empty for. A number (a visit's total 0, a holdback's % 0: the form shows an empty box), a yes/no or
 * a fixed-list value (a visit paid automatically, no overhead on a row, a fee billed "one time", screen failures "by
 * invoice", "not stated"), and what the holdback is taken from. Each is asked like a missing value when typing is marked
 * done: typed, or picked blind. Not what only orders or describes the master: schemaVersion, a visit's order, provenance,
 * the documents.
 */
export function placeholders(rb: Rulebook, evidence: ValueEvidence[]): string[] {
  const typed = new Set(evidence.map((e) => e.path));
  const out: string[] = [];
  const decides = (path: string, x: unknown) => typeof x === "number" || typeof x === "boolean" || (typeof x === "string" && (!!choicesOf(path)?.[x] || path === "/holdback/appliesTo"));
  const walk = (node: unknown, path: string, key: string) => {
    if (key === "prov" || key === "schemaVersion" || key === "order" || path === "/documents") return;
    if (decides(path, node)) return void (typed.has(path) || out.push(path));
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}/${i}`, String(i)));
    else if (isObj(node)) for (const [k, x] of Object.entries(node)) walk(x, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, k);
  };
  walk(rb, "", "");
  return out;
}

// ---------- the table check ----------

/** The question that confirms a scanned table's columns (TableCheck): which visit is the highlighted column. */
export const TABLE_CHECK = "TABLE_CHECK";

/** The send-back's refusal when any of its questions is a table pick or a blank check's (their answers are final, answerQuestion), or null. */
export const tableSendBackRefusal = (items: Pick<ReviewItem, "table" | "reason">[]) =>
  items.some((i) => i.table) ? "A table's columns can't be sent back: the answer is final. If a price in the table looks wrong, use “This looks wrong” on it."
  : items.some((i) => i.reason === BLANK_INVOICEABLE) ? "How a table bills its blank items can't be sent back: the answer is final. If a price in the table looks wrong, use “This looks wrong” on it."
  : null;

/** A grid cell's visit code: "/budgetGrids/0/procedures/3/cells/V2" → "V2". */
const cellVisit = (path: string) => /^\/budgetGrids\/\d+\/procedures\/\d+\/cells\/(.+)$/.exec(path)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Two picks per table check, drawn with `random`: which visit the highlighted column is, among the grid's visits in
 * order, none preselected. Two different visits, columns with held prices first. The read's visit for the column goes on
 * the item as `table.expect`, shown as our suggestion. None when the table has no columns: the caller rejects the
 * check at once (rejectTable), or its held prices could never be settled.
 */
export function tableQuestions(rb: Pick<Rulebook, "budgetGrids">, evidence: ValueEvidence[], checks: TableCheck[], random: () => number = cryptoRandom): ReviewItem[] {
  return checks.flatMap((c) => {
    const grid = rb.budgetGrids[c.grid];
    if (!grid) return [];
    const held = new Set(evidence.filter((e) => e.held === c.id).flatMap((e) => cellVisit(e.path) ?? []));
    const cols = c.columns.map((col, i) => ({ col, i }));
    const seen = new Set<string>();
    // Drawn in a random order, and numbered in that order: columns run in visit order, so an id or a list position that
    // followed the column would give its visit away.
    const picks = shuffle(
      [...shuffle(cols.filter((x) => held.has(x.col.visit)), random), ...shuffle(cols.filter((x) => !held.has(x.col.visit)), random)]
        .filter((x) => !seen.has(x.col.visit) && !!seen.add(x.col.visit))
        .slice(0, 2),
      random,
    );
    const options = [...grid.visits].sort((a, b) => a.order - b.order).map((v) => ({ id: v.code, label: v.name }));
    return picks.map(({ col }, k): ReviewItem => ({
      ...BLANK, id: `table:${c.id}:${k}`, kind: "confirm_value", reason: TABLE_CHECK, path: null, blocking: true, input: null, options, where: [col.box],
      question: `Which visit is the highlighted column of the table on page ${c.page}?`,
      table: { id: c.id, axis: "column", expect: col.visit },
    }));
  });
}

/**
 * The check's held prices become ordinary blind "type what's printed" questions (`ask` words them) and their hold ends;
 * its picks nobody answered yet are closed, since the columns are rejected. Returns what to log, or null when nothing was held.
 */
export function rejectTable(v: { review: ReviewItem[]; evidence: ValueEvidence[] }, id: string, ask: (path: string, id: string, reason: string) => ReviewItem): { values: number; closed: number } | null {
  const held = v.evidence.filter((e) => e.held === id);
  const open = v.review.filter((i) => i.table?.id === id && !settled(i));
  const waiting = v.review.filter((i) => i.reason === BLANK_INVOICEABLE && i.after === id);
  if (!held.length && !open.length && !waiting.length) return null;
  for (const e of held) {
    delete e.held;
    if (!v.review.some((i) => i.path === e.path && !settled(i))) v.review.push(ask(e.path, `held:${e.path}`, "TABLE_REJECTED"));
  }
  // in place: the caller's list is the draft's own
  for (const i of open) v.review.splice(v.review.indexOf(i), 1);
  // a blank group on this table can't be trusted either: its cells are typed blind too
  const blank = waiting.reduce((n, g) => n + (rejectBlank(v, g.id, ask)?.values ?? 0), 0);
  return { values: held.length + blank, closed: open.length };
}

/**
 * What a table pick settles. Every pick of the check right: its held prices are confirmed, noted as checked by those who
 * picked (the scan's own reading agrees at each cell, and a person confirmed the columns). Any pick wrong: the columns are
 * rejected for good, and each price is asked on its own (rejectTable). Otherwise the check waits for its other pick.
 */
export function settleTable(v: { review: ReviewItem[]; evidence: ValueEvidence[] }, id: string, ask: (path: string, id: string, reason: string) => ReviewItem): { action: string; detail: Record<string, unknown> } | null {
  const picks = v.review.filter((i) => i.table?.id === id);
  const done = picks.filter((i) => settled(i));
  // a wrong pick, or "can't tell": the mapping isn't confirmed, so it's rejected
  if (done.some((i) => i.answer?.optionId !== i.table!.expect) || picks.some((i) => i.outcome === "cant_tell")) {
    const r = rejectTable(v, id, ask);
    return r && { action: "review.table_rejected", detail: { "prices to type": r.values, "picks closed": r.closed } };
  }
  if (!picks.length || done.length < picks.length) return null;
  // the columns are right: a blank group on this table can be answered now
  for (const i of v.review) if (i.reason === BLANK_INVOICEABLE && i.after === id) delete i.after;
  const by = [...new Set(done.flatMap((i) => (i.answer ? [i.answer.by] : [])))].join(", ");
  const held = v.evidence.filter((e) => e.held === id);
  for (const e of held) {
    delete e.held;
    Object.assign(e, { status: "confirmed", note: `Checked by ${by}: the table's columns were confirmed, and our own reading of the scan agrees` });
  }
  return held.length ? { action: "review.table_confirmed", detail: { prices: held.length, by } } : null;
}

// ---------- the blank check ----------

/** The question about a table's cells the read calls "invoiceable" where the page prints no price (BlankCheck). */
export const BLANK_INVOICEABLE = "BLANK_INVOICEABLE";
/** The reading of those cells the AI made, "billed at every scheduled visit"; never shown, so a pick that differs is a correction. */
export const BLANK_READ = "every_visit";
const BLANK_OPTIONS = [
  { id: "printed_only", label: "Only where the contract prints a price" },
  { id: BLANK_READ, label: "At every scheduled visit shown" },
];

/**
 * One pick per blank check, none preselected: how the highlighted items are billed where the table prints no price.
 * The question shows the table and the rows' boxes (their cells' evidence); the cells wait with it (`ValueEvidence.blank`,
 * openPaths).
 */
export function blankQuestions(evidence: ValueEvidence[], checks: BlankCheck[]): ReviewItem[] {
  return checks.map((c): ReviewItem => {
    const rows = evidence.filter((e) => e.blank === c.id).flatMap((e) => e.where.filter((w) => w.box));
    return {
      ...BLANK, id: c.id, kind: "confirm_value", reason: BLANK_INVOICEABLE, path: null, blocking: true, input: null, options: BLANK_OPTIONS, ...(c.after ? { after: c.after } : {}),
      where: [c.table, ...new Map(rows.map((w) => [JSON.stringify(w), w])).values()],
      question: `On page ${c.page}, the highlighted items print no price at the scheduled visits. How are they billed?`,
    };
  });
}

/**
 * "Can't tell" on a blank check: its cells become ordinary blind "type what's printed" questions (`ask` words them) and
 * their mark ends; the check's own question is closed, since its cells are asked one by one now. Returns what to log.
 */
export function rejectBlank(v: { review: ReviewItem[]; evidence: ValueEvidence[] }, id: string, ask: (path: string, id: string, reason: string) => ReviewItem): { values: number } | null {
  const cells = v.evidence.filter((e) => e.blank === id);
  const item = v.review.find((i) => i.id === id && i.reason === BLANK_INVOICEABLE);
  if (!cells.length && !item) return null;
  for (const e of cells) {
    delete e.blank;
    if (!v.review.some((i) => i.path === e.path && !settled(i))) v.review.push(ask(e.path, `blank:${e.path}`, "BLANK_REJECTED"));
  }
  // in place: the caller's list is the draft's own
  if (item) v.review.splice(v.review.indexOf(item), 1);
  return { values: cells.length };
}
