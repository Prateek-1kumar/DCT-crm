import ExcelJS from "exceljs";
import { ENUM_LABELS } from "./labels";
import { armKey, gridChoice, governingGrids, type Rulebook, upgradeRulebook } from "./rulebook";

/**
 * The invoicing master as an Excel workbook: Summary, Budget grid, Fees & invoiceables, Payment terms, Bill by hand.
 * Billing works from it, so every term that limits or changes a bill is in it: caps with their numbers, which grid is
 * billed for each arm, how each visit is paid, which rows get overhead, and the terms billed by hand.
 * Built by the server (GET /studies/:id/versions/:v/export.xlsx) and by the in-browser sample server. Import it from
 * "@dct/shared/xlsx" so ExcelJS stays out of everything else that uses @dct/shared.
 */

export type WorkbookMeta = {
  protocol: string | null;
  sponsor: string | null;
  site: string | null;
  investigator: string | null;
  version: number;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

const MONEY = '"$"#,##0.00';
const label = (field: string, v: string | null | undefined) => (v ? (ENUM_LABELS[field]?.[v] ?? v) : "Not stated");
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? null : c / 100);
const usd = (c: number | null) => (c === null ? "?" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

type Cap = Rulebook["invoiceables"][number]["cap"];
/** A cap with its numbers, in words. */
function capWords(cap: Cap): string {
  switch (cap.kind) {
    case "none":
      return "No cap";
    case "count":
      return `At most ${cap.n ?? "?"}`;
    case "amount":
      return `At most ${usd(cap.n)} in total`;
    case "ratio_to_randomized":
      return `${cap.ratio ?? "?"} per randomized subject${cap.n !== null ? `, ${cap.n} at most` : ""}`;
    case "blocks_with_reauth":
      return `${cap.n ?? "?"} at a time, then the sponsor has to approve more`;
  }
}

function heading(ws: ExcelJS.Worksheet, text: string) {
  const r = ws.addRow([text]);
  r.font = { bold: true, size: 13 };
  return r;
}

function pairs(ws: ExcelJS.Worksheet, rows: [string, string | number | null][], money: Set<string> = new Set()) {
  for (const [k, v] of rows) {
    const r = ws.addRow([k, v ?? "Not stated"]);
    r.getCell(1).font = { color: { argb: "FF5E5E5A" } };
    if (money.has(k) && typeof v === "number") r.getCell(2).numFmt = MONEY;
  }
}

export async function buildWorkbook(stored: Rulebook, meta: WorkbookMeta): Promise<Uint8Array<ArrayBuffer>> {
  const rb = upgradeRulebook(stored);
  const wb = new ExcelJS.Workbook();
  wb.creator = "DCT Finance";
  wb.created = meta.approvedAt ? new Date(meta.approvedAt) : new Date();

  // Summary
  const s = wb.addWorksheet("Summary");
  s.columns = [{ width: 30 }, { width: 70 }];
  heading(s, `${meta.protocol ?? "Contract"} · invoicing master`);
  s.addRow([]);
  const gridTotals = rb.budgetGrids.map((g) => [`Per patient · ${g.label}`, dollars(g.perPatientTotals[0]?.cents ?? g.visits.reduce((n, v) => n + v.totalCents, 0))] as [string, number | null]);
  // an arm with a chosen grid is billed from that grid only
  const billedFrom = [...governingGrids(rb)].map(([arm, id]): [string, string] => [
    `Billed from${rb.budgetGrids.find((g) => armKey(g) === arm)?.arm ? ` · ${rb.budgetGrids.find((g) => armKey(g) === arm)!.arm}` : ""}`,
    rb.budgetGrids.find((g) => g.id === id)!.label,
  ]);
  const missing = rb.referencedDocuments.filter((d) => !d.present);
  pairs(
    s,
    [
      ["Sponsor", meta.sponsor],
      ["Invoices go to (paying agent)", rb.study.payingAgent.value],
      ["Site", meta.site],
      ["Principal investigator", meta.investigator],
      ["Effective date", rb.study.effectiveDate.value],
      ["Version", `${meta.version} · ${meta.status === "signed" ? "Live" : meta.status}`],
      ["Approved", meta.approvedBy ? `${meta.approvedBy}${meta.approvedAt ? ` · ${meta.approvedAt.slice(0, 10)}` : ""}` : "Not approved yet"],
      ["Payment", rb.payment.netDays.value !== null ? `${rb.payment.netDays.value} days${rb.payment.netDaysFrom.value ? ` from ${rb.payment.netDaysFrom.value}` : ""}` : null],
      ["Holdback", rb.holdback ? `${rb.holdback.pct}% of ${rb.holdback.appliesTo}` : "None"],
      ["Overhead", rb.overhead.pct.value !== null ? `${rb.overhead.pct.value}% on ${label("appliesTo", rb.overhead.appliesTo.value).toLowerCase()}` : "None"],
      ["Screen failure", dollars(rb.screenFail?.amountCents ?? null)],
      ...gridTotals,
      ...billedFrom,
      ["Billed by hand", rb.unclassified.length ? `${rb.unclassified.length} ${rb.unclassified.length === 1 ? "term" : "terms"}: see the Bill by hand sheet` : "None"],
      ...missing.map((d): [string, string] => ["Referred to, not uploaded", `${d.description}${d.date ? ` (${d.date})` : ""}: terms that depend on it aren't checked`]),
    ],
    new Set(["Screen failure", ...gridTotals.map(([k]) => k)]),
  );

  // Budget grid: one table per grid, procedures × visits, then the totals rows.
  const g = wb.addWorksheet("Budget grid", { views: [{ state: "frozen", xSplit: 2 }] });
  g.getColumn(1).width = 38;
  g.getColumn(2).width = 12;
  for (const grid of rb.budgetGrids) {
    const visits = [...grid.visits].sort((a, b) => a.order - b.order);
    const choice = gridChoice(rb, grid);
    const billed =
      !choice ? ""
      : choice.billed ? " · BILLED FROM THIS GRID"
      : choice.instead ? ` · NOT BILLED: ${choice.instead.label} is billed instead${choice.same ? " (it prices every visit the same)" : ""}`
      : " · NOT BILLED: no grid was chosen for this arm";
    heading(g, `${grid.label}${grid.arm ? ` · ${grid.arm}` : ""}${grid.statedOverheadPct !== null ? ` · overhead ${grid.statedOverheadPct}%` : ""}${billed}`);
    const head = g.addRow(["Procedure", "Code", "Unit", "Overhead added", ...visits.map((v) => `${v.code} · ${v.name}`)]);
    head.font = { bold: true };
    head.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F3F0" } }));
    g.addRow(["How the visit is paid", "", null, "", ...visits.map((v) => (v.autopay ? "Automatic" : "By invoice"))]).font = { italic: true };
    for (const p of grid.procedures) {
      const r = g.addRow([p.name, p.code ?? "", dollars(p.unitCents), p.overheadApplied ? "Yes" : "No", ...visits.map((v) => (p.cells[v.code] === "invoiceable" ? "Invoiceable" : dollars(p.cells[v.code] as number | undefined) ?? ""))]);
      r.eachCell((c, i) => (i === 3 || i >= 5) && typeof c.value === "number" && (c.numFmt = MONEY));
    }
    const totals: [string, "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents" | "totalCents"][] = [
      ["Procedures", "procedureSubtotalCents"],
      ["Overhead", "overheadCents"],
      ["Staff and stipends", "nonProcedureCents"],
      ["Visit total", "totalCents"],
    ];
    for (const [name, f] of totals) {
      if (!visits.some((v) => v[f] !== null)) continue;
      const r = g.addRow([name, "", null, "", ...visits.map((v) => dollars(v[f]))]);
      r.font = { bold: f === "totalCents" };
      r.eachCell((c, i) => i >= 5 && typeof c.value === "number" && (c.numFmt = MONEY));
    }
    for (const t of grid.perPatientTotals) {
      const r = g.addRow([t.label, "", dollars(t.cents)]);
      r.font = { bold: true };
      r.getCell(3).numFmt = MONEY;
    }
    g.addRow([]);
  }
  for (let i = 3; i <= 4 + Math.max(0, ...rb.budgetGrids.map((x) => x.visits.length)); i++) g.getColumn(i).width = 16;

  // Fees & invoiceables
  const f = wb.addWorksheet("Fees & invoiceables");
  f.columns = [{ width: 14 }, { width: 10 }, { width: 36 }, { width: 14 }, { width: 16 }, { width: 24 }, { width: 18 }, { width: 30 }, { width: 14 }, { width: 30 }];
  const fh = f.addRow(["Type", "Code", "Name", "Amount", "With overhead", "When / basis", "Frequency", "Cap", "Pre-approval", "Needs"]);
  fh.font = { bold: true };
  for (const x of rb.siteFees) f.addRow(["Site fee", x.code ?? "", x.name, dollars(x.amountCents), null, `${label("trigger", x.trigger)}${x.dueDays !== null ? `, due in ${x.dueDays} days` : ""}`, "", "", "", ""]);
  for (const x of rb.invoiceables) f.addRow(["Invoiceable", x.code ?? "", x.name, dollars(x.amountCents), dollars(x.amountWithOverheadCents), label("basis", x.basis), x.frequency, capWords(x.cap), x.requiresPreApproval ? "Yes" : "No", x.requiredDocs.join(", ")]);
  f.eachRow((r, i) => i > 1 && [4, 5].forEach((c) => typeof r.getCell(c).value === "number" && (r.getCell(c).numFmt = MONEY)));

  // Payment terms
  const t = wb.addWorksheet("Payment terms");
  t.columns = [{ width: 34 }, { width: 70 }];
  const p = rb.payment;
  pairs(t, [
    ["Visit payment", label("visitPayment", p.visitPayment.value)],
    ["Frequency", label("frequency", p.frequency.value)],
    ["Net days", p.netDays.value],
    ["Net days counted from", p.netDaysFrom.value],
    ["Invoice address", p.invoiceAddress.value],
    ["Every invoice must show", p.requiredReferences.value.join(", ") || null],
    ["Paid only when", p.paymentConditions.value.join(", ") || null],
    ["Holdback", rb.holdback ? `${rb.holdback.pct}% of ${rb.holdback.appliesTo}` : "None"],
    ["Holdback paid back when", rb.holdback?.releaseConditions.join(", ") || null],
    ["Overhead %", rb.overhead.pct.value],
    ["Overhead applies to", label("appliesTo", rb.overhead.appliesTo.value)],
    ["Screen failure", rb.screenFail ? `${rb.screenFail.amountCents !== null ? usd(rb.screenFail.amountCents) : "Per procedure"} · ${label("basis", rb.screenFail.basis).toLowerCase()} · ${label("paidVia", rb.screenFail.paidVia).toLowerCase()}` : "Not paid"],
    ["Screen failure cap", rb.screenFail ? capWords(rb.screenFail.cap) : null],
    ["Screen failure needs", rb.screenFail?.requiredDocs.join(", ") || null],
    ...rb.deadlines.map((d): [string, string] => [label("kind", d.kind).replace("N", String(d.value)), d.consequence]),
    ["Overpayment refund (days)", rb.overpayment?.refundDays ?? null],
    ["Sponsor may offset", rb.overpayment ? (rb.overpayment.sponsorMayOffset ? "Yes" : "No") : null],
    ["Rounding", label("rounding", rb.rounding.value)],
    ["New terms apply from", rb.appliesFrom.value],
  ]);

  // Bill by hand: money terms the master has no field for, billed from the contract's own words
  const u = wb.addWorksheet("Bill by hand");
  u.columns = [{ width: 30 }, { width: 70 }, { width: 30 }, { width: 8 }, { width: 22 }, { width: 10 }, { width: 10 }, { width: 40 }];
  const uh = u.addRow(["Term", "What the contract says", "File", "Page", "Amounts", "%", "Days", "Note"]);
  uh.font = { bold: true };
  for (const x of rb.unclassified) {
    const file = rb.documents.find((d) => d.id === x.prov.source?.documentId)?.title ?? "";
    u.addRow([x.label, x.quote || "Read it on the page", file, x.page, x.amounts.map((c) => usd(c)).join(", "), x.pct ?? "", x.days ?? "", x.note]).alignment = { wrapText: true, vertical: "top" };
  }
  if (!rb.unclassified.length) u.addRow(["Nothing is billed by hand on this version."]);

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
