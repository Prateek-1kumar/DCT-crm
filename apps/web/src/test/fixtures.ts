import { appliesFromOf, type BudgetGrid, type Provenance, type Rulebook, RulebookVersionDto, StudyDetailDto, type ValueEvidence } from "@dct/shared";

/**
 * Invented data for the web's tests: no real sponsor, contract or person. Each builder returns a fresh copy, and the
 * DTOs are parsed with the shared schemas, so a fixture the API couldn't send fails here first.
 */

export const DOC = "doc-1";
const AT = "2026-10-01T10:00:00.000Z";

const prov = (page: number, quote?: string): Provenance => ({ source: { documentId: DOC, page, ...(quote ? { quote } : {}) }, confidence: 0.97, method: "ai", crossCheck: "agree" });
const s = <T>(value: T, page: number, quote?: string) => ({ value, prov: prov(page, quote) });

const VISITS = [["SCR", "Screening"], ["V1", "Day 1"], ["V2", "Week 4"]] as const;

/** A budget grid of three visits and three procedures, 20% overhead; `extra` is added to every unit price. */
export function grid(id = "g-a", label = "Exhibit A – Budget", arm: string | null = null, extra = 0): BudgetGrid {
  const procedures = ([["Physical exam", 14200], ["Blood draw", 2500], ["ECG, 12-lead", 7600]] as const).map(([name, unit]) => ({
    code: null, name, unitCents: unit + extra, overheadApplied: true, category: "procedure" as const,
    cells: Object.fromEntries(VISITS.map(([code]) => [code, unit + extra])), prov: prov(9),
  }));
  const sub = procedures.reduce((n, p) => n + p.unitCents, 0);
  const overhead = Math.round(sub / 5);
  const visits = VISITS.map(([code, name], i) => ({ code, name, order: i + 1, procedureSubtotalCents: sub, overheadCents: overhead, nonProcedureCents: 0, totalCents: sub + overhead, autopay: true, prov: prov(9) }));
  return {
    id, label, arm, statedOverheadPct: 20, header: { investigator: null, siteName: null }, prov: prov(9), visits, procedures,
    perPatientTotals: [{ label: "Per completed patient", cents: visits.length * (sub + overhead), prov: prov(9) }],
  };
}

export function rulebook(): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: s("Acme Biologics", 1), payingAgent: s(null, 1), protocol: s("ACM-101", 1), siteName: s("Test Site North", 1), investigator: s("Dr. Pat Example", 1), effectiveDate: s("2025-07-01", 2), currency: "USD" },
    documents: [{ id: DOC, kind: "work_order", title: "Work Order 1 – ACM-101", date: "2025-07-01" }],
    referencedDocuments: [],
    overhead: { pct: s(20, 5), appliesTo: s("procedures_only", 5, "applied to procedure costs only") },
    payment: {
      visitPayment: s("auto_edc", 4), frequency: s("monthly", 4), netDays: s(45, 4, "within 45 days of receipt"), netDaysFrom: s("receipt of invoice", 4),
      invoiceAddress: s(null, 4), requiredReferences: s(["protocol number"], 4), paymentConditions: s([], 4),
    },
    budgetGrids: [grid()],
    governingGridId: null,
    governingGridIds: [],
    invoiceables: [{ code: null, name: "Unscheduled visit", amountCents: 57200, amountWithOverheadCents: null, basis: "fixed", frequency: "per occurrence", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: true, requiredDocs: [], prov: prov(10) }],
    screenFail: { amountCents: 61000, basis: "fixed", cap: { kind: "ratio_to_randomized", n: null, ratio: 1 }, paidVia: "invoice", requiredDocs: [], prov: prov(6, "one screen failure per randomized subject") },
    siteFees: (
      [["Study start-up fee", 1200000, "agreement_execution"], ["IRB initial review", 350000, "actual_cost"], ["Record archiving", 150000, "closeout"], ["Annual maintenance", 200000, "annual"]] as const
    ).map(([name, amountCents, trigger]) => ({ code: null, name, amountCents, trigger, dueDays: 30, prov: prov(7) })),
    holdback: { pct: 5, appliesTo: "per-patient visit payments", releaseConditions: ["database lock"], prov: prov(7) },
    deadlines: [{ kind: "invoice_days_from_expense", value: 90, consequence: "not payable", prov: prov(8) }],
    overpayment: null,
    rounding: s("cents", 5),
    appliesFrom: s(null, 2),
    unclassified: [],
  };
}

/** Every number in the master, as JSON pointers, in the order the master holds them. */
export function numberPaths(rb: Rulebook): string[] {
  const out: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (typeof o === "number") return void out.push(path);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) if (k !== "prov" && k !== "order" && k !== "schemaVersion") walk(v, `${path}/${k}`);
  };
  walk(rb, "");
  return out;
}

/** Every number confirmed by the PDF's text, each on a line of its own page. */
export const confirmed = (rb: Rulebook): ValueEvidence[] =>
  numberPaths(rb).map((path, i) => ({
    path, status: "confirmed", printed: null, note: null,
    where: [{ documentId: DOC, page: path.startsWith("/budgetGrids/") ? 9 : 4, box: [0.1, 0.05 + (i % 45) * 0.02, 0.3, 0.015] }],
  }));

export function version(rb: Rulebook | null = rulebook(), over: Partial<RulebookVersionDto> = {}): RulebookVersionDto {
  return RulebookVersionDto.parse({
    studyId: "st-1", version: 1, status: "draft", createdAt: AT, signedBy: null, signedAt: null, appliesFrom: rb && appliesFromOf(rb),
    rulebook: rb, anomalies: [], editors: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, evidence: rb ? confirmed(rb) : [], review: [],
    pdfCheck: null, byHand: false, typingDoneAt: null, proofread: [], updatedAt: AT, warnings: [], ...over,
  });
}

export function study(over: Partial<StudyDetailDto> = {}): StudyDetailDto {
  return StudyDetailDto.parse({
    id: "st-1", sponsor: "Acme Biologics", protocol: "ACM-101", siteName: "Test Site North", investigator: "Dr. Pat Example", status: "needs_review", liveVersion: null, needsYou: 0, updatedAt: AT,
    documents: [{ id: DOC, filename: "ACM-101_work-order.pdf", sha256: "0".repeat(64), kind: "work_order", pageCount: 12, uploadedAt: AT, duplicateOf: null, text: "text" }],
    versions: [{ version: 1, status: "draft", createdAt: AT, signedBy: null, signedAt: null, appliesFrom: "2025-07-01" }],
    ...over,
  });
}
