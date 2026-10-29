import { amendmentDate, armKey, billedGrids, type PageBox, type Rulebook, type ValueEvidence } from "@dct/shared";
import { ENUM_OPTIONS, formatDate, formatValue } from "./format";
import { findProv } from "./pointer";

/**
 * One term the approver ticks: plain words, its quote, and where the contract prints it. `paths`: the values it's made of,
 * so a term whose value is withheld for a blind answer shows as hidden, never as "Not stated" or "No amount".
 */
export type KeyTerm = { id: string; label: string; value: string; detail: string; quote: string | null; where: PageBox | null; paths: string[] };

const money = (cents: number | null) => (cents === null ? "No amount" : formatValue("/x/amountCents", cents));
/** A fixed-list value in words; on a draft it may be withheld (null) for a blind answer, and the term then shows hidden. */
const words = (list: string, v: string | null) => (v === null ? "" : (ENUM_OPTIONS[list]?.[v] ?? v));

function capText(cap: Rulebook["invoiceables"][number]["cap"]): string {
  switch (cap.kind) {
    case "ratio_to_randomized":
      return `up to ${cap.ratio ?? 1} per randomized subject${cap.n ? `, ${cap.n} at most` : ""}`;
    case "count":
      return `up to ${cap.n}`;
    case "amount":
      return `up to ${money(cap.n)} in total`;
    case "blocks_with_reauth":
      return `${cap.n} at a time, then the sponsor re-authorises`;
    default:
      return "no cap";
  }
}

/** What a key term shows while a value it's made of is withheld for a blind answer. */
export const HIDDEN = "Hidden until answered";

/**
 * The handful of terms that decide most of the money, for the approver to tick: payment, holdback, overhead,
 * screen failures, the per-patient total of each grid billed, the biggest site fees, the invoice deadline, and when an
 * amendment applies. Missing terms are stated too ("No holdback"): an absence nobody confirmed is the costliest silent
 * mistake. `hidden`: values withheld for a blind answer (withheldPaths); a term made of one says so, never what it holds.
 */
