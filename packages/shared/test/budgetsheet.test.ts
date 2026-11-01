import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BUDGET_CHECK, type BudgetGrid, budgetCheck, budgetCheckWords, noBudgetWords, type Sheet, staleBudgetCheck } from "../src";
import { MAX_SHEET_BYTES, readSheets, SpreadsheetTooLargeError } from "../src/xlsx";

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

  it("reads every amount through parseCents: never rounded into a match, a credit in brackets, a comma that isn't a thousands one", () => {
    const one = (cell: string | number, unitCents: number) =>
      budgetCheck({ budgetGrids: [{ ...grid, procedures: [proc(null, "Blood draw", unitCents, {})] }] }, [{ name: "USA", rows: [HEAD, [null, "Blood draw", 1, "x", cell, null, null]] }])!.differences;
    // float math made each of these a match (1.005 * 100 = 100.49999…, 150.004 rounded to 15000, "1,23" read as 123)
    for (const [cell, contract, printed] of [[1.005, 101, "1.005"], [1.005, 100, "1.005"], [0.285, 29, "0.285"], [0.285, 28, "0.285"], [150.004, 15000, "150.004"], ["1,23", 12300, "1,23"], ["$1.005", 101, "$1.005"]] as const)
      expect(one(cell, contract)).toEqual([{ what: `Blood draw: unit price: the spreadsheet's ${printed} can't be read to the cent`, contract, spreadsheet: null }]);
    expect(one("(500.00)", 50000)).toEqual([{ what: "Blood draw: unit price", contract: 50000, spreadsheet: -50000 }]);
    // what matches: a formula's binary noise as Excel shows it (55 * 1.4), a price written as text
    expect(one(55 * 1.4, 7700)).toEqual([]);
    expect(one("$1,234.50", 123450)).toEqual([]);
    expect(one(150.01, 15001)).toEqual([]);
  });

  it("a check made before the master changed no longer says it matched", () => {
    const matched = budgetCheckWords("Ex A-1.xlsx", budgetCheck({ budgetGrids: [grid] }, sheet())!);
    const stale = staleBudgetCheck(["Other notice", matched]);
    expect(stale).toEqual(["Other notice", "The sponsor's budget spreadsheet was checked before the invoicing master changed, so that check no longer holds: check the spreadsheet again."]);
    expect(stale[1]!.startsWith(BUDGET_CHECK)).toBe(true); // so the next check replaces it
  });

  it("refuses a spreadsheet that unpacks past the limit before ExcelJS inflates it, whatever size the zip states", async () => {
    const zeros = new Blob([new Uint8Array(MAX_SHEET_BYTES + 1)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const data = new Uint8Array(await new Response(zeros).arrayBuffer());
    const name = new TextEncoder().encode("xl/worksheets/sheet1.xml");
    // a local entry, the central directory's entry and its end record; the zip claims 100 bytes unpacked, as a zip bomb would
    const local = 30 + name.length + data.length;
    const central = 46 + name.length;
    const zip = new Uint8Array(local + central + 22);
    const v = new DataView(zip.buffer);
    const entry = (at: number, sig: number, o: number) => {
      v.setUint32(at, sig, true);
      v.setUint16(at + 8 + o, 8, true); // deflated
      v.setUint32(at + 18 + o, data.length, true);
      v.setUint32(at + 22 + o, 100, true);
      v.setUint16(at + 26 + o, name.length, true);
    };
    entry(0, 0x04034b50, 0);
    zip.set(name, 30);
    zip.set(data, 30 + name.length);
    entry(local, 0x02014b50, 2); // "made by" comes first in a central entry
    zip.set(name, local + 46);
    v.setUint32(local + central, 0x06054b50, true);
    v.setUint16(local + central + 8, 1, true);
    v.setUint16(local + central + 10, 1, true);
    v.setUint32(local + central + 12, central, true);
    v.setUint32(local + central + 16, local, true);
    await expect(readSheets(zip)).rejects.toBeInstanceOf(SpreadsheetTooLargeError);
  });
});
