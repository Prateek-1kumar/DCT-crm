import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ContractAnomaly, Rulebook } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { Golden, scoreExtraction } from "../src/score";
import { makeRulebook, prov } from "./helpers";

/** Build the rulebook a perfect extraction would produce for a golden file. */
function rulebookFromGolden(g: Golden): Rulebook {
  const rb = makeRulebook();
  const st = rb.study;
  st.sponsor.value = g.study.sponsor ?? "x";
  st.protocol.value = g.study.protocol ?? "x";
  st.siteName.value = g.study.siteName ?? "x";
  st.investigator.value = g.study.investigator ?? "x";
  st.effectiveDate.value = g.study.effectiveDate;
  st.payingAgent.value = g.study.payingAgent ?? null;
  if (g.overheadPct !== undefined) rb.overhead.pct.value = g.overheadPct;
  if (g.netDays !== undefined) rb.payment.netDays.value = g.netDays;
  if (g.rounding) rb.rounding.value = g.rounding;
  if (g.appliesFrom !== undefined) rb.appliesFrom.value = g.appliesFrom;
  rb.holdback = g.holdbackPct == null ? null : { pct: g.holdbackPct, appliesTo: "visits", releaseConditions: [], prov };
  rb.deadlines = g.deadlines.map((d) => ({ kind: d.kind as Rulebook["deadlines"][number]["kind"], value: d.value, consequence: "", prov }));
  rb.overpayment = g.overpayment ? { ...g.overpayment, prov } : null;
  const sf = g.screenFail;
  rb.screenFail = sf ? { amountCents: sf.cents, basis: sf.basis ?? "fixed", cap: { kind: sf.capKind as "none", n: sf.n, ratio: sf.ratio }, paidVia: "invoice", requiredDocs: [], prov } : null;
  rb.invoiceables = g.items.map((it) => ({
    code: it.code,
    name: it.name,
    amountCents: it.cents,
    amountWithOverheadCents: it.withOverheadCents ?? null,
    basis: "fixed",
    frequency: "",
    cap: { kind: "none", n: null, ratio: null },
    requiresPreApproval: false,
    requiredDocs: [],
    prov,
  }));
  rb.siteFees = [];
  const template = rb.budgetGrids[0]!;
  rb.budgetGrids = g.grids.map((gg, gi) => ({
    ...structuredClone(template),
    id: `g${gi + 1}`,
    label: gg.label,
    visits: gg.visitTotals.map((t, i) => ({ code: `V${i + 1}`, name: `V${i + 1}`, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: t, autopay: true, prov })),
    perPatientTotals: gg.perPatient.map((cents) => ({ label: "Total", cents, prov })),
    procedures: [
      ...(gi === 0 ? g.procedures.map((p) => ({ code: p.code, name: p.name, unitCents: p.unitCents, overheadApplied: true, category: "procedure" as const, cells: {}, prov })) : []),
      ...(gg.rows ?? []).map((r) => ({
        code: r.code,
        name: r.name,
        unitCents: r.unitCents,
        overheadApplied: true,
        category: "procedure" as const,
        cells: Object.fromEntries(r.cells.flatMap((c, i) => (c === null ? [] : [[`V${i + 1}`, c]]))),
        prov,
      })),
    ],
  }));
  return Rulebook.parse(rb);
}
const anomaliesFor = (g: Golden) => g.expectedAnomalies.map((e) => ({ code: e.split("|")[0] as ContractAnomaly["code"] }));

const synthetic: Golden = Golden.parse({
  name: "synthetic",
  file: "synthetic.pdf",
  study: { sponsor: "Acme Bio", payingAgent: null, protocol: "ACM-100", siteName: "Test Site Research, LLC", investigator: "Jane Q. Doe, M.D.", effectiveDate: "2025-01-01" },
  overheadPct: 40,
  holdbackPct: 5,
  netDays: 45,
  rounding: "printed_amounts",
  grids: [
    {
      label: "Arm A",
      visitTotals: [84000, 56000, 56000],
      perPatient: [196000],
      rows: [
        { code: "99000", name: "Hematology handling", unitCents: 5500, cells: [5500, 5500, 5500] },
        { code: "99000", name: "PK handling", unitCents: 5500, cells: [null, 5500, null] },
      ],
    },
    { label: "Arm B", visitTotals: [70000], perPatient: [70000] },
  ],
  procedures: [{ code: "36415", name: "Blood draw", unitCents: 5500 }],
  items: [
    { code: "UNSCH", name: "Unscheduled visit", cents: 57200, withOverheadCents: 80000 },
    { code: null, name: "Mileage", cents: 60 },
  ],
  screenFail: { cents: 84000, capKind: "blocks_with_reauth", n: 7, ratio: null },
  deadlines: [{ kind: "invoice_days_from_expense", value: 60 }],
  overpayment: { refundDays: 30, sponsorMayOffset: true },
  expectedAnomalies: ["MISSING_REFERENCED_DOC", "AMBIGUOUS_TERM|REQUIRED_MISSING"],
});

describe("scoreExtraction", () => {
  it("golden vs golden scores 100%", () => {
    const s = scoreExtraction(rulebookFromGolden(synthetic), anomaliesFor(synthetic), synthetic);
    expect(s.misses).toEqual([]);
    expect(s.pct).toBe(100);
  });

  it("penalises wrong amounts and missing anomalies, field by field", () => {
    const rb = rulebookFromGolden(synthetic);
    rb.budgetGrids[0]!.visits[1]!.totalCents = 56100;
    rb.invoiceables[0]!.amountWithOverheadCents = 80100;
    rb.payment.netDays.value = 30;
    const s = scoreExtraction(rb, [{ code: "MISSING_REFERENCED_DOC" }], synthetic);
    expect(s.pct).toBeLessThan(100);
    expect(s.misses.map((m) => m.split(":")[0])).toEqual(["rules", "visit totals", "invoiceables & fees", "anomalies"]);
  });

  it("grid rows: duplicate codes paired by best match; a wrong or extra cell fails only its row", () => {
    const rb = rulebookFromGolden(synthetic);
    const [hema, pk] = rb.budgetGrids[0]!.procedures.filter((p) => p.code === "99000") as [Rulebook["budgetGrids"][0]["procedures"][0], Rulebook["budgetGrids"][0]["procedures"][0]];
    rb.budgetGrids[0]!.procedures.reverse(); // order of extracted rows doesn't matter
    pk.cells.V3 = 5500; // extra cell
    const s = scoreExtraction(rb, anomaliesFor(synthetic), synthetic);
    expect(s.categories.find((c) => c.name === "grid rows")).toEqual({ name: "grid rows", hit: 1, total: 2 });
    expect(s.misses).toEqual(["grid rows: Arm A: row 99000 PK handling: V3 empty→5500"]);
    expect(hema.cells).toEqual({ V1: 5500, V2: 5500, V3: 5500 });
  });

  it("real golden files (if present) score 100% against themselves", () => {
    const dir = process.env.DCT_ROOT ? join(process.env.DCT_ROOT, "data/golden") : null;
    let files: string[] = [];
    try {
      files = dir ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    } catch {
      files = [];
    }
    for (const f of files) {
      const g = Golden.parse(JSON.parse(readFileSync(join(dir!, f), "utf8")));
      expect(scoreExtraction(rulebookFromGolden(g), anomaliesFor(g), g).misses).toEqual([]);
    }
  });
});
