import type { Cell, Grid, Term } from "@dct/shared";
import { dollars, type CsvCell } from "@/lib/csv";
import type { ActivityItem, Study, StudyRow, Version } from "@/lib/types";
import { calculatedTotals, gridProof, gridProofreads, proofreaders } from "./model";
import { BILLING_SHORT, capText, CATEGORY_LABEL, EVIDENCE_LABEL, HOLDBACK_LABEL, OVERHEAD_LABEL, termMoney } from "./terms";

/** What a spreadsheet says about the version it came from; anything not approved says so first, so it is never billed from. */
export function versionMark(v: Pick<Version, "status" | "approvedAt" | "approvedBy">): { warning: string | null; status: string } {
  if (v.status === "approved") return { warning: null, status: `Approved${v.approvedBy ? ` by ${v.approvedBy}` : ""}${v.approvedAt ? ` on ${new Date(v.approvedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}` };
  if (v.status === "superseded") return { warning: "REPLACED: a newer version of this rulebook is live. Do not bill from this file.", status: "Replaced by a newer version" };
  return { warning: "DRAFT: not approved yet. Do not bill from this file.", status: "Draft, not approved yet" };
}

/** The lines every export of a contract starts with. */
export function exportHead(title: string, v: Pick<Version, "number" | "status" | "approvedAt" | "approvedBy"> | null, now = new Date()): CsvCell[][] {
  const mark = v && versionMark(v);
  return [
    ...(mark?.warning ? [[mark.warning]] : []),
    ["Contract", title],
    ...(v && mark ? [["Version", v.number], ["Status", mark.status]] : []),
    ["Exported", now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })],
    [],
  ];
}

/** "-draft" in the file name too: the name is what people see in a downloads folder or an email. */
export const exportName = (title: string, what: string, v: Pick<Version, "number" | "status"> | null) =>
  [title, v && `v${v.number}`, what, v && v.status !== "approved" && (v.status === "superseded" ? "REPLACED" : "DRAFT-not-approved")].filter(Boolean).join(" ");

const TERM_HEAD = ["Type", "Name", "Amount or rule", "Amount (USD)", "Unit", "How it's billed", "When it applies", "Cap", "Deadline", "Conditions", "Holdback", "Overhead", "Proof", "Proofread by", "Document", "Page", "Contract wording"];

/** One row per term, with where it came from and how it was proven, so the sheet can be checked back against the contract. */
export function termRows(version: Version, terms: Term[]): CsvCell[][] {
  return [
    TERM_HEAD,
    ...terms.map((t) => [
      CATEGORY_LABEL[t.category],
      t.name,
      termMoney(t),
      dollars(t.amountCents),
      t.unit,
      BILLING_SHORT[t.billing],
      t.trigger,
      t.cap && capText(t.cap),
      t.deadline,
      t.conditions,
      t.holdbackApplies === "n/a" ? null : HOLDBACK_LABEL[t.holdbackApplies],
      t.overheadApplies === "n/a" ? null : OVERHEAD_LABEL[t.overheadApplies],
      EVIDENCE_LABEL[t.evidence],
      proofreaders(version, t.id).join(", "),
      t.source.doc,
      t.source.page,
      t.source.quote,
    ]),
  ];
}

const money = (c: Cell | undefined): CsvCell => (typeof c === "number" ? dollars(c) : c);

/** A grid as the screen shows it: items by visit, the printed lines, and the totals we calculated, labelled as such. */
export function gridRows(version: Version, grid: Grid): CsvCell[][] {
  const { names, cells } = gridProofreads(version, grid.id);
  const calc = calculatedTotals(grid);
  const line = (label: string, values: Cell[], total: CsvCell = null, note = "") => [label, null, null, ...grid.visits.map((_, c) => money(values[c])), total, note];
  return [
    ["Budget grid", grid.arm ?? grid.name],
    ["Document", grid.doc, `page${grid.pages.length === 1 ? "" : "s"} ${grid.pages.join(", ")}`],
    ["Proof", EVIDENCE_LABEL[gridProof(grid, version)], cells ? `${cells} cell${cells === 1 ? "" : "s"} proofread${names.length ? ` by ${names.join(", ")}` : ""}` : "No cells proofread yet"],
    ["Item", "Code", "Unit cost (USD)", ...grid.visits, "Item total (USD)", "Item total is"],
    ...grid.rows.map((r, i) => [
      r.name,
      r.code,
      dollars(r.unitCostCents),
      ...grid.visits.map((_, c) => money(r.cells[c])),
      dollars(r.printedRowTotalCents ?? calc.rows[i]),
      r.printedRowTotalCents !== null ? "Printed in the contract" : calc.rows[i] !== null ? "Calculated" : "",
    ]),
    ...(grid.subtotal ? [line("Subtotal", grid.subtotal)] : []),
    ...(grid.overhead ? [line(grid.overheadPct === null ? "Overhead" : `Overhead (${grid.overheadPct}%)`, grid.overhead)] : []),
    ...grid.additions.map((a) => line(a.name, a.cells)),
    ...(grid.total || grid.grandTotalCents !== null ? [line("Total", grid.total ?? [], dollars(grid.grandTotalCents), "Printed in the contract")] : []),
    ...(calc.visits ? [line("Calculated total (not printed in the contract)", calc.visits, null, "Calculated")] : []),
  ];
}

export const gridsRows = (version: Version): CsvCell[][] => (version.rulebook?.grids ?? []).flatMap((g, i) => [...(i ? [[]] : []), ...gridRows(version, g)]);

export const documentRows = (study: Study): CsvCell[][] => [
  ["Document", "Pages", "Size (KB)", "Scanned pages"],
  ...study.documents.map((d) => [d.name, d.pageCount, Math.max(1, Math.round(d.bytes / 1000)), [...d.scannedPages, ...d.scansRead].sort((a, b) => a - b).join(", ")]),
];

export const activityRows = (items: ActivityItem[], withContract: boolean): CsvCell[][] => [
  ["When", "Who", "What happened", ...(withContract ? ["Contract"] : []), "Version"],
  ...items.map((i) => [new Date(i.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), i.by, i.summary, ...(withContract ? [i.studyTitle] : []), i.versionNumber]),
];

/** `where` and `next` are the words the list shows for each contract, so the sheet reads like the screen. */
export const contractRows = (rows: { study: StudyRow; title: string; where: string; next: string }[]): CsvCell[][] => [
  ["Contract", "Sponsor", "Payer", "Site", "Doctor", "Where it is", "Next step", "Open decisions", "Live version", "Latest version", "Last updated"],
  ...rows.map(({ study: s, title, where, next }) => [title, s.sponsor, s.payer, s.site, s.pi, where, next, s.openDecisions, s.liveVersion, s.latestVersion?.number ?? null, new Date(s.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })]),
];

/** A titled block of a file that holds several tables. */
export const section = (title: string, rows: CsvCell[][]): CsvCell[][] => [[title.toUpperCase()], ...rows, []];
