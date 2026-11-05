import type { Evidence, Grid, Rulebook, Term, TermCategory } from "@dct/shared";
import type { Tone } from "../ui";
import type { AmountStatus, Coverage, CoveragePage, CoverageRef, Version } from "@/lib/types";

export interface ProofData {
  version: Version;
  rulebook: Rulebook;
  /** Every page of every document, in order; a page the checker had nothing on still appears, with no amounts. */
  pages: CoveragePage[];
  totals: Coverage["totals"];
}

/** A place on the contract: a page, and optionally which of its amounts (an index into `amounts`). */
export interface Spot {
  doc: string;
  page: number;
  box: number | null;
}

export function buildProof(version: Version, coverage: Coverage): ProofData | null {
  if (!version.rulebook) return null;
  const known = new Map(coverage.pages.map((p) => [`${p.documentId}:${p.page}`, p]));
  const pages = version.documents.flatMap((d) =>
    Array.from({ length: d.pageCount }, (_, i) => known.get(`${d.id}:${i + 1}`) ?? { documentId: d.id, doc: d.name, page: i + 1, kind: "text" as const, amounts: [], clauses: [] }),
  );
  return { version, rulebook: version.rulebook, pages, totals: coverage.totals };
}

export const encodeRef = (r: CoverageRef) => (r.target === "term" ? `term:${r.id}` : `grid:${r.id}:${r.row}:${r.col}`);

export function decodeRef(s: string | null): CoverageRef | null {
  if (s?.startsWith("term:")) return { target: "term", id: s.slice(5) };
  // a bare "grid:ID" (a link to the whole grid) means its grand total
  const m = /^grid:(.+?)(?::(-?\d+):(-?\d+))?$/.exec(s ?? "");
  return m ? { target: "grid", id: m[1]!, row: Number(m[2] ?? -1), col: Number(m[3] ?? -1) } : null;
}

export const sameRef = (a: CoverageRef, b: CoverageRef) => encodeRef(a) === encodeRef(b);

export const findTerm = (d: ProofData, id: string): Term | undefined => d.rulebook.terms.find((t) => t.id === id);
export const findGrid = (d: ProofData, id: string): Grid | undefined => d.rulebook.grids.find((g) => g.id === id);
export const docName = (d: ProofData, id: string) => d.version.documents.find((x) => x.id === id)?.name ?? "the contract";
export const pageAt = (d: ProofData, spot: { doc: string; page: number } | null) => spot && d.pages.find((p) => p.documentId === spot.doc && p.page === spot.page);

/** The page a line was read from: a term's quote, or the first page of a grid. */
export function sourceOf(d: ProofData, ref: CoverageRef): Spot | null {
  const at = ref.target === "term" ? findTerm(d, ref.id)?.source : (g => g && { doc: g.doc, page: g.pages[0]! })(findGrid(d, ref.id));
  const doc = at && d.version.documents.find((x) => x.name === at.doc);
  return at && doc ? { doc: doc.id, page: at.page, box: null } : null;
}

/** Where a line shows on the contract: its amount if one points at it (on its own page first), else just the page. */
export function locate(d: ProofData, ref: CoverageRef): Spot | null {
  const home = sourceOf(d, ref);
  const hit = (p: CoveragePage) => p.amounts.findIndex((a) => a.ref && sameRef(a.ref, ref));
  const page = d.pages.find((p) => p.documentId === home?.doc && p.page === home.page && hit(p) >= 0) ?? d.pages.find((p) => hit(p) >= 0);
  return page ? { doc: page.documentId, page: page.page, box: hit(page) } : home;
}

export const STATUS: Record<AmountStatus, { tone: Tone; chip: string; proof: string }> = {
  captured: { tone: "ok", chip: "captured", proof: "Matches the contract" },
  decided: { tone: "info", chip: "decided by a person", proof: "Decided by a person" },
  set_aside: { tone: "neutral", chip: "set aside", proof: "Set aside on purpose" },
  missing: { tone: "danger", chip: "missing", proof: "Missing" },
};

export const EVIDENCE_TONE: Record<Evidence, Tone> = { math: "ok", quote: "ok", ocr_match: "ok", two_reads: "ok", house_rule: "accent", person: "info", none: "warn" };

export const GROUPS: { title: string; categories: TermCategory[] }[] = [
  { title: "Fees paid once", categories: ["site_fee"] },
  { title: "Recurring fees", categories: ["recurring_fee"] },
  { title: "Per-visit and conditional payments", categories: ["conditional_procedure"] },
  { title: "Things the site invoices", categories: ["invoiceable"] },
  { title: "Screen failures", categories: ["screen_failure"] },
  { title: "Unscheduled visits", categories: ["unscheduled_visit"] },
  { title: "Stipends, travel and bonuses", categories: ["stipend_travel", "bonus"] },
  { title: "Holdback", categories: ["holdback"] },
  { title: "Overhead", categories: ["overhead"] },
  { title: "Payment terms and deadlines", categories: ["payment_terms", "invoicing", "deadline"] },
  { title: "Caps and limits", categories: ["cap_or_limit"] },
  { title: "Other", categories: ["other"] },
];

export const groupTitle = (c: TermCategory) => GROUPS.find((g) => g.categories.includes(c))?.title ?? "Other";

/** "Avery Chen: Pay it once", when a person answered a question about this term or grid. */
export function decidedBy(d: ProofData, ref: CoverageRef): string | null {
  const q = d.rulebook.questions.find((x) => x.about?.target === ref.target && x.about.id === ref.id && d.version.answers.some((a) => a.questionId === x.id));
  const a = q && d.version.answers.find((x) => x.questionId === q.id);
  return q && a ? `${a.by}: ${q.options[a.option]?.label ?? "answered"}` : null;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
