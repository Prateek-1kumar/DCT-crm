import type { ContractAnomaly } from "./anomaly";
import { AMOUNT_IN_NAME, leaf } from "./blind";
import { labelFor } from "./diff";
import { blankNumbers, type PageBox, type ProofreadMark, type ReviewItem, settled, type ValueEvidence } from "./evidence";
import { ENUM_LABELS } from "./labels";
import { at, parsePointer } from "./pointer";
import { Cap, OverheadAppliesTo, Payment, type Provenance, Rulebook, ScreenFail, SiteFee } from "./rulebook";

/**
 * The review lists that aren't flags (ADR-001 §6): the interpretations a person picks blind after every read, and the
 * random blind re-type of values the PDF check confirmed, with what a miss holds back. Pure, so the API and the
 * in-browser sample server ask, withhold and refuse exactly the same.
 */

export const INTERPRETATION = "INTERPRETATION";
/** A value of the read picked at random to be typed blind (ADR-001 §6 "Sample re-key"). */
export const SAMPLE = "SAMPLE";
export const SAMPLE_SIZE = 10;
/** The option of the start-date question that means "from the amendment's own date". */
export const PROSPECTIVE = "prospective";

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
// An amount or % in a name would give a value away, as the value questions blank them.
const named = (name: string) => `“${name.replace(AMOUNT_IN_NAME, "…").trim()}”`;
const listOf = (values: readonly string[], labels: Record<string, string> | undefined) => values.map((id) => ({ id, label: labels?.[id] ?? id }));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The newest amendment's own date, as the read gives it (ISO only): what a "prospective only" answer's typed date is
 * checked against. Nothing checks it against the PDF, so it's never written as it is.
 */
export const amendmentDate = (rb: Pick<Rulebook, "documents">): string | null =>
  rb.documents.flatMap((d) => (d.kind === "amendment" && d.date && ISO.test(d.date) ? [d.date] : [])).sort().at(-1) ?? null;

type Field = { path: string; question: string; prov: Provenance | null | undefined; options?: { id: string; label: string }[]; input?: "text" | "date"; kind?: ReviewItem["kind"]; reason?: string };

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
    if (x.cap.kind !== "none") out.push({ path: `/invoiceables/${i}/cap/kind`, question: `What limit does the contract put on billing ${named(x.name)}?`, options: listOf(Cap.shape.kind.options, L.capKind), prov: x.prov });
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
        : { ...base, question: amendment ? "From what date do the amendment's new terms apply?" : "From what date do this contract's terms apply?" },
    );
  }
  return out;
}

const pageOf = (r: { documentId: string; page: number }): PageBox => ({ documentId: r.documentId, page: r.page, box: null });
/** Whether an anomaly (or a note's path, "/overhead/appliesTo") is about the value at `path`. */
const about = (a: Pick<ContractAnomaly, "path">, path: string) => !!a.path && (a.path === path || `${a.path}/value` === path);

/**
 * One blind pick per interpretation field, next to its quote (numbers blanked, so it can't hand over another value),
 * nothing preselected; the read's value is withheld until it's answered (its path is the question's). An AMBIGUOUS_TERM
 * about the same value is this question, marked ambiguous (reason AMBIGUOUS_TERM, its message first, and no "not
 * stated"); a RETROACTIVE_NO_DATE is the start-date question. `amendment`: the read includes an amendment.
 */
export function interpretations(rb: Rulebook, opts: { amendment: boolean; anomalies?: Pick<ContractAnomaly, "code" | "path" | "message" | "refs">[] }): ReviewItem[] {
  const anomalies = opts.anomalies ?? [];
  const retroactive = anomalies.some((a) => a.code === "RETROACTIVE_NO_DATE");
  return fields(rb, opts.amendment || rb.documents.some((d) => d.kind === "amendment"), retroactive).map((f): ReviewItem => {
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
      question: [unclear && blankNumbers(sentence(unclear.message)), f.question, quote && `The contract says: “${blankNumbers(quote)}”`].filter(Boolean).join(" "),
      input: f.input ?? null,
      options: (f.options ?? []).filter((o) => !unclear || o.id !== "unspecified"),
      where: [...new Map(spots.map((r) => [`${r.documentId}#${r.page}`, pageOf(r)])).values()],
      blocking: true,
    };
  });
}

