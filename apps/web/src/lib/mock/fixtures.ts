import type { BudgetGrid, DocumentKind, PageBox, Provenance, ReviewItem, Rulebook, RulebookVersionDto, ValueEvidence } from "@dct/shared";
import { ENUM_OPTIONS, fieldKey, formatValue, isMoneyPath, labelFor } from "../format";
import { findProv, getAt, segments, setAt } from "../pointer";
import { boxOn, layoutPage, numberPaths, type Span } from "./layout";

export { numberPaths };

/**
 * SYNTHETIC data only: invented sponsors, protocols, sites and people.
 * Shapes follow packages/shared exactly (checked by server.test.ts).
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
    governingGridIds: [],
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
    unclassified: [],
  };
}

function inv(code: string | null, name: string, amount: number | null, withOh: number | null, basis: Invoiceable["basis"], frequency: string, doc: string, page: number, preApproval: boolean, docs = ["detailed invoice"]): Invoiceable {
  return { code, name, amountCents: amount, amountWithOverheadCents: withOh, basis, frequency, cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: preApproval, requiredDocs: docs, prov: P(doc, page, `Exhibit B, '${name}'`) };
}

function fee(code: string, name: string, amount: number | null, trigger: Rulebook["siteFees"][number]["trigger"], dueDays: number | null, doc: string, page: number) {
  return { code, name, amountCents: amount, trigger, dueDays, prov: P(doc, page, `Exhibit A §6, '${name}'`) };
}

/** Amendment: raises spirometry/ECG, adds an invoiceable, shortens net days, retroactive with no date. */
export function amendRulebook(base: Rulebook, amendDoc: Doc): Rulebook {
  const rb = structuredClone(base);
  rb.documents.push(amendDoc);
  rb.budgetGrids = rb.budgetGrids.map((g) => {
    const cfg: GridCfg = { id: g.id, label: g.label, arm: g.arm, docId: amendDoc.id, page: 3, overheadPct: g.statedOverheadPct ?? 0, prices: { "94010": 11200, "93000": 8400 }, header: g.header };
    return makeGrid(cfg, rb.study.investigator.value, rb.study.siteName.value);
  });
  rb.payment.netDays = s(30, P(amendDoc.id, 2, "Amendment 1 §2", { quote: "thirty (30) days" }));
  rb.invoiceables.push(inv("RMV", "Remote monitoring visit", 42000, 58800, "fixed", "per visit", amendDoc.id, 4, true));
  rb.appliesFrom = s(null, P(amendDoc.id, 1, "Amendment 1 §1", { quote: "shall apply retroactively" }));
  return rb;
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
    files: { "doc-cb-cta": ["CBL-0931_CTA_signed-scan.pdf", 16] },
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


// ---------------------------------------------------------------- review questions and evidence

/** Kept by the mock "server", never sent: the right answer, what the page prints there, what each option changes. */
export type Secret = { truth?: unknown; lines: string[]; apply?: Record<string, { path: string; value: unknown }> };

/** A review question plus its secret. */
export type Spec = Pick<ReviewItem, "id" | "kind" | "reason" | "path" | "question" | "where" | "blocking"> & {
  input?: ReviewItem["input"];
  options?: ReviewItem["options"];
  term?: ReviewItem["term"];
  truth?: unknown;
  /** The tool's misreading, written into the master. */
  read?: unknown;
  /** What the page prints, one line per `where`. */
  lines: string[];
  apply?: Secret["apply"];
};

export type Draft = Pick<RulebookVersionDto, "review" | "evidence" | "pdfCheck"> & { rulebook: Rulebook; secrets: Record<string, Secret> };

export const pb = (documentId: string, page: number, box: PageBox["box"] = null): PageBox => ({ documentId, page, box });
/** Box for the n-th question on a page: full-width lines in the lower half, so they never overlap. */
export const box = (n: number): [number, number, number, number] => [0.07, 0.5 + (n % 7) * 0.06, 0.86, 0.042];

/** As the real API: a cap's limit is cents when its kind says it caps an amount; every other value's unit is in its name. */
const inputFor = (rb: Rulebook, path: string, value?: unknown): NonNullable<ReviewItem["input"]> =>
  typeof value === "string" || Array.isArray(value)
    ? /date|appliesFrom/i.test(fieldKey(path)) ? "date" : "text"
    : isMoneyPath(path) || segments(path).includes("cells") || (/\/cap\/n$/.test(path) && getAt(rb, path.replace(/n$/, "kind")) === "amount")
      ? "money"
      : /pct$/i.test(fieldKey(path)) ? "percent" : "number";

/** The DTO side of a question: explicit fields, so nothing secret can reach a response. */
export const toItem = (x: Spec): ReviewItem => ({
  id: x.id, kind: x.kind, reason: x.reason, path: x.path, question: x.question, input: x.input ?? null, options: x.options ?? [],
  where: x.where, blocking: x.blocking, answer: null, outcome: null, compare: null, sentBack: null, ...(x.term ? { term: x.term } : {}),
});
export const toSecret = (x: Spec): Secret => ({ truth: x.truth, lines: x.lines, apply: x.apply });

/**
 * A blind question about one value: "This looks wrong" (reason "reported") and the re-type sample of hand-typed values
 * (reason "spot_check"). Choices for yes/no and fixed-list values; otherwise an empty input. The right answer is the value we hold.
 */
export function askAbout(rb: Rulebook, evidence: ValueEvidence[], path: string, id: string, reason: string): Spec {
  const value = getAt(rb, path);
  const label = labelFor(path, rb);
  const list = typeof value === "string" ? ENUM_OPTIONS[fieldKey(path)] : undefined;
  const options =
    typeof value === "boolean" ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }] : list ? Object.entries(list).map(([k, l]) => ({ id: k, label: l })) : undefined;
  const input = options ? undefined : inputFor(rb, path, value);
  const src = evidence.find((e) => e.path === path)?.where[0] ?? findProv(rb, path)?.source;
  return {
    id, kind: "confirm_value", reason, path, blocking: true, input, options,
    question: `What ${input === "money" ? "amount" : input === "date" ? "date" : "value"} is printed for ${label}?`,
    where: src ? [pb(src.documentId, src.page)] : [],
    truth: value,
    lines: [`${label}: ${formatValue(path, value)}`],
    apply: options && Object.fromEntries(options.map((o) => [o.id, { path, value: typeof value === "boolean" ? o.id === "true" : o.id }])),
  };
}

