import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAnomalies, isNotice, notices, type Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { multiPatientTotals, patientCounts, runContractChecks, splitEstimates } from "../src/checks";
import { solveGrids } from "../src/solver";
import { gateSweep } from "../src/sweep";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook, prov } from "./helpers";

/**
 * A total for several patients printed beside a grid (an "estimated total for 50 patients" = 50 × the per-patient total) is
 * no per-patient total: it is taken out of perPatientTotals, shown as a notice, and never compared with the visits. Only an
 * exact multiple whose count the label (or, for the binder and the sweep, the page) states as patients is one.
 */

// makeRulebook's grid: visits 840.00 + 560.00 = 1,400.00 per patient
const PER_PATIENT = 140000;
const withTotals = (...totals: [string, number][]) => {
  const rb = makeRulebook();
  rb.budgetGrids[0]!.perPatientTotals = totals.map(([label, cents]) => ({ label, cents, prov }));
  return rb;
};
const codes = (rb: Rulebook) => runContractChecks(rb).map((a) => `${a.code} ${a.path}`);

describe("patientCounts", () => {
  it("reads a count of patients however a budget prints it, and nothing that is money or a rate", () => {
    const counts = (s: string) => [...patientCounts(s)];
    expect(counts("Estimated Total Per Patient Visit Cost (50 patients)")).toEqual([50]);
    expect(counts("Study total (N=50)")).toEqual([50]);
    expect(counts("Total, n = 1,200")).toEqual([1200]);
    expect(counts("Budget for 1,000 enrolled subjects")).toEqual([1000]);
    expect(counts("fifty (50) participants")).toEqual([50]);
    expect(counts("a 24-patient cohort")).toEqual([24]);
    expect(counts("Total for 12 pts")).toEqual([12]);
    for (const none of ["Total per patient", "$50 per patient", "50 per patient", "Total per patient (2 cycles)", "Visit 50 patient-reported outcome $50.00 patients", "N=50.5"]) expect(counts(none)).toEqual([]);
  });
});

describe("runContractChecks: a total for several patients", () => {
  it("is a notice, never a per-patient mismatch, and asks nothing", () => {
    const rb = withTotals(["Total per patient", PER_PATIENT], ["Estimated total per patient visit cost (50 patients)", 50 * PER_PATIENT]);
    const found = runContractChecks(rb);
    expect(found.map((a) => `${a.code} ${a.severity} ${a.path}`)).toEqual(["MULTI_PATIENT_ESTIMATE info /budgetGrids/0"]);
    expect(found[0]!.detail).toEqual({ label: "Estimated total per patient visit cost (50 patients)", cents: 7000000, patients: 50, perPatientCents: PER_PATIENT });
    expect(isNotice(found[0]!, rb)).toBe(true);
    expect(fromAnomalies(found, rb, new Set())).toEqual([]);
    expect(notices(found, rb).map((n) => n.message)).toEqual(['Exhibit A: "Estimated total per patient visit cost (50 patients)" ($70,000.00) is the total for 50 patients (50 × $1,400.00), not a per-patient total, so nothing is billed from it.']);
  });

  it("is told against another per-patient total too, and when it is the grid's only total", () => {
    // the visits aren't all read (their sum isn't the printed total), so only the printed per-patient total says it
    const rb = withTotals(["Total per patient", 150000], ["Total for 20 subjects", 20 * 150000]);
    expect(codes(rb)).toEqual(["MULTI_PATIENT_ESTIMATE /budgetGrids/0", "PER_PATIENT_TOTAL_MISMATCH /budgetGrids/0/perPatientTotals/0/cents"]);
    expect(codes(withTotals(["Study total (N=30)", 30 * PER_PATIENT]))).toEqual(["MULTI_PATIENT_ESTIMATE /budgetGrids/0"]);
  });

  it("a per-patient total that is a multiple of something stays one, and is checked as one", () => {
    const mismatch = ["PER_PATIENT_TOTAL_MISMATCH /budgetGrids/0/perPatientTotals/0/cents"];
    // twice the visits with no patient count in its label: a misread, or a total the visits don't make: asked
    expect(codes(withTotals(["Total per patient", 2 * PER_PATIENT]))).toEqual(mismatch);
    // a count of something else
    expect(codes(withTotals(["Total per patient (2 cycles)", 2 * PER_PATIENT]))).toEqual(mismatch);
    expect(codes(withTotals(["Total per patient ($2 per patient fee)", 2 * PER_PATIENT]))).toEqual(mismatch);
    // the count its label states isn't the multiple
    expect(codes(withTotals(["Estimated total (40 patients)", 50 * PER_PATIENT]))).toEqual(mismatch);
    // not an exact multiple (an estimate that adds anything is asked as a per-patient total, as before)
    expect(codes(withTotals(["Estimated total (50 patients)", 50 * PER_PATIENT + 100]))).toEqual(mismatch);
    // the label states a count, but the total is the visits' own: the per-patient total, nothing to say
    expect(codes(withTotals(["Total per patient, 50 patients planned", PER_PATIENT]))).toEqual([]);
    // two treatment periods: the total per patient is twice one period, and stays a per-patient total
    const rb = withTotals(["Period 1 per patient", PER_PATIENT / 2], ["Total per patient (2 periods)", PER_PATIENT]);
    expect(multiPatientTotals(rb.budgetGrids[0]!)).toEqual([]);
  });

  it("the read takes it out of perPatientTotals into a note, which the checks show", () => {
    const rb = withTotals(["Total per patient", PER_PATIENT], ["Estimated total (50 patients)", 50 * PER_PATIENT]);
    const { rulebook, notes } = splitEstimates(rb);
    expect(rulebook.budgetGrids[0]!.perPatientTotals.map((t) => t.label)).toEqual(["Total per patient"]);
    expect(rb.budgetGrids[0]!.perPatientTotals).toHaveLength(2); // the input is left as it was
    expect(notes).toEqual([{ kind: "estimate", topic: "Estimated total (50 patients)", path: "/budgetGrids/0", source: prov.source, estimate: { cents: 7000000, patients: 50, perPatientCents: PER_PATIENT } }]);
    expect(runContractChecks(rulebook, { notes }).map((a) => `${a.code} ${a.path}`)).toEqual(["MULTI_PATIENT_ESTIMATE /budgetGrids/0"]);
    expect(runContractChecks(rulebook).map((a) => a.code)).toEqual([]);
  });

  it("a saved read that still holds it puts it in no solver identity", () => {
    const rb = withTotals(["Total per patient", PER_PATIENT], ["Estimated total (50 patients)", 50 * PER_PATIENT]);
    const r = solveGrids(rb, [], { mode: "strict" });
    expect(r.report.identities.patientTotal).toEqual({ checked: 1, passed: 1, failed: 0 });
  });
});

