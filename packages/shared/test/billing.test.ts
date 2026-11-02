import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { billedGrids, governingGrids, type ReviewItem, Rulebook, upgradeRulebook } from "../src";
import { buildWorkbook } from "../src/xlsx";

const prov = { source: { documentId: "d1", page: 6, location: "§5.2 (90 days)", quote: "within ninety (90) days" }, confidence: 0.98, method: "ai", crossCheck: "agree" } as const;
const s = <T>(value: T) => ({ value, prov });
const grid = (id: string, label: string, arm: string | null, total: number) => ({
  id, label, arm, statedOverheadPct: null, prov, header: { investigator: null, siteName: null }, perPatientTotals: [],
  visits: [{ code: "V1", name: "Screening", order: 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: total, autopay: false, prov }],
  procedures: [{ code: "36415", name: "Blood draw", unitCents: 5500, overheadApplied: true, category: "procedure", cells: { V1: 5500 }, prov }],
});

/** As stored before `governingGridIds` and `unclassified` existed: a signed version's JSON never changes. */
const stored = {
  schemaVersion: 1,
  study: { sponsor: s("Synthetic Pharma"), payingAgent: s("Crestline CRO"), protocol: s("SYN-001"), siteName: s("Site A"), investigator: s("Dr. Test"), effectiveDate: s("2025-08-22"), currency: "USD" },
  documents: [{ id: "d1", kind: "work_order", title: "Work Order", date: null }],
  referencedDocuments: [],
  overhead: { pct: s(40), appliesTo: s("procedures_only") },
  payment: {
    visitPayment: s("auto_edc"), frequency: s("monthly"), netDays: s(45), netDaysFrom: s(null), invoiceAddress: s(null), requiredReferences: s([]), paymentConditions: s([]),
  },
  budgetGrids: [grid("gA1", "Arm A exhibit", "Arm A", 100), grid("gA2", "Arm A budget", "arm a", 200), grid("gB1", "Arm B exhibit", "Arm B", 300), grid("gB2", "Arm B budget", "Arm B", 400)],
  governingGridId: "gB2",
  invoiceables: [
    { code: "RC", name: "Re-consent", amountCents: 10000, amountWithOverheadCents: null, basis: "fixed", frequency: "per occurrence", cap: { kind: "count", n: 3, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov },
  ],
  screenFail: { amountCents: 50000, basis: "fixed", cap: { kind: "blocks_with_reauth", n: 7, ratio: null }, paidVia: "invoice", requiredDocs: ["screening log"], prov },
  siteFees: [],
  holdback: null,
  deadlines: [{ kind: "invoice_days_from_expense", value: 90, consequence: "not paid if invoiced more than 90 days after the expense", prov }],
  overpayment: null,
  rounding: s("printed_amounts"),
  appliesFrom: s(null),
};

describe("a stored rulebook from before the new fields", () => {
  it("still parses, and reads with them empty", () => {
    expect(Rulebook.safeParse(stored).success).toBe(true);
    const rb = upgradeRulebook(stored as unknown as Rulebook);
    expect([rb.governingGridIds, rb.unclassified]).toEqual([[], []]);
  });
});

describe("the governing grid, one per arm", () => {
  it("an arm's pick never changes another arm's; the old single pick counts for its own arm", () => {
    const rb = { ...upgradeRulebook(stored as unknown as Rulebook), governingGridIds: ["gA2"] };
    // arms are grouped as the checks group them: "Arm A" and "arm a" are one arm
    expect(Object.fromEntries(governingGrids(rb))).toEqual({ arma: "gA2", armb: "gB2" });
    expect(billedGrids(rb).map((g) => g.id)).toEqual(["gA2", "gB2"]);
    // an arm whose grids differ and has no choice bills none of them until one is chosen (never both)
    expect(billedGrids({ ...rb, governingGridIds: [], governingGridId: null }).map((g) => g.id)).toEqual([]);
  });
});

describe("the Excel export holds every term that limits a bill", () => {
  it("caps with their numbers, the grid billed per arm, how visits are paid, overhead per row, and the terms billed by hand", async () => {
    const rb: Rulebook = {
      ...upgradeRulebook(stored as unknown as Rulebook),
      governingGridIds: ["gA2"],
      unclassified: [{ label: "Parking", quote: "Sponsor will reimburse parking at $12.00 per subject visit.", page: 1, amounts: [1200], note: "", prov: { ...prov, method: "manual" }, itemId: "u1" }],
    };
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(rb, { protocol: "SYN-001", sponsor: "Synthetic Pharma", site: "Site A", investigator: "Dr. Test", version: 1, status: "signed", approvedBy: "Ben", approvedAt: null })).buffer);
    const text = (name: string) => {
      const out: string[] = [];
      wb.getWorksheet(name)!.eachRow((r) => out.push((r.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v))).join(" | ")));
      return out.join("\n");
    };
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Budget grid", "Fees & invoiceables", "Payment terms", "Bill by hand"]);
    expect(text("Summary")).toMatch(/Billed from · Arm A \| Arm A budget/);
    expect(text("Summary")).toMatch(/Billed from · Arm B \| Arm B budget/);
    expect(text("Summary")).toMatch(/Invoices go to \(paying agent\) \| Crestline CRO/);
    expect(text("Budget grid")).toMatch(/Arm A exhibit · Arm A · NOT BILLED: Arm A budget is billed instead/);
    expect(text("Budget grid")).toMatch(/Arm A budget · arm a · BILLED FROM THIS GRID/);
    expect(text("Budget grid")).toMatch(/How the visit is paid \|  \|  \|  \| By invoice/);
    expect(text("Budget grid")).toMatch(/Blood draw \| 36415 \| 55 \| Yes \| 55/);
    expect(text("Fees & invoiceables")).toMatch(/Re-consent .* \| At most 3 \|/);
    expect(text("Payment terms")).toMatch(/Screen failure cap \| 7 at a time, then the sponsor has to approve more/);
    expect(text("Bill by hand")).toMatch(/Parking \| Sponsor will reimburse parking at \$12\.00 per subject visit\. \| Work Order \| 1 \| \$12\.00/);
  });
});