export function keyTerms(rb: Rulebook, evidence: ValueEvidence[], hidden: ReadonlySet<string> = new Set()): KeyTerm[] {
  const at = (path: string): PageBox | null => {
    const w = evidence.find((e) => e.path === path)?.where[0];
    if (w) return w;
    const s = findProv(rb, path)?.source;
    return s ? { documentId: s.documentId, page: s.page, box: null } : null;
  };
  const quote = (path: string) => findProv(rb, path)?.source?.quote ?? null;
  const term = (id: string, label: string, value: string, detail: string, path: string | null, also: string[] = []): KeyTerm => {
    const paths = [...(path ? [path] : []), ...also];
    if (paths.some((p) => hidden.has(p)))
      return { id, label, value: HIDDEN, detail: "Someone types what the contract says here first: answer its question", quote: null, where: path ? at(path) : null, paths };
    return { id, label, value, detail, quote: path ? quote(path) : null, where: path ? at(path) : null, paths };
  };
  const out: KeyTerm[] = [];

  const p = rb.payment;
  out.push(
    p.netDays.value === null
      ? term("payment", "Payment", "Not stated", "The contract doesn't say how many days the sponsor has to pay", null, ["/payment/netDays/value"])
      : term(
          "payment",
          "Payment",
          `${p.netDays.value} days`,
          [p.netDaysFrom.value && `from ${p.netDaysFrom.value}`, words("visitPayment", p.visitPayment.value), words("frequency", p.frequency.value).toLowerCase()].filter(Boolean).join(" · "),
          "/payment/netDays/value",
          ["/payment/netDaysFrom/value", "/payment/visitPayment/value", "/payment/frequency/value"],
        ),
  );

  const h = rb.holdback;
  out.push(
    h
      ? term("holdback", "Holdback", `${h.pct}%`, `of ${h.appliesTo}${h.releaseConditions?.length ? `, paid back at ${h.releaseConditions.join(" and ")}` : ""}`, "/holdback/pct", ["/holdback/appliesTo", "/holdback/releaseConditions"])
      : term("holdback", "Holdback", "None", "The contract doesn't withhold anything", null),
  );

  const o = rb.overhead;
  out.push(
    o.pct.value === null
      ? term("overhead", "Overhead", "None", "No overhead percentage is stated", null, ["/overhead/pct/value"])
      : term("overhead", "Overhead", `${o.pct.value}%`, `on ${words("appliesTo", o.appliesTo.value).toLowerCase()}`, "/overhead/pct/value", ["/overhead/appliesTo/value"]),
  );

  const sf = rb.screenFail;
  out.push(
    sf
      ? term("screen-fail", "Screen failures", sf.basis === "per_procedure" ? "Per procedure" : `${money(sf.amountCents)} each`, `${capText(sf.cap)} · ${words("paidVia", sf.paidVia).toLowerCase()}`, "/screenFail/amountCents", ["/screenFail/cap/kind", "/screenFail/cap/n", "/screenFail/cap/ratio", "/screenFail/basis", "/screenFail/paidVia"])
      : term("screen-fail", "Screen failures", "Not paid", "The contract doesn't pay for screen failures", null),
  );

  // The grids billing uses (billedGrids): each arm's chosen grid, or its only one, never two for one arm. An arm whose
  // grids differ with none chosen bills nothing: said, never left out (hidden while a number in them is withheld, as
  // they may price the same once it's answered).
  const billed = new Set(billedGrids(rb));
  const arms = new Set([...billed].map(armKey));
  rb.budgetGrids.forEach((g, gi) => {
    if (!billed.has(g)) {
      if (arms.has(armKey(g))) return;
      arms.add(armKey(g));
      const own = rb.budgetGrids.flatMap((x, xi) => (armKey(x) === armKey(g) ? [{ x, xi }] : []));
      const inThem = [...hidden].filter((p) => own.some(({ xi }) => p.startsWith(`/budgetGrids/${xi}/`)));
      out.push(term(`patient-${gi}`, "Per patient", "No grid chosen", `${g.arm ? `${g.arm}: ` : ""}${own.map(({ x }) => x.label).join(" and ")} disagree, so nothing is billed until one is chosen`, null, inThem));
      return;
    }
    const t = g.perPatientTotals[0];
    if (t) out.push(term(`patient-${gi}`, "Per patient", money(t.cents), `${t.label} · ${g.label}`, `/budgetGrids/${gi}/perPatientTotals/0/cents`));
    // no printed total: the visits added up, never while one of them is withheld
    else out.push(term(`patient-${gi}`, "Per patient", money(g.visits.reduce((n, v) => n + v.totalCents, 0)), `All visits added up · ${g.label}`, null, g.visits.map((_, vi) => `/budgetGrids/${gi}/visits/${vi}/totalCents`)));
  });

  // a fee whose amount is withheld for a blind answer may be the biggest: it's listed first, hidden, never left out
  const size = (f: Rulebook["siteFees"][number]) => f.amountCents ?? Number.MAX_SAFE_INTEGER;
  rb.siteFees
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f.amountCents !== null || hidden.has(`/siteFees/${i}/amountCents`))
    .sort((a, b) => size(b.f) - size(a.f))
    .slice(0, 3)
    .forEach(({ f, i }) =>
      out.push(
        term(`fee-${i}`, "Site fee", `${f.name}, ${money(f.amountCents)}`, [ENUM_OPTIONS.trigger![f.trigger]?.toLowerCase(), f.dueDays !== null && `due ${f.dueDays} days after`].filter(Boolean).join(" · "), `/siteFees/${i}/amountCents`, [`/siteFees/${i}/trigger`, `/siteFees/${i}/dueDays`]),
      ),
    );

  const di = rb.deadlines.findIndex((d) => d.kind === "invoice_days_from_expense");
  if (di >= 0) out.push(term("deadline", "Invoice deadline", `${rb.deadlines[di]!.value} days`, `after the expense, or it's ${rb.deadlines[di]!.consequence}`, `/deadlines/${di}/value`));

  // An amendment's start date is always a key term: with none, billing would start from the contract's effective date.
  const af = rb.appliesFrom.value;
  if (af || hidden.has("/appliesFrom/value") || rb.documents.some((d) => d.kind === "amendment"))
    out.push(
      term(
        "applies-from",
        "New terms apply from",
        af ? formatDate(af) : "Not stated",
        !af ? "The amendment gives no start date, so billing would start from the contract's effective date" : af === amendmentDate(rb) ? "Prospective only: from the amendment's own date" : "The date this version's prices start",
        "/appliesFrom/value",
      ),
    );
  return out;
}