// ---------- on the page: the binder and the sweep ----------

/** Text at (x, y from the top) on a letter page. */
const at = (x: number, y: number, s: string) => `BT /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`;
const GRID = [
  ["Code", "Procedure", "Unit", "V1", "V2"],
  ["99205", "Physical exam", "300.00", "300.00", "300.00"],
  ["36415", "Blood draw", "200.00", "200.00", ""],
  ["NP008", "Patient stipend", "100.00", "100.00", "100.00"],
  ["", "Procedure subtotal", "", "500.00", "300.00"],
  ["", "Overhead 40%", "", "240.00", "160.00"],
  ["", "Non-procedure subtotal", "", "100.00", "100.00"],
  ["", "Visit total", "", "840.00", "560.00"],
];
const COLS = [40, 90, 220, 280, 340];

/**
 * A budget page whose per-patient total prints on a long row, and whose estimate stands in its own ruled cell under a short
 * stacked label that fits the per-patient total's label better ("Total per patient" over the amount, its count below).
 */
async function budgetPage() {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const text = [
    at(40, 40, "The budget below assumes 50 patients are enrolled at the site over the course of the study."),
    at(40, 52, "This page continues the agreement between the parties and the site, as set out above in full detail."),
    ...GRID.flatMap((r, i) => r.map((s, c) => (s ? at(COLS[c]!, 80 + 14 * i, s) : ""))),
    at(90, 80 + 14 * GRID.length, "Total per patient, all scheduled visits of the study included"),
    at(400, 80 + 14 * GRID.length, "$1,400.00"),
    at(420, 400, "Estimated"),
    at(420, 410, "Total per patient"),
    at(420, 420, "$70,000.00"),
    at(420, 430, "(50 patients)"),
  ].join("");
  // a ruled table (PDF coordinates); the estimate sits in its top right cell: x 410-520, y from the top 390-440
  const [xs, ys] = [[300, 410, 520], [402, 352, 332]];
  const rules = `0.5 w\n${xs.map((x) => `${x} 332 m ${x} 402 l S`).join("\n")}\n${ys.map((y) => `300 ${y} m 520 ${y} l S`).join("\n")}\n`;
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, text + rules));
  const file = join(mkdtempSync(join(tmpdir(), "dct-estimate-")), "budget.pdf");
  writeFileSync(file, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(file, "d1");
}

/** makeRulebook's grid cited to page 1 of the budget page. */
function cited(...totals: [string, number][]) {
  const rb = withTotals(...totals);
  const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
  const g = rb.budgetGrids[0]!;
  g.prov = on;
  g.visits.forEach((v) => (v.prov = on));
  g.procedures = g.procedures.filter((p) => p.code !== "VA").map((p) => ({ ...p, prov: on }));
  g.perPatientTotals.forEach((t) => (t.prov = on));
  rb.invoiceables = [];
  rb.siteFees = [];
  rb.screenFail = null;
  return rb;
}

describe("bindEvidence and gateSweep: a total for several patients on the page", () => {
  it("the per-patient total binds to its own row, never to the estimate whose label fits better", async () => {
    const pages = await budgetPage();
    const status = (rb: Rulebook, path: string) => bindEvidence(rb, pages).evidence.find((e) => e.path === path)?.status;
    // a read since the fix (the estimate in a note) and a saved read (still in perPatientTotals) alike
    expect(status(cited(["Total per patient", PER_PATIENT]), "/budgetGrids/0/perPatientTotals/0/cents")).toBe("confirmed");
    expect(status(cited(["Total per patient", PER_PATIENT], ["Estimated total per patient (50 patients)", 50 * PER_PATIENT]), "/budgetGrids/0/perPatientTotals/0/cents")).toBe("confirmed");
  });

  it("the sweep doesn't ask about it: explained as the total for the patients the page states, and counted", async () => {
    const pages = await budgetPage();
    const rb = cited(["Total per patient", PER_PATIENT]);
    const bound = bindEvidence(rb, pages);
    const swept = gateSweep(bound.unaccounted, { evidence: bound.evidence, pages, rb, rows: bound.rows });
    expect(swept.kept.map((s) => s.text)).not.toContain("$70,000.00");
    expect(swept.report.explainedBy.patient_estimate).toBe(1);
    // a figure that isn't exactly the per-patient total times the patients the page states is still asked
    const other = cited(["Total per patient", PER_PATIENT + 100]);
    const b2 = bindEvidence(other, pages);
    expect(gateSweep(b2.unaccounted, { evidence: b2.evidence, pages, rb: other, rows: b2.rows }).report.explainedBy.patient_estimate).toBeUndefined();
  });
});
