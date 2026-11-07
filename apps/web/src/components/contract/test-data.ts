import type { Grid } from "@dct/shared";
import type { Coverage, CoverageAmount, CoveragePage } from "@/lib/types";
import { question, rulebook, term, version } from "../version/fixtures";

export const grid: Grid = {
  id: "g1",
  name: "Visit budget",
  arm: null,
  doc: "Contract.pdf",
  pages: [2],
  visits: ["Screening", "Week 4"],
  overheadPct: null,
  rows: [{ name: "Blood draw", code: null, unitCostCents: null, cells: [2500, 3000], printedRowTotalCents: null }],
  subtotal: null,
  overhead: null,
  additions: [],
  total: null,
  grandTotalCents: null,
  cellsReadTwice: [],
  acceptedAsPrinted: false,
};

export const amount = (text: string, status: CoverageAmount["status"], ref: CoverageAmount["ref"], over: Partial<CoverageAmount> = {}, y = 0.1): CoverageAmount => ({
  box: [0.1, y, 0.3, y + 0.04],
  text,
  line: text,
  cents: 100,
  status,
  ref,
  reason: null,
  doubt: null,
  ...over,
});

export const coverage = (): Coverage => ({
  pages: [
    {
      documentId: "d1",
      doc: "Contract.pdf",
      page: 1,
      kind: "text",
      amounts: [amount("$5,000.00", "captured", { target: "term", id: "t1" }), amount("$99.00", "missing", null, {}, 0.2)],
      clauses: [{ termId: "t1", boxes: [[0.1, 0.5, 0.6, 0.55]] }],
    },
    {
      documentId: "d1",
      doc: "Contract.pdf",
      page: 2,
      kind: "text",
      amounts: [
        amount("$25.00", "captured", { target: "grid", id: "g1", row: 0, col: 0 }),
        amount("$30.00", "decided", { target: "term", id: "t2" }, {}, 0.2),
        amount("$1,000.00", "set_aside", null, { reason: "Superseded budget" }, 0.3),
        amount("$31.00", "captured", { target: "grid", id: "g1", row: 0, col: 1 }, { doubt: "handwritten" }, 0.4),
      ],
      clauses: [],
    },
    { documentId: "d2", doc: "Amendment.pdf", page: 1, kind: "image", amounts: [], clauses: [] },
  ],
  totals: { amounts: 6, captured: 3, decided: 1, setAside: 1, missing: 1 },
});

export const pageOf = (n: number): CoveragePage => coverage().pages[n]!;

export const documents = [
  { id: "d1", name: "Contract.pdf", pageCount: 2 },
  { id: "d2", name: "Amendment.pdf", pageCount: 1 },
];

export const sampleVersion = (over: Parameters<typeof version>[0] = {}) =>
  version({
    documents,
    rulebook: rulebook({
      terms: [
        term("t1", { name: "Startup fee", category: "site_fee", amountCents: 500000, source: { doc: "Contract.pdf", page: 1, quote: "Startup fee $5,000" } }),
        term("t2", { name: "Holdback", category: "holdback", evidence: "person" }),
        term("t3", { name: "Archive fee", category: "recurring_fee", evidence: "none" }),
      ],
      grids: [grid],
      questions: [question("q1", { about: { target: "term", id: "t2" } })],
    }),
    answers: [{ questionId: "q1", option: 0, by: "Ana", at: "2026-11-02T10:00:00Z" }],
    ...over,
  });
