import type { BudgetGrid, ContractAnomaly, DocumentKind, Provenance, Rulebook } from "@dct/shared";

/**
 * SYNTHETIC data only: invented sponsors, protocols, sites and people.
 * Shapes follow packages/shared exactly (checked by fixtures.test.ts).
 */

type Invoiceable = Rulebook["invoiceables"][number];
type Doc = { id: string; kind: DocumentKind; title: string; date: string | null };

export function P(documentId: string, page: number, location?: string, extra: Partial<Provenance> & { quote?: string } = {}): Provenance {
  const { quote, ...rest } = extra;
  return {
    source: { documentId, page, ...(location ? { location } : {}), ...(quote ? { quote } : {}) },
    confidence: 0.97,
    method: "ai",
    crossCheck: "agree",
    ...rest,
  };
}
const s = <T,>(value: T, prov: Provenance) => ({ value, prov });

export const VISITS = [
  { code: "SCR", name: "Screening" },
  { code: "V1", name: "Day 1 · Randomization" },
  { code: "V2", name: "Week 4" },
  { code: "V3", name: "Week 12" },
  { code: "V4", name: "Week 24" },
  { code: "V5", name: "Week 52" },
  { code: "ET", name: "Early termination" },
  { code: "FU", name: "Safety follow-up (phone)" },
] as const;

const ALL = ["SCR", "V1", "V2", "V3", "V4", "V5", "ET"];
const PROCS: { code: string | null; name: string; unit: number; category: "procedure" | "non_procedure"; visits: string[] }[] = [
  { code: "99202", name: "Informed consent & eligibility", unit: 18500, category: "procedure", visits: ["SCR"] },
  { code: "99213", name: "Physical exam", unit: 14200, category: "procedure", visits: ["SCR", "V1", "V3", "V5", "ET"] },
  { code: "VS", name: "Vital signs", unit: 1500, category: "procedure", visits: ALL },
  { code: "94010", name: "Spirometry", unit: 9800, category: "procedure", visits: ALL },
  { code: "93000", name: "ECG, 12-lead", unit: 7600, category: "procedure", visits: ["SCR", "V3", "V5", "ET"] },
  { code: "36415", name: "Blood draw", unit: 2500, category: "procedure", visits: ALL },
  { code: "LAB-KIT", name: "Central lab kit processing", unit: 4500, category: "procedure", visits: ["SCR", "V1", "V3", "V5"] },
  { code: "81025", name: "Urine pregnancy test", unit: 1800, category: "procedure", visits: ["SCR", "V1", "V3", "V5"] },
  { code: "QOL", name: "Quality-of-life questionnaire", unit: 3500, category: "procedure", visits: ["V1", "V3", "V5"] },
  { code: "DRUG", name: "Study drug dispensing & accountability", unit: 6000, category: "procedure", visits: ["V1", "V2", "V3", "V4"] },
  { code: null, name: "Investigator oversight", unit: 22000, category: "non_procedure", visits: [...ALL, "FU"] },
  { code: null, name: "Coordinator time", unit: 16500, category: "non_procedure", visits: [...ALL, "FU"] },
  { code: null, name: "Subject stipend", unit: 7500, category: "non_procedure", visits: ALL },
];

export type GridCfg = {
  id: string;
  label: string;
  arm: string | null;
  docId: string;
  page: number;
  /** Overhead actually used in the visit math. */
  overheadPct: number;
  /** Overhead printed on the grid (differs → OVERHEAD_LABEL_MISMATCH). */
  statedPct?: number;
  /** Price overrides by procedure code/name. */
  prices?: Record<string, number>;
  header?: { investigator: string | null; siteName: string | null };
  /** ET procedures billed separately. */
  etInvoiceable?: boolean;
};

