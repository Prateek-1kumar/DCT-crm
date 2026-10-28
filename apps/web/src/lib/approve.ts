import type { PageBox, Rulebook, ValueEvidence } from "@dct/shared";
import { ENUM_OPTIONS, formatValue } from "./format";
import { findProv } from "./pointer";

/**
 * One term the approver ticks: plain words, its quote, and where the contract prints it. `paths`: the values it's made of,
 * so a term whose value is withheld for a blind answer shows "Needs you", not "Not stated".
 */
export type KeyTerm = { id: string; label: string; value: string; detail: string; quote: string | null; where: PageBox | null; paths: string[] };

const money = (cents: number | null) => (cents === null ? "No amount" : formatValue("/x/amountCents", cents));

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

/**
 * The handful of terms that decide most of the money, for the approver to tick: payment, holdback, overhead,
 * screen failures, the per-patient total, the biggest site fees, the invoice deadline, and when an amendment applies.
 * Missing terms are stated too ("No holdback"): an absence nobody confirmed is the costliest silent mistake.
 */
export function keyTerms(rb: Rulebook, evidence: ValueEvidence[]): KeyTerm[] {
  const at = (path: string): PageBox | null => {
    const w = evidence.find((e) => e.path === path)?.where[0];
    if (w) return w;
    const s = findProv(rb, path)?.source;
    return s ? { documentId: s.documentId, page: s.page, box: null } : null;
  };
  const quote = (path: string) => findProv(rb, path)?.source?.quote ?? null;
  const term = (id: string, label: string, value: string, detail: string, path: string | null, also: string[] = []): KeyTerm => ({
    id, label, value, detail, quote: path ? quote(path) : null, where: path ? at(path) : null, paths: [...(path ? [path] : []), ...also],
  });
  const out: KeyTerm[] = [];

  const p = rb.payment;
  out.push(
    p.netDays.value === null
      ? term("payment", "Payment", "Not stated", "The contract doesn't say how many days the sponsor has to pay", null, ["/payment/netDays/value"])
      : term(
          "payment",
          "Payment",
          `${p.netDays.value} days`,
          [p.netDaysFrom.value && `from ${p.netDaysFrom.value}`, ENUM_OPTIONS.visitPayment![p.visitPayment.value], ENUM_OPTIONS.frequency![p.frequency.value]?.toLowerCase()].filter(Boolean).join(" · "),
          "/payment/netDays/value",
        ),
  );

  const h = rb.holdback;
  out.push(
    h
      ? term("holdback", "Holdback", `${h.pct}%`, `of ${h.appliesTo}${h.releaseConditions.length ? `, paid back at ${h.releaseConditions.join(" and ")}` : ""}`, "/holdback/pct")
      : term("holdback", "Holdback", "None", "The contract doesn't withhold anything", null),
  );

  const o = rb.overhead;
  out.push(
    o.pct.value === null
      ? term("overhead", "Overhead", "None", "No overhead percentage is stated", null, ["/overhead/pct/value"])
      : term("overhead", "Overhead", `${o.pct.value}%`, `on ${(ENUM_OPTIONS.appliesTo![o.appliesTo.value] ?? o.appliesTo.value).toLowerCase()}`, "/overhead/pct/value"),
  );

  const sf = rb.screenFail;
  out.push(
    sf
      ? term("screen-fail", "Screen failures", sf.basis === "per_procedure" ? "Per procedure" : `${money(sf.amountCents)} each`, `${capText(sf.cap)} · ${(ENUM_OPTIONS.paidVia![sf.paidVia] ?? sf.paidVia).toLowerCase()}`, "/screenFail/amountCents", ["/screenFail/cap/n"])
      : term("screen-fail", "Screen failures", "Not paid", "The contract doesn't pay for screen failures", null),
  );

  // The governing grid if one was chosen, else every grid.
  const grids = rb.budgetGrids.map((g, gi) => ({ g, gi })).filter(({ g }) => !rb.governingGridId || g.id === rb.governingGridId);
  for (const { g, gi } of grids) {
    const t = g.perPatientTotals[0];
    if (t) out.push(term(`patient-${gi}`, "Per patient", money(t.cents), `${t.label} · ${g.label}`, `/budgetGrids/${gi}/perPatientTotals/0/cents`));
    else out.push(term(`patient-${gi}`, "Per patient", money(g.visits.reduce((n, v) => n + v.totalCents, 0)), `All visits added up · ${g.label}`, null));
  }

  rb.siteFees
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.amountCents !== null)
    .sort((a, b) => b.f.amountCents! - a.f.amountCents!)
    .slice(0, 3)
    .forEach(({ f, i }) =>
      out.push(
        term(`fee-${i}`, "Site fee", `${f.name}, ${money(f.amountCents)}`, [ENUM_OPTIONS.trigger![f.trigger]?.toLowerCase(), f.dueDays !== null && `due ${f.dueDays} days after`].filter(Boolean).join(" · "), `/siteFees/${i}/amountCents`),
      ),
    );

  const di = rb.deadlines.findIndex((d) => d.kind === "invoice_days_from_expense");
  if (di >= 0) out.push(term("deadline", "Invoice deadline", `${rb.deadlines[di]!.value} days`, `after the expense, or it's ${rb.deadlines[di]!.consequence}`, `/deadlines/${di}/value`));

  if (rb.appliesFrom.value) out.push(term("applies-from", "New terms apply from", rb.appliesFrom.value, "The date this version's prices start", "/appliesFrom/value"));
  return out;
}
