import { z } from "zod";
import { StudySummaryDto } from "./api";
import { ENUM_LABELS } from "./labels";
import type { Rulebook } from "./rulebook";

/**
 * Searching and listing are done by the server (or the in-browser sample server), never by filtering everything
 * client-side. The page sends a query and shows what comes back.
 */

export const StudyView = z.enum(["needs-you", "approval", "live", "failed"]);
export type StudyView = z.infer<typeof StudyView>;

/**
 * GET /studies?view=&site=&q=&cursor=&limit=: one page of the contract list, most urgent first
 * (needs you, oldest first; couldn't read; details to confirm; waiting for approval; reading; live, newest first).
 * `q` matches protocol, sponsor, site or investigator (case-insensitive, every word). `cursor` is opaque.
 */
export const StudyListQuery = z.object({
  view: StudyView.optional(),
  site: z.string().min(1).optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type StudyListQuery = Partial<z.infer<typeof StudyListQuery>>;

export const StudyPage = z.object({ items: z.array(StudySummaryDto), nextCursor: z.string().nullable(), total: z.number().int() });
export type StudyPage = z.infer<typeof StudyPage>;

/** GET /studies/counts?site=: contracts per view (tabs and sidebar) and the sites there are, without fetching any contract. */
export const StudyCounts = z.object({
  all: z.number().int(),
  views: z.record(StudyView, z.number().int()),
  sites: z.array(z.object({ name: z.string(), count: z.number().int() })),
});
export type StudyCounts = z.infer<typeof StudyCounts>;

/** A rate in a live contract, for ⌘K: a procedure (its unit price), a site fee or an invoiceable. */
export const RateHit = z.object({
  studyId: z.string(),
  protocol: z.string().nullable(),
  sponsor: z.string().nullable(),
  version: z.number().int(),
  /** JSON pointer of the item, e.g. "/budgetGrids/0/procedures/3". */
  path: z.string(),
  kind: z.enum(["procedure", "fee", "invoiceable"]),
  name: z.string(),
  code: z.string().nullable(),
  cents: z.number().int().nullable(),
  /** Where it sits, e.g. the grid's label or "per occurrence". */
  detail: z.string(),
});
export type RateHit = z.infer<typeof RateHit>;

/** GET /search?q=&limit=: ⌘K. Contracts (protocol, sponsor, site, investigator) and rates in live contracts. */
export const SearchResults = z.object({ contracts: z.array(StudySummaryDto), rates: z.array(RateHit) });
export type SearchResults = z.infer<typeof SearchResults>;

export const MasterSection = z.enum(["grid", "fees", "invoiceables", "terms"]);
export type MasterSection = z.infer<typeof MasterSection>;

/** GET /studies/:id/versions/:v/search?q=: what in this invoicing master matches, as item pointers. */
export const MasterSearch = z.object({
  q: z.string(),
  hits: z.array(z.object({ path: z.string(), section: MasterSection, label: z.string() })),
});
export type MasterSearch = z.infer<typeof MasterSearch>;

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** "98", "$98.00", "1,245.20" → cents; otherwise null. */
export const amountOf = (q: string): number | null => {
  const t = q.trim().replace(/^\$/, "").replace(/,/g, "");
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
};

/**
 * Items of one invoicing master matching `q`: every word appears in the item's name, code or wording, or `q` is an
 * amount that the item prices. Grid rows, visits, site fees, invoiceables and the money terms.
 */
export function searchMaster(rb: Rulebook, q: string): MasterSearch["hits"] {
  const ws = words(q);
  const cents = amountOf(q);
  if (!ws.length) return [];
  const has = (hay: string) => ws.every((w) => hay.toLowerCase().includes(w));
  const hits: MasterSearch["hits"] = [];
  const add = (path: string, section: MasterSection, label: string) => hits.some((h) => h.path === path) || hits.push({ path, section, label });

  rb.budgetGrids.forEach((g, gi) => {
    g.procedures.forEach((p, pi) => {
      const priced = cents !== null && (p.unitCents === cents || Object.values(p.cells).includes(cents));
      if (has(`${p.name} ${p.code ?? ""} ${g.label}`) || priced) add(`/budgetGrids/${gi}/procedures/${pi}`, "grid", `${p.name}${p.code ? ` (${p.code})` : ""}`);
    });
    g.visits.forEach((v, vi) => {
      if (has(`${v.code} ${v.name} visit`) || (cents !== null && v.totalCents === cents)) add(`/budgetGrids/${gi}/visits/${vi}`, "grid", `Visit: ${v.name}`);
    });
  });
  rb.siteFees.forEach((f, i) => {
    if (has(`${f.name} ${f.code ?? ""} ${ENUM_LABELS.trigger?.[f.trigger] ?? ""} fee`) || (cents !== null && f.amountCents === cents)) add(`/siteFees/${i}`, "fees", f.name);
  });
  rb.invoiceables.forEach((x, i) => {
    if (has(`${x.name} ${x.code ?? ""} ${x.frequency} ${ENUM_LABELS.basis?.[x.basis] ?? ""} invoiceable`) || (cents !== null && (x.amountCents === cents || x.amountWithOverheadCents === cents)))
      add(`/invoiceables/${i}`, "invoiceables", x.name);
  });

  const p = rb.payment;
  const terms: [path: string, label: string, hay: string, amount?: number | null][] = [
    ["/payment", "Payment", `payment pay invoice net days ${p.netDays.value ?? ""} ${p.netDaysFrom.value ?? ""} ${p.invoiceAddress.value ?? ""} ${p.requiredReferences.value.join(" ")} ${p.paymentConditions.value.join(" ")}`],
    ["/holdback", "Holdback", `holdback withhold retention ${rb.holdback ? `${rb.holdback.pct}% ${rb.holdback.appliesTo} ${rb.holdback.releaseConditions.join(" ")}` : "none"}`],
    ["/overhead", "Overhead", `overhead indirect ${rb.overhead.pct.value ?? ""}% ${ENUM_LABELS.appliesTo?.[rb.overhead.appliesTo.value] ?? ""}`],
    ["/screenFail", "Screen failures", "screen fail failure screening", rb.screenFail?.amountCents],
    ...rb.deadlines.map((d, i): [string, string, string] => [`/deadlines/${i}`, ENUM_LABELS.kind?.[d.kind] ?? d.kind, `deadline invoice ${d.value} ${d.consequence} ${ENUM_LABELS.kind?.[d.kind] ?? ""}`]),
    ["/overpayment", "Overpayment", "overpayment refund offset"],
    ["/rounding", "Rounding", "rounding round cents printed"],
    ["/appliesFrom", "Applies from", "applies from effective retroactive amendment"],
  ];
  for (const [path, label, hay, amount] of terms) if (has(`${label} ${hay}`) || (cents !== null && amount === cents)) add(path, "terms", label);
  return hits;
}