/** Scan mode: a person types every number the contract's own totals don't confirm (everything outside the grids). */
function scanSpecs(rb: Rulebook, have: Spec[]): Spec[] {
  const taken = new Set(have.map((x) => x.path));
  return numberPaths(rb)
    .filter((p) => !p.startsWith("/budgetGrids/") && !taken.has(p))
    .map((path, i) => {
      const src = findProv(rb, path)?.source;
      const label = labelFor(path, rb);
      const value = getAt(rb, path);
      return {
        id: `scan-${i + 1}`, kind: "confirm_value", reason: "SCAN_VALUE", path, blocking: true, input: inputFor(rb, path, value),
        question: `Type what the contract prints for: ${label}`,
        where: src ? [pb(src.documentId, src.page)] : [], truth: value, lines: [`${label}: ${formatValue(path, value)}`],
      };
    });
}

/** Questions, evidence ledger and PDF check for a draft. Values outside the questions match the PDF (or, on a scan, the grid totals). */
export function buildDraft(base: Rulebook, specs: Spec[], opts: { scan?: boolean } = {}): Draft {
  let rb = structuredClone(base);
  for (const x of specs) if (x.path && x.read !== undefined) rb = setAt(rb, x.path, x.read);
  const all = opts.scan ? [...specs, ...scanSpecs(rb, specs)] : specs;
  const byPath = new Map(all.flatMap((x) => (x.path ? [[x.path, x] as const] : [])));
  // What each page prints, and where: the page shows the right answer where the reading got it wrong.
  const truthOf = (p: string) => (byPath.get(p)?.truth !== undefined ? byPath.get(p)!.truth : getAt(rb, p));
  const pages = new Map<string, Span[]>();
  const spansOf = (doc: string, page: number) => {
    const k = `${doc}#${page}`;
    if (!pages.has(k)) pages.set(k, layoutPage(rb, all, truthOf, doc, page));
    return pages.get(k)!;
  };
  // Questions point at the exact spot their number, or their own line, is printed.
  const placed = all.map((x) => ({ ...x, where: x.where.map((w) => pb(w.documentId, w.page, boxOn(spansOf(w.documentId, w.page), { path: x.path, item: x.id }) ?? w.box)) }));
  const evidence = numberPaths(rb).map((path): ValueEvidence => {
    const x = byPath.get(path);
    const src = findProv(rb, path)?.source;
    const status = x?.reason === "VALUE_CONFLICT" ? "conflict" : opts.scan && !path.startsWith("/budgetGrids/") ? "ungrounded" : "confirmed";
    return {
      path, status, note: null,
      where: src ? [pb(src.documentId, src.page, boxOn(spansOf(src.documentId, src.page), { path }))] : [],
      printed: opts.scan ? null : formatValue(path, truthOf(path)),
    };
  });
  return {
    rulebook: rb,
    evidence,
    review: placed.map(toItem),
    pdfCheck: opts.scan ? null : { values: evidence.length, matched: evidence.filter((e) => e.status === "confirmed").length },
    secrets: Object.fromEntries(all.map((x) => [x.id, toSecret(x)])),
  };
}

