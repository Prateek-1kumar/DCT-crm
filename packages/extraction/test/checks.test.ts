import { ContractAnomaly } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { compareRulebooks, runContractChecks, sameName } from "../src/checks";
import { makeRulebook, prov } from "./helpers";

const codes = (rb = makeRulebook(), opts = {}) => runContractChecks(rb, opts).map((a) => a.code);

describe("runContractChecks", () => {
  it("clean rulebook has no anomalies, and anomalies match the shared schema", () => {
    expect(runContractChecks(makeRulebook())).toEqual([]);
    const rb = makeRulebook();
    rb.referencedDocuments.push({ description: "Master CTA", date: "2024-04-26", present: false, prov });
    for (const a of runContractChecks(rb)) expect(ContractAnomaly.parse(a)).toEqual(a);
  });

  it("VISIT_TOTAL_MISMATCH: components, with ±$1 tolerance only when the contract rounds", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 84100; // off by $1
    expect(codes(rb)).not.toContain("VISIT_TOTAL_MISMATCH");
    rb.rounding.value = "cents";
    const a = runContractChecks(rb).filter((x) => x.code === "VISIT_TOTAL_MISMATCH");
    expect(a.map((x) => x.path)).toContain("/budgetGrids/0/visits/0/totalCents");
    expect(a[0]!.detail).toEqual({ expected: 84000, actual: 84100 });
  });

  it("staff fees counted in the procedure subtotal are not a mismatch (Shah)", () => {
    const rb = makeRulebook();
    // contract prints 600 procedure / 0 non-procedure, but the model labels the stipend non_procedure
    const v1 = rb.budgetGrids[0]!.visits[0]!;
    v1.procedureSubtotalCents = 60000;
    v1.nonProcedureCents = 0;
    v1.overheadCents = 24000;
    expect(codes(rb)).not.toContain("VISIT_TOTAL_MISMATCH");
  });

  it("per-patient row that totals a column (overhead, stipend…) is not a mismatch", () => {
    const rb = makeRulebook();
    const g = rb.budgetGrids[0]!;
    const ohColumn = g.visits.reduce((n, v) => n + (v.overheadCents ?? 0), 0);
    g.perPatientTotals.push({ label: "Overhead at 40%", cents: ohColumn, prov }, { label: "Patient stipend", cents: 20000, prov });
    expect(codes(rb)).not.toContain("PER_PATIENT_TOTAL_MISMATCH");
    g.perPatientTotals.push({ label: "Bogus", cents: 12345, prov });
    expect(codes(rb)).toContain("PER_PATIENT_TOTAL_MISMATCH");
  });

  it("DUPLICATE_ITEM skips a procedure the grid itself marks invoiceable at some visits", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.procedures[2]!.cells.V1 = 5500; // visual acuity priced at V1, "invoiceable" at V2
    rb.invoiceables.push({ code: "VA", name: "Visual acuity", amountCents: 5500, amountWithOverheadCents: null, basis: "fixed", frequency: "each", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov });
    expect(codes(rb)).not.toContain("DUPLICATE_ITEM");
  });

  it("VISIT_TOTAL_MISMATCH: subtotal ≠ sum of grid cells", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.procedures[1]!.cells.V1 = 25000;
    const a = runContractChecks(rb).find((x) => x.code === "VISIT_TOTAL_MISMATCH")!;
    expect(a.path).toBe("/budgetGrids/0/visits/0/procedureSubtotalCents");
    expect(a.detail).toEqual({ expected: 65000, actual: 60000 }); // procedure + non-procedure, compared as one sum
  });

  it("PER_PATIENT_TOTAL_MISMATCH, but allows totals that skip a block of visits", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.perPatientTotals[0]!.cents = 150000;
    expect(codes(rb)).toContain("PER_PATIENT_TOTAL_MISMATCH");
    rb.budgetGrids[0]!.perPatientTotals[0]!.cents = 84000; // screening only (skips V2)
    expect(codes(rb)).not.toContain("PER_PATIENT_TOTAL_MISMATCH");
  });

  it("OVERHEAD_LABEL_MISMATCH: stated 35% but amounts compute 25%", () => {
    const rb = makeRulebook();
    const g = rb.budgetGrids[0]!;
    g.statedOverheadPct = 35;
    g.visits = [{ ...g.visits[0]!, procedureSubtotalCents: 78000, overheadCents: 19500, nonProcedureCents: null, totalCents: 97500 }];
    g.procedures = [];
    g.perPatientTotals = [];
    const a = runContractChecks(rb).filter((x) => x.code === "OVERHEAD_LABEL_MISMATCH");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toEqual({ stated: 35, computed: 25 });
    g.statedOverheadPct = 25;
    expect(codes(rb)).not.toContain("OVERHEAD_LABEL_MISMATCH");
  });

  it("GRID_CONFLICT: two grids for one arm with different totals, cleared by governingGridId", () => {
    const rb = makeRulebook();
    const b = structuredClone(rb.budgetGrids[0]!);
    b.id = "g2";
    b.label = "Detailed budget";
    b.visits[0]!.totalCents = 90000;
    b.visits[0]!.overheadCents = 30000;
    rb.budgetGrids.push(b);
    const a = runContractChecks(rb).filter((x) => x.code === "GRID_CONFLICT");
    expect(a).toHaveLength(1);
    expect(a[0]!.severity).toBe("blocker");
    expect(a[0]!.detail.gridIds).toEqual(["g1", "g2"]);
    rb.governingGridId = "g2";
    expect(codes(rb)).not.toContain("GRID_CONFLICT");
  });

  it("GRID_CONFLICT: different arms are not a conflict", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.arm = "Arm A";
    const b = structuredClone(rb.budgetGrids[0]!);
    b.id = "g2";
    b.arm = "Arm B";
    b.visits[0]!.totalCents = 99900;
    rb.budgetGrids.push(b);
    expect(codes(rb)).not.toContain("GRID_CONFLICT");
  });

  it("DUPLICATE_ITEM: priced in a visit and also invoiceable (not when the cell says invoiceable)", () => {
    const rb = makeRulebook();
    expect(codes(rb)).not.toContain("DUPLICATE_ITEM"); // Visual acuity cell is "invoiceable"
    rb.invoiceables.push({ ...rb.invoiceables[0]!, code: null, name: "Central lab blood draw", amountCents: 20000 });
    const a = runContractChecks(rb).filter((x) => x.code === "DUPLICATE_ITEM");
    expect(a).toHaveLength(1);
    expect(a[0]!.path).toBe("/budgetGrids/0/procedures/1");
    expect(a[0]!.detail).toEqual({ invoiceablePath: "/invoiceables/1", visits: ["V1"] });
  });

  it("MISSING_REFERENCED_DOC", () => {
    const rb = makeRulebook();
    rb.referencedDocuments.push({ description: "Master CTA", date: "2024-04-26", present: false, prov });
    rb.referencedDocuments.push({ description: "Budget", date: null, present: true, prov });
    const a = runContractChecks(rb).filter((x) => x.code === "MISSING_REFERENCED_DOC");
    expect(a.map((x) => x.path)).toEqual(["/referencedDocuments/0"]);
  });

  it("HEADER_MISMATCH: grid header PI/site differ from the study", () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.header = { investigator: "Brian Other, MD", siteName: "Other Clinic - Stone Oak" };
    expect(runContractChecks(rb).filter((x) => x.code === "HEADER_MISMATCH").map((x) => x.path)).toEqual([
      "/budgetGrids/0/header/investigator",
      "/budgetGrids/0/header/siteName",
    ]);
  });

  it("sameName tolerates titles, initials and the DCT abbreviation", () => {
    expect(sameName("Pankajkumar G. Shah, M.D.", "Pankajkumar Shah")).toBe(true);
    expect(sameName("DCT-McAllen", "DCT-McAllen Primary Care Research, LLC")).toBe(true);
    expect(sameName("Discovery Clinical Trials - Stone Oak Parkway", "DCT-HCWC, LLC")).toBe(false);
    expect(sameName("Brian MacGillivray, MD", "Stephanie Slocum, MD")).toBe(false);
  });

  it("AI_DISAGREEMENT: field-by-field, one per missing item", () => {
    const rb = makeRulebook();
    const cross = structuredClone(rb);
    expect(codes(rb, { crossRead: cross })).toEqual([]);
    cross.budgetGrids[0]!.visits[1]!.totalCents = 56100;
    cross.payment.netDays.value = 30;
    cross.invoiceables = [];
    const a = runContractChecks(rb, { crossRead: cross }).filter((x) => x.code === "AI_DISAGREEMENT");
    // an invoiceable the cross-read merely skipped is not flagged (says nothing about a primary misread)
    expect(a.map((x) => x.path).sort()).toEqual(["/budgetGrids/0/visits/1/totalCents", "/payment/netDays/value"]);
    expect(a.find((x) => x.path === "/payment/netDays/value")!.detail).toEqual({ claude: 45, openai: 30 });
    expect(compareRulebooks(rb, cross).filter((c) => !c.agree)).toHaveLength(3);
    // ...but one only the cross-read found is (possible omission by the primary)
    const only = runContractChecks({ ...rb, invoiceables: [] }, { crossRead: rb }).filter((x) => x.code === "AI_DISAGREEMENT");
    expect(only.map((x) => x.path)).toEqual(["/invoiceables"]);
  });

  it("LOW_CONFIDENCE below 0.8, pointing at the value", () => {
    const rb = makeRulebook();
    rb.payment.netDays.prov = { ...prov, confidence: 0.6 };
    rb.siteFees[0]!.prov = { ...prov, confidence: 0.5, method: "manual" }; // manual is not flagged
    expect(runContractChecks(rb).filter((x) => x.code === "LOW_CONFIDENCE").map((x) => x.path)).toEqual(["/payment/netDays/value"]);
  });

  it("REQUIRED_MISSING: amounts and study fields", () => {
    const rb = makeRulebook();
    rb.invoiceables.push({ ...rb.invoiceables[0]!, name: "Hotel", amountCents: null, amountWithOverheadCents: null, basis: "fixed" });
    rb.invoiceables.push({ ...rb.invoiceables[0]!, name: "IRB", amountCents: null, amountWithOverheadCents: null, basis: "actual_cost" });
    rb.study.protocol.value = "";
    expect(runContractChecks(rb).filter((x) => x.code === "REQUIRED_MISSING").map((x) => x.path)).toEqual(["/study/protocol/value", "/invoiceables/1/amountCents"]);
  });

  it("RETROACTIVE_NO_DATE from the appliesFrom quote or a note", () => {
    const rb = makeRulebook();
    rb.appliesFrom.prov = { ...prov, source: { documentId: "d1", page: 1, quote: "shall apply retroactively" } };
    expect(codes(rb)).toContain("RETROACTIVE_NO_DATE");
    rb.appliesFrom.value = "2024-01-01";
    expect(codes(rb)).not.toContain("RETROACTIVE_NO_DATE");
    const rb2 = makeRulebook();
    expect(codes(rb2, { notes: [{ kind: "retroactive_no_date", topic: "retroactive", path: "/appliesFrom", source: null }] })).toContain("RETROACTIVE_NO_DATE");
  });

  it("UNREADABLE_PAGE from page info", () => {
    const a = runContractChecks(makeRulebook(), { pages: [{ documentId: "d1", page: 4, kind: "budget_grid", readable: false }, { documentId: "d1", page: 5, kind: "terms", readable: true }] });
    expect(a.map((x) => x.code)).toEqual(["UNREADABLE_PAGE"]);
    expect(a[0]!.refs).toEqual([{ documentId: "d1", page: 4 }]);
  });

  it("AMBIGUOUS_TERM from unspecified overhead scope or a note", () => {
    const rb = makeRulebook();
    rb.overhead.appliesTo.value = "unspecified";
    expect(codes(rb)).toEqual(["AMBIGUOUS_TERM"]);
    expect(codes(makeRulebook(), { notes: [{ kind: "ambiguous", topic: "overhead on stipends", path: "/overhead", source: { documentId: "d1", page: 2 } }] })).toEqual(["AMBIGUOUS_TERM"]);
  });

  it("ids are stable and unique", () => {
    const rb = makeRulebook();
    rb.referencedDocuments.push({ description: "Master", date: null, present: false, prov });
    const a = runContractChecks(rb);
    const b = runContractChecks(rb);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a[0]!.id).toBe("MISSING_REFERENCED_DOC:/referencedDocuments/0");
  });
  it("compareRulebooks pairs items whose names differ in wording, and per-patient totals by label", () => {
    const a = makeRulebook();
    const b = makeRulebook();
    a.siteFees.push({ code: null, name: "Administrative startup (non-refundable)", amountCents: 850000, trigger: "one_time", dueDays: null, prov });
    b.siteFees.push({ code: null, name: "Administrative startup", amountCents: 850000, trigger: "one_time", dueDays: null, prov });
    b.budgetGrids[0]!.perPatientTotals = [...b.budgetGrids[0]!.perPatientTotals].reverse();
    expect(compareRulebooks(a, b).filter((d) => !d.agree)).toEqual([]);
    b.siteFees.at(-1)!.amountCents = 800000;
    expect(compareRulebooks(a, b).filter((d) => !d.agree).map((d) => d.label)).toEqual(['site fee "Administrative startup (non-refundable)" amount']);
  });
  it("cross-read visits pair by name (numbers must agree), then by position", () => {
    const rb = makeRulebook();
    const cross = structuredClone(rb);
    const [v1, v2] = cross.budgetGrids[0]!.visits;
    // other model's codes, and columns listed in the other order
    cross.budgetGrids[0]!.visits = [{ ...v2!, code: "Week 2", order: 1 }, { ...v1!, code: "Screening", order: 2 }];
    for (const p of cross.budgetGrids[0]!.procedures) p.cells = Object.fromEntries(Object.entries(p.cells).map(([k, v]) => [k === "V1" ? "Screening" : "Week 2", v]));
    rb.budgetGrids[0]!.visits[0]!.name = "Screening";
    rb.budgetGrids[0]!.visits[1]!.name = "Week 2";
    expect(compareRulebooks(rb, cross).filter((c) => !c.agree)).toEqual([]);
  });
});
