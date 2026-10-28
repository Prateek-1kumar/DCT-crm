import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { billedGrids, blindDetail, blindReview, governingGrids, mask, type ReviewItem, Rulebook, upgradeRulebook } from "../src";
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
    expect(billedGrids({ ...rb, governingGridIds: [], governingGridId: null }).map((g) => g.id)).toEqual(["gA1", "gA2", "gB1", "gB2"]);
  });
});

describe("mask: a withheld value leaves nothing that restates it", () => {
  const rb = upgradeRulebook(stored as unknown as Rulebook);
  const none = { evidence: [], review: [] };
  it("blanks the numbers in its item's words and location; keeps the page, ids and fixed-list values", () => {
    const d = mask(rb, ["/deadlines/0/value"], none).deadlines[0]!;
    expect(d.value).toBeNull();
    expect(d.kind).toBe("invoice_days_from_expense");
    expect(d.consequence).toBe("not paid if invoiced more than ••• days after the expense");
    expect(d.prov.source).toEqual({ documentId: "d1", page: 6, location: "§5.2 (••• days)" });
    // a row's name keeps its words; only an amount or % in it is blanked
    const p = mask({ ...rb, budgetGrids: [{ ...rb.budgetGrids[0]!, procedures: [{ ...rb.budgetGrids[0]!.procedures[0]!, name: "ECG, 12-lead $55.00" }] }] }, ["/budgetGrids/0/procedures/0/cells/V1"], none).budgetGrids[0]!.procedures[0]!;
    expect([p.name, p.code, p.cells.V1]).toEqual(["ECG, 12-lead •••", "36415", null]);
    expect(mask(rb, ["/screenFail/cap/n"], none).screenFail).toMatchObject({ cap: { kind: "blocks_with_reauth", n: null }, requiredDocs: ["screening log"], paidVia: "invoice" });
    // the others are untouched
    expect(mask(rb, ["/deadlines/0/value"], none).invoiceables).toEqual(rb.invoiceables);
  });

  it("blanks a money term quoted from the same printed line as a withheld value", () => {
    const at = (y: number) => [{ documentId: "d1", page: 1, box: [0.1, y, 0.8, 0.02] as [number, number, number, number] }];
    const item = (id: string, y: number): ReviewItem => ({
      id, kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, question: `Page 1 has an amount that the invoicing master doesn't have: "Re-consent $100.00 $130.00". How should it be handled?`,
      input: null, options: [], where: at(y), blocking: true, answer: null, outcome: null, compare: null, sentBack: null, term: { quote: "Re-consent $100.00 $130.00", amounts: [13000] },
    });
    const evidence = [{ path: "/invoiceables/0/amountCents", status: "conflict" as const, where: at(0.5), printed: "$100.00", note: null }];
    const [same, other] = blindReview([item("u1", 0.505), item("u2", 0.7)], ["/invoiceables/0/amountCents"], evidence);
    expect(same!.question).not.toMatch(/100|130/);
    expect(same!.term).toEqual({ quote: "Re-consent $••• $•••", amounts: [] });
    expect(other!.question).toMatch(/\$100\.00/);

    // listed to bill by hand, the term carries those words onto the master and into the log: blanked there too
    const listed = { ...item("u1", 0.505), outcome: "chosen" as const, answer: { optionId: "bill_by_hand", note: "Re-consent at $100.00, the $130.00 one", by: "Asha", at: "" } };
    const entry = { label: "Re-consent $100.00 $130.00", quote: "Re-consent $100.00 $130.00", page: 1, amounts: [13000], pct: 5, note: "the $130.00 one", prov: { ...prov, method: "manual" as const }, itemId: "u1" };
    const elsewhere = { ...entry, itemId: "u2", label: "Parking $12.00", quote: "Parking $12.00", amounts: [1200] };
    const withList = { ...rb, unclassified: [entry, elsewhere] };
    const on = { evidence, review: [listed, item("u2", 0.7)] };
    expect(mask(withList, ["/invoiceables/0/amountCents"], on).unclassified).toEqual([
      { label: "Re-consent $••• $•••", quote: "Re-consent $••• $•••", page: 1, amounts: [], note: "the $••• one", prov: entry.prov, itemId: "u1" },
      elsewhere,
    ]);
    expect(blindReview([listed], ["/invoiceables/0/amountCents"], evidence)[0]!.answer!.note).toBe("Re-consent at $•••, the $••• one");
    const logged = { version: 1, itemId: "u1", question: listed.question, note: listed.answer.note, billByHand: entry.label };
    expect(JSON.stringify(blindDetail("review.answered", logged, { hidden: new Set(["/invoiceables/0/amountCents"]), ...on }))).not.toMatch(/100|130/);
    // its question not on this version: copied from the approved live version with a correction, shown in full there
    expect(mask(withList, ["/invoiceables/0/amountCents"], { evidence, review: [] }).unclassified).toEqual(withList.unclassified);
    // nothing withheld on its line: shown as listed
    expect(mask(withList, ["/deadlines/0/value"], on).unclassified).toEqual(withList.unclassified);
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