const OVERHEAD_OPTIONS = [
  { id: "procedures_only", label: "Procedures only" },
  { id: "procedures_and_staff", label: "Procedures and staff time" },
  { id: "all_per_patient_lines", label: "Every per-patient line, stipends too" },
];
const overheadScope = (id: string, doc: string, page: number, n: number): Spec => ({
  id, kind: "interpretation", reason: "OVERHEAD_SCOPE", path: "/overhead/appliesTo/value", blocking: true,
  question: "The budget says overhead is “applied to the costs above”. Which lines get overhead?",
  options: OVERHEAD_OPTIONS, where: [pb(doc, page, box(n))],
  lines: ["§2 Overhead. Institution overhead shall be applied to the costs above."],
  apply: Object.fromEntries(OVERHEAD_OPTIONS.map((o) => [o.id, { path: "/overhead/appliesTo/value", value: o.id }])),
});
/** As the real API's money-term questions (UNACCOUNTED_TERM): "bill by hand" lists the term on the master (ADR-001 §7). */
const UNACCOUNTED_OPTIONS = [
  { id: "bill_by_hand", label: "A payment term: list it to bill by hand" },
  { id: "not_payment", label: "Not a payment term" },
  { id: "covered", label: "Already covered by another line" },
];
const moneyTerm = (id: string, doc: string, page: number, n: number, line: string, amounts: number[]): Spec => ({
  id, kind: "unaccounted", reason: "UNACCOUNTED_TERM", path: null, blocking: true,
  question: `Page ${page} has ${amounts.length > 1 ? "amounts" : "an amount"} that the invoicing master doesn't have: "${line.replace(/[.;:,]$/, "")}". How should it be handled?`,
  options: UNACCOUNTED_OPTIONS, term: { quote: line, amounts }, where: [pb(doc, page, box(n))], lines: [line],
});
const pharmacyFee = (id: string, doc: string, page: number, n: number) =>
  moneyTerm(id, doc, page, n, "§6.4 Pharmacy. Sponsor shall pay a one-time pharmacy set-up fee of $1,500.00 upon site activation.", [150000]);
const parking = (id: string, doc: string, page: number, n: number) => moneyTerm(id, doc, page, n, "§7.2 Parking. Sponsor will reimburse parking at $12.00 per subject visit.", [1200]);
const cell = (id: string, reason: string, gi: number, pi: number, visit: string, label: string, cents: number, where: PageBox, read?: number): Spec => {
  const proc = PROCS[pi]!;
  const v = VISITS.find((x) => x.code === visit)!;
  return {
    id, kind: "confirm_value", reason, path: `/budgetGrids/${gi}/procedures/${pi}/cells/${visit}`, blocking: true, input: "money",
    question: `What amount does ${label} print for ${proc.name} at ${v.name === "Screening" ? "Screening" : `the ${v.name} visit`}?`,
    where: [where], truth: cents, read, lines: [`${proc.name}${proc.code ? ` (${proc.code})` : ""}  ·  ${v.name}  ·  ${formatValue("/cells/x", cents)}`],
  };
};