/** Whether a contract check is the interpretation question asked at `paths` (so it isn't asked twice). */
export const askedAsInterpretation = (a: Pick<ContractAnomaly, "code" | "path">, paths: ReadonlySet<string>) =>
  (a.code === "AMBIGUOUS_TERM" || a.code === "RETROACTIVE_NO_DATE") && [...paths].some((p) => about(a, p));

/**
 * Values whose meaning an open question decides, withheld with it: a cap's limit and ratio while its kind is asked (the
 * limit is cents for an amount cap, a count otherwise, so a figure or its question would give the kind away); every
 * visit's "paid automatically" while how visits are paid is asked, and every grid row's "overhead added" while what the
 * overhead applies to is (`rb`'s grids): row by row, they restate the answer.
 * Not a withheld cell's visit subtotal and total, though the cell could be worked out from them and the row's other
 * cells: the person answering reads the page, which prints that subtotal too, and what blind entry guards against is
 * anchoring on a value shown, not sums done on purpose. Withholding them would hide numbers the PDF confirmed, and blank
 * most of a grid while a few of its cells are asked.
 */
export function alsoWithheld(path: string, rb?: unknown): string[] {
  if (/\/cap\/kind$/.test(path)) return [path.replace(/kind$/, "n"), path.replace(/kind$/, "ratio")];
  const grids = (rb as Partial<Rulebook> | null | undefined)?.budgetGrids ?? [];
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
    const waited = !!ev && ev.status !== "confirmed" && ev.status !== "attested";
    const needs = f === "n" ? kind !== "ratio_to_randomized" : kind === "ratio_to_randomized";
    const missing = needs && valueAt(v.rulebook, path) === null;
    const needed = kindChanged && (needs || (f === "n" && valueAt(v.rulebook, path) !== null));
    if (!(waited || needed || missing) || v.review.some((i) => i.path === path && !settled(i))) return [];
    const earlier = v.review.filter((i) => i.id.startsWith(`cap:${path}`)).length;
    const reason = waited ? (ev.status === "conflict" ? "VALUE_CONFLICT" : "UNGROUNDED_VALUE") : needed ? "CAP_KIND_CHANGED" : "REQUIRED_MISSING";
    return [ask(path, `cap:${path}${earlier ? `:${earlier + 1}` : ""}`, reason)];
  });
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
const inputFor = (rb: Rulebook, path: string, value: unknown): NonNullable<ReviewItem["input"]> => {
  const key = fieldKey(path);
  if (/date|appliesFrom/i.test(key)) return "date";
  if (/cents$/i.test(key) || path.includes("/cells/") || amountCap(rb, path)) return "money";
  if (/pct$/i.test(key)) return "percent";
  if (typeof value === "number" || (value === null && /days|value$|^n$|count|ratio/i.test(key))) return "number";
  return "text";
};

/** A value's label with any amount or % in its names blanked: they would give the answer away (as the binder's questions do). */
export const blindLabel = (rb: unknown, path: string) => labelFor(rb, path).replace(AMOUNT_IN_NAME, "…");

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
 * A blind question about one value: "This looks wrong" (reason "reported"), the re-type sample of hand-typed values
 * ("spot_check") and of a read's confirmed values (SAMPLE), a required value the read didn't find. Yes/no and fixed-list
 * values are picked; the rest typed. The read's sample shows its page, never the spot the PDF check bound the value to:
 * a wrong binding would point at the wrong cell, and the person would type what's printed there, so a binder's mistake
 * would pass as confirmed. The question names the row and column (or the term) in words instead.
 */
