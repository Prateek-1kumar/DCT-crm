import type { ReadWarning } from "@dct/extraction";
import { armKey, type ContractAnomaly, type DocumentKind, gridPrices, type Rulebook } from "@dct/shared";
import type { ExtractionPort, InputDoc, NoAi } from "./port.js";

// Fake adapter (EXTRACTION_FAKE=1): a synthetic rulebook shaped like the COPD work order, with
// deliberate problems so every review action has something to act on. Never touches AI or real PDFs.

const kindFromName = (filename: string, i: number): DocumentKind => {
  const f = filename.toLowerCase();
  if (f.includes("amend")) return "amendment";
  if (f.includes("master")) return "master_agreement";
  if (f.includes("budget")) return "budget";
  if (f.includes("adopt")) return "adoption";
  return i === 0 ? "work_order" : "other";
};

function fixture(docs: InputDoc[]): Rulebook {
  const documentId = docs[0]?.id ?? "d1";
  const prov = { source: { documentId, page: 1 }, confidence: 0.98, method: "ai", crossCheck: "agree" } as const;
  const s = <T>(value: T, p: typeof prov = prov) => ({ value, prov: p });
  // a rule's value is checked inside the sentence it quotes (test/helpers.ts makeTextPdf prints these)
  const quoted = (quote: string) => ({ ...prov, source: { ...prov.source, quote } });
  const amended = docs.some((d) => d.kind === "amendment" || /amend/i.test(d.filename));
  // grids are on page 2, so "show in contract" visibly jumps
  const gridProv = { ...prov, source: { documentId, page: 2 } };
  const grid = (id: string, label: string, v2Total: number, prov = gridProv) => ({
    id,
    label,
    arm: null,
    statedOverheadPct: 40,
    visits: [
      { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 380100, overheadCents: 213000, nonProcedureCents: 152400, totalCents: 745500, autopay: true, prov },
      // g1 V2 prints 848900 but its parts sum to 848800 → VISIT_TOTAL_MISMATCH
      { code: "V2", name: "Week 0", order: 2, procedureSubtotalCents: 404700, overheadCents: 242500, nonProcedureCents: 201600, totalCents: v2Total, autopay: true, prov },
    ],
    procedures: [
      { code: "36415", name: "Blood draw", unitCents: 5500, overheadApplied: true, category: "procedure" as const, cells: { V1: 5500, V2: 5500 }, prov },
    ],
    perPatientTotals: [{ label: "Total", cents: 1594300, prov }],
    header: { investigator: "Dr. Test", siteName: "Site A" },
    prov,
  });
  return {
    schemaVersion: 1,
    study: {
      sponsor: s("Synthetic Pharma"),
      payingAgent: s(null),
      protocol: s("SYN-001"),
      siteName: s("Site A"),
      investigator: s("Dr. Test"),
      effectiveDate: s("2025-08-22", quoted("effective as of August 22, 2025")),
      currency: "USD",
    },
    documents: docs.map((d) => ({ id: d.id, kind: d.kind ?? "other", title: d.filename, date: null })),
    referencedDocuments: [{ description: "Master CTA", date: "2024-04-26", present: false, prov }],
    overhead: { pct: s(40), appliesTo: s("all_per_patient_lines") },
    payment: {
      visitPayment: s("auto_edc"),
      frequency: s("monthly"),
      netDays: s(45),
      netDaysFrom: s("receipt of itemized invoice"),
      invoiceAddress: s(null),
      requiredReferences: s(["protocol number"]),
      paymentConditions: s(["eCRFs accepted"]),
    },
    // two grids for the same arm → GRID_CONFLICT
    budgetGrids: [grid("g1", "Exhibit A", 848900), grid("g2", "Exhibit A (revised)", 848800)],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [
      {
        code: "UNSCH",
        name: "Unscheduled visit",
        amountCents: 57200,
        amountWithOverheadCents: amended ? 90000 : 80000,
        basis: "fixed",
        frequency: "per occurrence",
        cap: { kind: "none", n: null, ratio: null },
        requiresPreApproval: true,
        requiredDocs: ["detailed invoice"],
        prov,
      },
    ],
    screenFail: { amountCents: 745500, basis: "fixed", cap: { kind: "blocks_with_reauth", n: 7, ratio: null }, paidVia: "invoice", requiredDocs: ["eCRFs", "detailed invoice"], prov: quoted("paid up to a maximum of 7 before the Sponsor approves more") },
    siteFees: [
      // the amendment adds a fee in front (same amount), so index-based paths now point at a different item
      ...(amended ? [{ code: "SC001", name: "Start-up fee", amountCents: 1200000, trigger: "one_time" as const, dueDays: 30, prov }] : []),
      { code: "SC003", name: "Administrative fee", amountCents: 1200000, trigger: "study_initiation", dueDays: 45, prov: quoted("due within 45 days of study initiation") },
    ],
    holdback: null,
    deadlines: [{ kind: "invoice_months_after_study_close", value: 6, consequence: "may not be approved", prov }],
    overpayment: null,
    rounding: s("printed_amounts"),
    appliesFrom: s(amended ? "2026-01-01" : null),
    unclassified: [],
  };
}

const anomaly = (a: Omit<ContractAnomaly, "id" | "resolution" | "refs"> & { refs?: ContractAnomaly["refs"] }): ContractAnomaly => ({
  id: `${a.code}:${a.path ?? ""}`,
  refs: [],
  resolution: null,
  ...a,
});