/** Northwind: a text PDF in "Needs you", 7 questions. */
export function northwindSpecs(): Spec[] {
  const wo = "doc-nw-wo";
  return [
    cell("q1", "VALUE_CONFLICT", 0, 3, "V2", "Exhibit A", 9800, pb(wo, 9, box(0)), 9300),
    {
      // a choice per arm, not a value: the server writes it into governingGridIds, as the real API
      id: "q2", kind: "contract_problem", reason: "GRID_CONFLICT", path: null, blocking: true,
      question: "Exhibit A and Attachment 2 both price every visit, and they disagree on 4 procedures. Which one should we bill from?",
      options: [
        { id: "g-nw-a", label: "Exhibit A – Budget (in the work order)" },
        { id: "g-nw-b", label: "Attachment 2 – Payment Schedule" },
      ],
      where: [pb(wo, 9, box(1)), pb("doc-nw-bud", 2, box(1))],
      lines: ["EXHIBIT A – BUDGET  ·  Spirometry $98.00  ·  ECG $76.00  ·  Physical exam $142.00", "ATTACHMENT 2 – PAYMENT SCHEDULE  ·  Spirometry $104.00  ·  ECG $81.00  ·  Physical exam $138.00"],
    },
    overheadScope("q3", wo, 5, 2),
    pharmacyFee("q4", wo, 7, 3),
    cell("q5", "spot_check", 0, 5, "SCR", "Exhibit A", 2500, pb(wo, 9, box(4))),
    {
      id: "q6", kind: "confirm_value", reason: "spot_check", path: "/screenFail/amountCents", blocking: true, input: "money",
      question: "How much does Exhibit A §5 pay for each screen failure?", where: [pb(wo, 6, box(5))], truth: 61000,
      lines: ["§5 Screen failures. Sponsor will pay $610.00 for each screen failure, up to one (1) per randomized subject."],
    },
    parking("q7", wo, 8, 6),
  ];
}

/** Cobalt: a scan. One contract problem and one misread; scan mode adds a question for every other number outside the grids. */
export function cobaltSpecs(): Spec[] {
  const doc = "doc-cb-cta";
  return [
    {
      id: "c1", kind: "contract_problem", reason: "HEADER_MISMATCH", path: "/budgetGrids/1/header", blocking: true,
      question: "The Arm B budget names Dr. Owen Pratt at DCT Eastfield, but this contract is with Dr. Lena Ortiz at DCT Northgate. Does Arm B belong to this contract?",
      options: [
        { id: "keep", label: "Yes, Arm B belongs to this contract" },
        { id: "remove", label: "No, it's from another site's contract" },
      ],
      where: [pb(doc, 10)], lines: ["EXHIBIT A – ARM B (Extension)  ·  Principal Investigator: Dr. Owen Pratt  ·  Site: DCT Eastfield"],
    },
    {
      id: "c2", kind: "confirm_value", reason: "SCAN_VALUE", path: "/payment/netDays/value", blocking: true, input: "number",
      question: "Type what the contract prints for: Payment › Net days", where: [pb(doc, 4)], read: 60, truth: 45,
      lines: ["§4.2 Invoices. Payment is due within forty-five (45) days of receipt of an itemized invoice."],
    },
  ];
}

/** A new contract read in the demo: 6 questions, 7 when the master agreement is missing. */
export function newContractSpecs(t: { doc: string; pages: number; gridPage: number; hasMaster: boolean }): Spec[] {
  const p = (n: number) => Math.min(n, t.pages);
  const out: Spec[] = [
    cell("n1", "VALUE_CONFLICT", 0, 3, "V3", "Exhibit A", 9800, pb(t.doc, t.gridPage, box(0)), 9300),
    overheadScope("n2", t.doc, p(5), 1),
    pharmacyFee("n3", t.doc, p(7), 2),
    cell("n4", "spot_check", 0, 5, "SCR", "Exhibit A", 2500, pb(t.doc, t.gridPage, box(3))),
    {
      id: "n5", kind: "confirm_value", reason: "spot_check", path: "/payment/netDays/value", blocking: true, input: "number",
      question: "How many days does the sponsor have to pay an invoice (§4.2)?", where: [pb(t.doc, p(4), box(4))], truth: 45,
      lines: ["§4.2 Invoices. Sponsor shall pay each undisputed invoice within 45 days of receipt."],
    },
  ];
  if (!t.hasMaster)
    out.push({
      id: "n6", kind: "contract_problem", reason: "MISSING_REFERENCED_DOC", path: "/referencedDocuments/0", blocking: false,
      question: "The work order refers to a Master Clinical Trial Agreement that wasn't uploaded, so terms that depend on it can't be checked. How should we go on?",
      options: [
        { id: "later", label: "Go ahead; I'll upload it later" },
        { id: "not_needed", label: "It doesn't affect billing", note: "Why doesn't it affect billing?" },
      ],
      where: [pb(t.doc, p(2), box(5))], lines: ["This Work Order is entered into pursuant to the Master Clinical Trial Agreement dated January 15, 2024."],
    });
  out.push(parking("n7", t.doc, p(8), 6));
  return out;
}

