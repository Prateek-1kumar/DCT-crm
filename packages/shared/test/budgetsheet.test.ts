import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { type BudgetGrid, budgetCheck, budgetCheckWords, noBudgetWords, type Sheet } from "../src";
import { readSheets } from "../src/xlsx";

// ADR-003 P2: the sponsor's budget spreadsheet checked against the grid read from the signed contract. Synthetic only.

const prov = { source: { documentId: "d1", page: 6 }, confidence: 1, method: "text" as const, crossCheck: "not_checked" as const };
const visit = (code: string, order: number, totalCents: number) => ({ code, name: code, order, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents, autopay: true, prov });
const proc = (code: string | null, name: string, unitCents: number, cells: Record<string, number>) => ({ code, name, unitCents, overheadApplied: true, category: "procedure" as const, cells, prov });
/** Two rows share a code, as a budget's rows often do: they pair up in order. */
const grid: BudgetGrid = {
  id: "t1", label: "Budget", arm: null, statedOverheadPct: 40, header: { investigator: null, siteName: null }, prov, perPatientTotals: [],
  visits: [visit("V1SV", 1, 13600), visit("V2W0", 2, 21700)],
  procedures: [proc("99000", "Blood draw", 5500, { V1SV: 5500, V2W0: 5500 }), proc("99000", "Biomarkers handling", 8100, { V2W0: 16200 }), proc(null, "Diary instruction", 7500, { V1SV: 7500 })],
};
const HEAD = ["Code", "Procedure", "Qty", "OH", "Budget", "V1 SV", "V2W0"];
const ROWS: (string | number | null)[][] = [
  ["Exhibit A-1", null, null, null, null, null, null],
  HEAD,
  ["99000", "Blood draw", 2, "x", 55, 55, 55],
  ["99000", "Biomarkers handling", 2, "x", 81, null, 162],
  [null, "Diary instruction", 1, "x", 75, 75, null],
  [null, "Total Cost Per Visit with Overhead", null, null, null, 136, 217],
];
const sheet = (rows = ROWS): Sheet[] => [{ name: "Notes", rows: [["Read me"]] }, { name: "USA", rows }];

describe("budgetCheck", () => {
  it("finds the sheet that names the grid's visits and compares every unit price, cell and visit total: all match", () => {
    expect(budgetCheck({ budgetGrids: [grid] }, sheet())).toEqual({ sheet: "USA", compared: 3 + 4 + 2, differences: [] });
  });

  it("says each difference, a row on one side only, and the contract's figure beside the spreadsheet's", () => {
    const rows = ROWS.map((r) => [...r]);
    rows[3]![6] = 170; // a cell the spreadsheet prints differently
    rows[4]![1] = "Diary training"; // the contract's row isn't in the spreadsheet, and the spreadsheet's isn't in the contract
    const c = budgetCheck({ budgetGrids: [grid] }, sheet(rows))!;
    expect(c.differences).toEqual([
      { what: "Biomarkers handling at V2W0", contract: 16200, spreadsheet: 17000 },
      { what: "Diary instruction: in the contract, not in the spreadsheet", contract: 7500, spreadsheet: null },
      { what: "Diary training: in the spreadsheet, not in the contract", contract: null, spreadsheet: 7500 },
    ]);
    expect(budgetCheckWords("Ex A-1.xlsx", c)).toBe(
      "The sponsor's budget spreadsheet “Ex A-1.xlsx” differs from the signed contract in 3 places (7 prices compared). The signed contract is what's billed; ask the sponsor which is right: Biomarkers handling at V2W0: contract $162, spreadsheet $170; Diary instruction: in the contract, not in the spreadsheet; Diary training: in the spreadsheet, not in the contract.",
    );
  });

  it("all matching is said too, so the approver knows it was checked", () => {
    expect(budgetCheckWords("Ex A-1.xlsx", budgetCheck({ budgetGrids: [grid] }, sheet())!)).toBe(
      "The sponsor's budget spreadsheet “Ex A-1.xlsx” matches the signed contract: 9 prices compared (unit prices, every visit, the visit totals).",
    );
  });

  it("a spreadsheet with none of the grid's visits in a header row is no check at all", () => {
    expect(budgetCheck({ budgetGrids: [grid] }, [{ name: "Other", rows: [["Code", "Budget", "Week 1", "Week 2"]] }])).toBeNull();
    expect(noBudgetWords("other.xlsx")).toBe("other.xlsx has no sheet with this contract's visits in a header row, so it can't be checked against it. Is it this contract's budget?");
  });

  it("reads a real .xlsx: a formula's computed value, as Excel saved it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("USA");
    for (const r of ROWS) ws.addRow(r);
    ws.getCell("G4").value = { formula: "F3*2+52", result: 162 };
    const data = await wb.xlsx.writeBuffer();
    const read = await readSheets(data as ArrayBuffer);
    expect(read[0]!.rows[3]![6]).toBe(162);
    expect(budgetCheck({ budgetGrids: [grid] }, read)!.differences).toEqual([]);
  });
});