export function makeGrid(cfg: GridCfg, pi: string, site: string): BudgetGrid {
  const prov = (loc: string) => P(cfg.docId, cfg.page, loc);
  const procedures = PROCS.map((p) => {
    const unit = cfg.prices?.[p.code ?? p.name] ?? p.unit;
    const cells: Record<string, number | "invoiceable"> = {};
    for (const v of p.visits) cells[v] = v === "ET" && cfg.etInvoiceable && p.category === "procedure" ? "invoiceable" : unit;
    return {
      code: p.code,
      name: p.name,
      unitCents: unit,
      overheadApplied: p.category === "procedure",
      category: p.category,
      cells,
      prov: prov(`${cfg.label}, row '${p.name}'`),
    };
  });
  const visits = VISITS.map((v, i) => {
    let sub = 0;
    let non = 0;
    for (const p of procedures) {
      const c = p.cells[v.code];
      if (typeof c !== "number") continue;
      if (p.category === "procedure") sub += c;
      else non += c;
    }
    const overhead = Math.floor((sub * cfg.overheadPct + 50) / 100); // integer cents
    return {
      code: v.code,
      name: v.name,
      order: i + 1,
      procedureSubtotalCents: sub,
      overheadCents: overhead,
      nonProcedureCents: non,
      totalCents: sub + overhead + non,
      autopay: v.code !== "ET",
      prov: prov(`${cfg.label}, column ${v.code}`),
    };
  });
  const perPatient = visits.filter((v) => v.code !== "ET").reduce((a, v) => a + v.totalCents, 0);
  return {
    id: cfg.id,
    label: cfg.label,
    arm: cfg.arm,
    statedOverheadPct: cfg.statedPct ?? cfg.overheadPct,
    visits,
    procedures,
    perPatientTotals: [{ label: "Per completed patient", cents: perPatient, prov: prov(`${cfg.label}, total row`) }],
    header: cfg.header ?? { investigator: pi, siteName: site },
    prov: prov(cfg.label),
  };
}

export type StudyCfg = {
  sponsor: string;
  payingAgent: string | null;
  protocol: string;
  site: string;
  pi: string;
  effectiveDate: string;
  docs: Doc[];
  /** Where the terms live. */
  termsDoc: string;
  grids: GridCfg[];
  missingMaster?: { description: string; date: string };
  netDays?: number;
};