/**
 * A few real-ish checks; the real ones live in @dct/extraction. Each has the real check's severity and fires on the same
 * condition, so the tests exercise what production asks.
 */
function runContractChecks(rb: Rulebook, opts?: { crossRead?: Rulebook | null }): ContractAnomaly[] {
  const out: ContractAnomaly[] = [];
  rb.budgetGrids.forEach((g, gi) =>
    g.visits.forEach((v, vi) => {
      // as the real check: only a visit that prints its subtotal and overhead can be added up
      if (v.procedureSubtotalCents === null || v.overheadCents === null) return;
      const parts = v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0);
      if (parts !== v.totalCents)
        out.push(
          anomaly({
            code: "VISIT_TOTAL_MISMATCH",
            severity: "warning",
            message: `${g.label} ${v.name}: printed total ${v.totalCents} ≠ parts ${parts}`,
            path: `/budgetGrids/${gi}/visits/${vi}/totalCents`,
            refs: v.prov.source ? [v.prov.source] : [],
            detail: { expected: parts, actual: v.totalCents },
          }),
        );
    }),
  );
  rb.referencedDocuments.forEach((d, i) => {
    if (!d.present)
      out.push(anomaly({ code: "MISSING_REFERENCED_DOC", severity: "warning", message: `Referenced "${d.description}" was not uploaded`, path: `/referencedDocuments/${i}`, detail: {} }));
  });
  // as the real check: per arm (armKey), grids that price anything differently (gridPrices, a single cell included), only
  // while no grid was chosen the old way
  const arms = new Map<string, string[]>();
  for (const g of rb.budgetGrids) arms.set(armKey(g), [...(arms.get(armKey(g)) ?? []), g.id]);
  const sig = (id: string) => gridPrices(rb.budgetGrids.find((g) => g.id === id)!);
  for (const [arm, ids] of arms)
    if (ids.length > 1 && rb.governingGridId === null && new Set(ids.map(sig)).size > 1)
      // same path as the real check: the first conflicting grid
      out.push(anomaly({ code: "GRID_CONFLICT", severity: "blocker", message: `${ids.length} grids for arm "${arm || "(single)"}" disagree; choose the governing grid`, path: `/budgetGrids/${rb.budgetGrids.findIndex((g) => g.id === ids[0])}`, detail: { gridIds: ids } }));
  opts?.crossRead?.invoiceables.forEach((x, i) => {
    const mine = rb.invoiceables[i];
    if (mine && mine.amountWithOverheadCents !== x.amountWithOverheadCents)
      out.push(
        anomaly({
          code: "AI_DISAGREEMENT",
          severity: "warning",
          message: `${mine.name}: Claude read ${mine.amountWithOverheadCents}, OpenAI read ${x.amountWithOverheadCents}`,
          path: `/invoiceables/${i}/amountWithOverheadCents`,
          detail: { claude: mine.amountWithOverheadCents, openai: x.amountWithOverheadCents },
        }),
      );
  });
  return out;
}

/**
 * Test hooks: make the next N extractStudy calls throw; count the AI calls; hold a read until a test lets it go on; what
 * the reading warns about (as the real one says it); the last read's abort signal (the job's).
 */
export const fakeControls: { failNext: number; calls: { identify: number; extract: number }; hold: Promise<void> | null; warnings: ReadWarning[]; signal: AbortSignal | undefined } = {
  failNext: 0,
  calls: { identify: 0, extract: 0 },
  hold: null,
  warnings: [],
  signal: undefined,
};

// No renderPage or text layer: fake mode uses the real ones (see port.ts).
export const fakeExtraction: Omit<ExtractionPort, NoAi> = {
  async identifyDocuments(docs) {
    fakeControls.calls.identify++;
    return {
      documentKinds: Object.fromEntries(docs.map((d, i) => [d.id, kindFromName(d.filename, i)])),
      studyGuess: { sponsor: "Synthetic Pharma", protocol: "SYN-001", siteName: "Site A", investigator: "Dr. Test" },
    };
  },
  async extractStudy({ documents, onProgress, signal }) {
    fakeControls.calls.extract++;
    fakeControls.signal = signal;
    await fakeControls.hold;
    if (fakeControls.failNext > 0) {
      fakeControls.failNext--;
      throw new Error("fake extraction failure");
    }
    // lets a running server (e2e, manual testing) exercise the failure path: retry fails too, manual entry is the way out
    if (documents.some((d) => /unreadable/i.test(d.filename))) throw new Error("fake extraction failure: pages could not be read");
    onProgress?.(50, "reading pages");
    const rulebook = fixture(documents);
    const crossRead = structuredClone(rulebook);
    crossRead.invoiceables[0]!.amountWithOverheadCents = 80100;
    onProgress?.(100, "done");
    return {
      rulebook,
      crossRead,
      pages: documents.map((d) => ({ documentId: d.id, page: 1, kind: "budget_grid" as const, readable: true })),
      cost: [
        { provider: "anthropic", model: "fake", inputTokens: 1000, outputTokens: 200, usd: 0.05 },
        { provider: "openai", model: "fake", inputTokens: 800, outputTokens: 150, usd: 0.02 },
      ],
      warnings: [...fakeControls.warnings],
    };
  },
  runContractChecks,
};