export function askAbout(rb: Rulebook, evidence: ValueEvidence[], path: string, id: string, reason: string): ReviewItem {
  const value = at(rb, path);
  const label = blindLabel(rb, path);
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
    where: ev && reason !== SAMPLE ? [ev] : ev || src ? [pageOf((ev ?? src)!)] : [],
  };
}

// ---------- the blind sample ----------

/** Kinds of value, as ADR-001 §10 measures accuracy: a miss in one has all of that kind checked. */
export type Family = "cells" | "totals" | "fees" | "rules";
export const FAMILY_LABEL: Record<Family, string> = {
  cells: "budget grid prices",
  totals: "visit and per-patient totals",
  fees: "fee and invoiceable amounts",
  rules: "percentages, days, limits and dates",
};

export function familyOf(path: string): Family {
  if (/^\/budgetGrids\/\d+\/procedures\/\d+\/(?:cells\/|unitCents$)/.test(path)) return "cells";
  // a grid's stated overhead is a percentage, checked with the rules, not a total
  if (path.startsWith("/budgetGrids/") && !path.endsWith("/statedOverheadPct")) return "totals";
  if (/^\/(?:siteFees|invoiceables)\/\d+\/amount(?:WithOverhead)?Cents$|^\/screenFail\/amountCents$/.test(path)) return "fees";
  return "rules";
}

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
 * The blind sample of a read: `n` values the PDF check confirmed (all of them if fewer), taken in turn from each family
 * in a random order and at random within it, so a contract's hundreds of grid cells don't fill it. `skip`: values that
 * already have a question. Drawn once, when the read completes, and stored as its questions: never drawn again.
 */
export function pickSample(evidence: ValueEvidence[], skip: ReadonlySet<string>, random: () => number = cryptoRandom, n = SAMPLE_SIZE): string[] {
  const pools = new Map<Family, string[]>();
  for (const e of evidence) if (e.status === "confirmed" && !skip.has(e.path)) pools.set(familyOf(e.path), [...(pools.get(familyOf(e.path)) ?? []), e.path]);
  const queues = shuffle([...pools.values()], random).map((p) => shuffle(p, random));
  const out: string[] = [];
  while (out.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return out;
}

/**
 * When typing by hand is marked done: the values a person typed (`typed`), and the `n` of them (all if fewer) someone else
 * re-types blind (`sample`), drawn like the read's sample. Every kind of typed value can be drawn: amounts, text, yes/no,
 * fixed-list and list values (re-picked or re-typed).
 */
export function pickRetype(rb: Rulebook, evidence: ValueEvidence[], random: () => number = cryptoRandom, n = SAMPLE_SIZE): { typed: string[]; sample: string[] } {
  const typed = evidence.filter((e) => e.status === "attested" && leaf(at(rb, e.path)) && !empty(at(rb, e.path))).map((e) => e.path);
  return { typed, sample: shuffle(typed, random).slice(0, n) };
}

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

export type SampleMiss = { family: Family; label: string; total: number; left: string[] };

/**
 * A miss (ADR-001 §6): sign-off waits until every value of the missed sample's family is proofread ("Looks right") or was
 * typed by a person (attested). `left`: the family's values still only confirmed by the PDF check.
 */
export function sampleMisses(v: { review: ReviewItem[]; evidence: ValueEvidence[]; proofread?: ProofreadMark[] }): SampleMiss[] {
  const families = [...new Set(v.review.flatMap((i) => (i.missed && i.path ? [familyOf(i.path)] : [])))];
  const marked = new Set((v.proofread ?? []).map((m) => m.path));
  return families.map((family) => {
    const all = v.evidence.filter((e) => familyOf(e.path) === family);
    return { family, label: FAMILY_LABEL[family], total: all.length, left: all.filter((e) => e.status === "confirmed" && !marked.has(e.path)).map((e) => e.path) };
  });
}

/** What a miss still holds back, in plain words: the approval's refusal and the approve page say the same. */
export const sampleMissWords = (m: SampleMiss) =>
  `A random spot check found a wrong number among the ${m.label}, so each of them has to be proofread before approval: ${m.left.length} of ${m.total} still to check.`;