export function makeRulebook(c: StudyCfg): Rulebook {
  const d = c.termsDoc;
  const unverified = c.missingMaster ? { unverified: true } : {};
  return {
    schemaVersion: 1,
    study: {
      sponsor: s(c.sponsor, P(d, 1, "Cover page")),
      payingAgent: s(c.payingAgent, P(d, 1, "Cover page, 'Payment agent'")),
      protocol: s(c.protocol, P(d, 1, "Cover page, protocol number")),
      siteName: s(c.site, P(d, 1, "Cover page, site")),
      investigator: s(c.pi, P(d, 1, "Cover page, Principal Investigator")),
      effectiveDate: s(c.effectiveDate, P(d, 2, "§1 Effective date")),
      currency: "USD",
    },
    documents: c.docs,
    referencedDocuments: c.missingMaster
      ? [{ description: c.missingMaster.description, date: c.missingMaster.date, present: false, prov: P(d, 2, "§1 Recitals", { quote: `pursuant to the ${c.missingMaster.description}` }) }]
      : [],
    overhead: {
      pct: s(c.grids[0]?.statedPct ?? c.grids[0]?.overheadPct ?? null, P(d, 5, "Exhibit A §2 Overhead")),
      appliesTo: s("procedures_only" as const, P(d, 5, "Exhibit A §2 Overhead", { quote: "applied to procedure costs only" })),
    },
    payment: {
      visitPayment: s("auto_edc" as const, P(d, 4, "§4.1 Payment")),
      frequency: s("monthly" as const, P(d, 4, "§4.1 Payment")),
      netDays: s(c.netDays ?? 45, P(d, 4, "§4.2 Invoices", { quote: `within ${c.netDays ?? 45} days of receipt`, ...unverified })),
      netDaysFrom: s("receipt of itemized invoice", P(d, 4, "§4.2 Invoices", unverified)),
      invoiceAddress: s(`Accounts Payable, ${c.payingAgent ?? c.sponsor}, 400 Example Way, Suite 12`, P(d, 4, "§4.3 Invoice address")),
      requiredReferences: s(["protocol number", "PI name", "site number"], P(d, 4, "§4.3")),
      paymentConditions: s(["eCRFs complete", "all queries resolved"], P(d, 4, "§4.1", { quote: "upon completion of eCRFs and resolution of all queries" })),
    },
    budgetGrids: c.grids.map((g) => makeGrid(g, c.pi, c.site)),
    governingGridId: null,
    invoiceables: [
      inv("UNSCH", "Unscheduled visit", 57200, 80000, "fixed", "per occurrence", d, 10, true),
      inv("SAE", "SAE reporting", 25000, 35000, "fixed", "per SAE", d, 10, false),
      inv("LAB-KIT", "Central lab kit processing", 4500, 6300, "per_procedure", "per kit", d, 10, false),
      inv("SHIP", "Dry-ice shipment", null, null, "actual_cost", "per shipment", d, 10, false, ["courier receipt"]),
      inv("MILE", "Subject travel (mileage)", 67, null, "per_mile", "per mile", d, 11, false, ["mileage log"]),
    ],
    screenFail: {
      amountCents: 61000,
      basis: "fixed",
      cap: { kind: "ratio_to_randomized", n: null, ratio: 1 },
      paidVia: "invoice",
      requiredDocs: ["screening log", "detailed invoice"],
      prov: P(d, 6, "Exhibit A §5 Screen failures", { quote: "one (1) screen failure per one (1) randomized subject" }),
    },
    siteFees: [
      fee("SU01", "Study start-up fee", 1200000, "agreement_execution", 30, d, 7),
      fee("IRB", "IRB initial review", 350000, "actual_cost", null, d, 7),
      fee("ARCH", "Record archiving", 150000, "closeout", 45, d, 7),
      fee("ANN", "Annual maintenance", 200000, "annual", 30, d, 7),
    ],
    holdback: { pct: 5, appliesTo: "per-patient visit payments", releaseConditions: ["database lock", "all queries resolved"], prov: P(d, 7, "§4.5 Holdback", { quote: "five percent (5%) of each visit payment" }) },
    deadlines: [
      { kind: "invoice_days_from_expense", value: 90, consequence: "not payable", prov: P(d, 8, "§4.6", { quote: "within ninety (90) days" }) },
      { kind: "invoice_months_after_study_close", value: 6, consequence: "may not be approved", prov: P(d, 8, "§4.6") },
      { kind: "edc_entry_business_days", value: 5, consequence: "payment delayed", prov: P(d, 8, "§3.2") },
    ],
    overpayment: { refundDays: 30, sponsorMayOffset: true, prov: P(d, 8, "§4.8 Overpayment") },
    rounding: s("printed_amounts" as const, P(d, 5, "Exhibit A §1")),
    appliesFrom: s(null, { ...P(d, 2, "§1"), crossCheck: "not_checked" }),
  };
}

function inv(code: string | null, name: string, amount: number | null, withOh: number | null, basis: Invoiceable["basis"], frequency: string, doc: string, page: number, preApproval: boolean, docs = ["detailed invoice"]): Invoiceable {
  return { code, name, amountCents: amount, amountWithOverheadCents: withOh, basis, frequency, cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: preApproval, requiredDocs: docs, prov: P(doc, page, `Exhibit B, '${name}'`) };
}

function fee(code: string, name: string, amount: number | null, trigger: Rulebook["siteFees"][number]["trigger"], dueDays: number | null, doc: string, page: number) {
  return { code, name, amountCents: amount, trigger, dueDays, prov: P(doc, page, `Exhibit A §6, '${name}'`) };
}

export function anomaly(code: ContractAnomaly["code"], severity: ContractAnomaly["severity"], message: string, path: string | null, refs: ContractAnomaly["refs"], detail: Record<string, unknown> = {}): ContractAnomaly {
  return { id: `${code}:${path ?? ""}`, code, severity, message, path, refs, detail, resolution: null };
}

