import type { Grid } from "@dct/shared";

// Synthetic grid for tab tests: long names and big numbers on purpose.
export const bigGrid = (over: Partial<Grid> = {}): Grid => ({
  id: "g1",
  name: "Main visit budget for the extension phase of the long-running study",
  arm: "Arm A — Investigational product, twice daily",
  doc: "Budget.pdf",
  pages: [3, 4],
  visits: ["Screening", "Week 4"],
  overheadPct: 28,
  rows: [
    { name: "Comprehensive metabolic panel with extended lipid profile and long description", code: "80053", unitCostCents: 123456789, cells: [123456789, "Invoice"], printedRowTotalCents: 123456789 },
    { name: "ECG", code: null, unitCostCents: null, cells: [9800, null], printedRowTotalCents: null },
  ],
  subtotal: [123466589, 0],
  overhead: [34570645, 0],
  additions: [],
  total: [158037234, 0],
  grandTotalCents: 158037234,
  cellsReadTwice: [],
  acceptedAsPrinted: false,
  ...over,
});