/**
 * An amendment: retroactive with no date, a misread new fee, a spot check, a hand-billed term, a total that doesn't add up
 * (`week52`: the Week 52 visit's total its lines add up to; the amendment prints it $5.00 lower).
 */
export function amendmentSpecs(doc: string, rmvIndex: number, week52: number): Spec[] {
  return [
    {
      id: "a1", kind: "contract_problem", reason: "RETROACTIVE_NO_DATE", path: "/appliesFrom/value", blocking: true, input: "date",
      question: "The amendment says its new prices apply retroactively, but gives no start date. From what date do they apply?",
      where: [pb(doc, 1, box(0))], lines: ["§1 The changes in this Amendment shall apply retroactively."],
    },
    {
      id: "a2", kind: "confirm_value", reason: "VALUE_CONFLICT", path: `/invoiceables/${rmvIndex}/amountCents`, blocking: true, input: "money",
      question: "What amount does the amendment print for a Remote monitoring visit?", where: [pb(doc, 4, box(1))], read: 48000, truth: 42000,
      lines: ["Remote monitoring visit (RMV)  ·  per visit  ·  $420.00"],
    },
    cell("a3", "spot_check", 0, 3, "V2", "the amended budget", 11200, pb(doc, 3, box(2))),
    moneyTerm("a4", doc, 5, 3, "§3.4 Courier. Sponsor will pay $95.00 for each courier pickup of stored samples.", [9500]),
    {
      // a Review question (ADR-001 §6): which number governs, with a note for the sponsor query; "sum" writes the sum
      id: "a5", kind: "contract_problem", reason: "VISIT_TOTAL_MISMATCH", path: "/budgetGrids/0/visits/5/totalCents", blocking: false,
      question: "In the amended budget, the Week 52 visit total is printed $5.00 lower than its lines add up to. Which should we bill?",
      options: [
        { id: "printed", label: "The visit total as printed", note: "What should we ask the sponsor?" },
        { id: "sum", label: "Its subtotal, overhead and non-procedure amounts added up", note: "What should we ask the sponsor?" },
      ],
      where: [pb(doc, 3, box(4))], read: week52 - 500, lines: ["Week 52  ·  Visit total (as printed)"],
    },
  ];
}

/** Questions answered before these versions were approved. */
export const halcyonV1Specs = (): Spec[] => [
  cell("h1", "spot_check", 0, 1, "SCR", "Exhibit A", 14200, pb("doc-hal-cta", 9, box(0))),
  {
    id: "h2", kind: "interpretation", reason: "AMBIGUOUS_TERM", path: null, blocking: true,
    question: "Early termination procedures are marked “as performed”. How do we bill them?",
    options: [
      { id: "invoiceable", label: "Separately, as invoiceable items" },
      { id: "visit", label: "As part of the Early termination visit" },
    ],
    where: [pb("doc-hal-cta", 10, box(1))], lines: ["Early termination: procedures will be paid as performed."],
  },
];
export const meridianSpecs = (): Spec[] => [
  cell("m1", "spot_check", 0, 5, "SCR", "Exhibit A", 2500, pb("doc-mx-wo", 8, box(0))),
  {
    id: "m2", kind: "confirm_value", reason: "spot_check", path: "/payment/netDays/value", blocking: true, input: "number",
    question: "How many days does the sponsor have to pay an invoice (§4.2)?", where: [pb("doc-mx-wo", 4, box(1))], truth: 60,
    lines: ["§4.2 Invoices. Sponsor shall pay each undisputed invoice within 60 days of receipt."],
  },
  overheadScope("m3", "doc-mx-wo", 5, 2),
];