const at = (p: Provenance | null) => (p?.source ? [p.source] : []);

/** Amendment: raises spirometry/ECG, adds an invoiceable, shortens net days, retroactive with no date. */
export function amendRulebook(base: Rulebook, amendDoc: Doc): { rulebook: Rulebook; anomalies: ContractAnomaly[] } {
  const rb = structuredClone(base);
  rb.documents.push(amendDoc);
  rb.budgetGrids = rb.budgetGrids.map((g) => {
    const cfg: GridCfg = { id: g.id, label: g.label, arm: g.arm, docId: amendDoc.id, page: 3, overheadPct: g.statedOverheadPct ?? 0, prices: { "94010": 11200, "93000": 8400 }, header: g.header };
    return makeGrid(cfg, rb.study.investigator.value, rb.study.siteName.value);
  });
  rb.payment.netDays = s(30, P(amendDoc.id, 2, "Amendment 1 §2", { quote: "thirty (30) days" }));
  rb.invoiceables.push(inv("RMV", "Remote monitoring visit", 42000, 58800, "fixed", "per visit", amendDoc.id, 4, true));
  rb.appliesFrom = s(null, P(amendDoc.id, 1, "Amendment 1 §1", { quote: "shall apply retroactively", confidence: 0.9 }));
  const anomalies = [
    anomaly("RETROACTIVE_NO_DATE", "blocker", "Amendment says it applies retroactively but gives no start date.", "/appliesFrom/value", at(rb.appliesFrom.prov)),
    anomaly("AI_DISAGREEMENT", "warning", "Remote monitoring visit amount read differently by the two AI reads.", `/invoiceables/${rb.invoiceables.length - 1}/amountCents`, [{ documentId: amendDoc.id, page: 4, location: "Amendment 1, Exhibit B" }], { claude: 42000, openai: 48000 }),
  ];
  return { rulebook: rb, anomalies };
}

/** Blank rulebook for manual entry; every value tagged manual. */
export function blankRulebook(docs: Doc[], info: { sponsor: string; protocol: string; site: string; pi: string }): Rulebook {
  const m: Provenance = { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" };
  return {
    schemaVersion: 1,
    study: { sponsor: s(info.sponsor, m), payingAgent: s(null, m), protocol: s(info.protocol, m), siteName: s(info.site, m), investigator: s(info.pi, m), effectiveDate: s(null, m), currency: "USD" },
    documents: docs,
    referencedDocuments: [],
    overhead: { pct: s(null, m), appliesTo: s("unspecified" as const, m) },
    payment: { visitPayment: s("unspecified" as const, m), frequency: s("unspecified" as const, m), netDays: s(null, m), netDaysFrom: s(null, m), invoiceAddress: s(null, m), requiredReferences: s([], m), paymentConditions: s([], m) },
    budgetGrids: [],
    governingGridId: null,
    invoiceables: [],
    screenFail: null,
    siteFees: [],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: s("unspecified" as const, m),
    appliesFrom: s(null, m),
  };
}

export const PEOPLE = ["Avery Chen", "Jordan Patel", "Sam Rivera", "Taylor Brooks", "Morgan Lee"];

type Seed = { id: string; cfg: StudyCfg | null; files: Record<string, [filename: string, pageCount: number]> };

export const SEEDS: Record<"halcyon" | "northwind" | "cobalt" | "meridian" | "solace", Seed> = {
  halcyon: {
    id: "st-halcyon",
    cfg: {
      sponsor: "Halcyon Biotherapeutics",
      payingAgent: "Crestline CRO",
      protocol: "HAL-2207",
      site: "DCT Riverside",
      pi: "Dr. Mara Ellison",
      effectiveDate: "2025-03-14",
      termsDoc: "doc-hal-cta",
      docs: [{ id: "doc-hal-cta", kind: "work_order", title: "Clinical Trial Agreement HAL-2207", date: "2025-03-14" }],
      grids: [{ id: "g-hal-a", label: "Exhibit A – Budget", arm: null, docId: "doc-hal-cta", page: 9, overheadPct: 30, etInvoiceable: true }],
    },
    files: { "doc-hal-cta": ["HAL-2207_CTA_executed.pdf", 14], "doc-hal-am1": ["HAL-2207_Amendment-1.pdf", 6] },
  },
  northwind: {
    id: "st-northwind",
    cfg: {
      sponsor: "Northwind Pharma",
      payingAgent: null,
      protocol: "NWP-418-02",
      site: "DCT Lakeshore",
      pi: "Dr. Henry Okafor",
      effectiveDate: "2025-07-01",
      termsDoc: "doc-nw-wo",
      docs: [
        { id: "doc-nw-wo", kind: "work_order", title: "Work Order 3 – NWP-418-02", date: "2025-07-01" },
        { id: "doc-nw-bud", kind: "budget", title: "Attachment 2 – Payment Schedule", date: "2025-06-20" },
      ],
      missingMaster: { description: "Master Clinical Trial Agreement", date: "2024-03-12" },
      grids: [
        { id: "g-nw-a", label: "Exhibit A – Budget", arm: null, docId: "doc-nw-wo", page: 9, overheadPct: 25, statedPct: 35 },
        { id: "g-nw-b", label: "Attachment 2 – Payment Schedule", arm: null, docId: "doc-nw-bud", page: 2, overheadPct: 25, prices: { "94010": 10400, "93000": 8100, "99213": 13800, QOL: 4000 } },
      ],
    },
    files: { "doc-nw-wo": ["NWP-418-02_WorkOrder3.pdf", 12], "doc-nw-bud": ["NWP-418-02_Attachment2_budget.pdf", 4] },
  },
  cobalt: {
    id: "st-cobalt",
    cfg: {
      sponsor: "Cobalt Clinical Sciences",
      payingAgent: "Bluewater Payments",
      protocol: "CBL-0931",
      site: "DCT Northgate",
      pi: "Dr. Lena Ortiz",
      effectiveDate: "2025-09-02",
      termsDoc: "doc-cb-cta",
      docs: [{ id: "doc-cb-cta", kind: "master_agreement", title: "Clinical Trial Agreement CBL-0931", date: "2025-09-02" }],
      grids: [
        { id: "g-cb-a", label: "Exhibit A – Arm A", arm: "Arm A (De novo)", docId: "doc-cb-cta", page: 9, overheadPct: 28 },
        { id: "g-cb-b", label: "Exhibit A – Arm B", arm: "Arm B (Extension)", docId: "doc-cb-cta", page: 10, overheadPct: 28, header: { investigator: "Dr. Owen Pratt", siteName: "DCT Eastfield" }, prices: { "94010": 9200 } },
      ],
    },
    files: { "doc-cb-cta": ["CBL-0931_CTA.pdf", 16] },
  },
  meridian: {
    id: "st-meridian",
    cfg: {
      sponsor: "Meridian Therapeutics",
      payingAgent: null,
      protocol: "MTX-5510",
      site: "DCT Riverside",
      pi: "Dr. Mara Ellison",
      effectiveDate: "2024-11-18",
      termsDoc: "doc-mx-wo",
      docs: [
        { id: "doc-mx-msa", kind: "master_agreement", title: "Master Services Agreement", date: "2023-05-02" },
        { id: "doc-mx-wo", kind: "work_order", title: "Work Order 1 – MTX-5510", date: "2024-11-18" },
      ],
      grids: [{ id: "g-mx-a", label: "Exhibit A – Budget", arm: null, docId: "doc-mx-wo", page: 8, overheadPct: 20 }],
      netDays: 60,
    },
    files: { "doc-mx-msa": ["Meridian_MSA_2023.pdf", 22], "doc-mx-wo": ["MTX-5510_WO1.pdf", 11] },
  },
  solace: {
    id: "st-solace",
    cfg: null,
    files: { "doc-sl-wo": ["SLB-102_work-order_scan.pdf", 9] },
  },
};

export { at as refsOf };
