import { describe, expect, it } from "vitest";
import { rulebook, term, version } from "@/components/version/fixtures";
import { exportHead, exportName, gridRows, termRows, versionMark } from "./export";
import { bigGrid } from "./test-data";

const NOW = new Date(2026, 10, 10, 9, 30);

describe("what an export says about its version", () => {
  it("a draft warns on the first line and in the file name; an approved version does neither", () => {
    const draft = version({ number: 2, status: "draft" });
    expect(exportHead("EFC-1", draft, NOW)[0]).toEqual(["DRAFT: not approved yet. Do not bill from this file."]);
    expect(exportName("EFC-1", "budget grid", draft)).toBe("EFC-1 v2 budget grid DRAFT-not-approved");

    const live = version({ number: 3, status: "approved", approvedBy: "Cy", approvedAt: "2026-11-01T10:00:00Z" });
    expect(versionMark(live).warning).toBeNull();
    expect(exportHead("EFC-1", live, NOW).slice(0, 3)).toEqual([["Contract", "EFC-1"], ["Version", 3], ["Status", expect.stringMatching(/^Approved by Cy on /)]]);
    expect(exportName("EFC-1", "budget grid", live)).toBe("EFC-1 v3 budget grid");
    expect(exportName("EFC-1", "rulebook", version({ number: 1, status: "superseded" }))).toBe("EFC-1 v1 rulebook REPLACED");
  });
});

describe("termRows", () => {
  it("gives each term its amount as a number, its proof, who proofread it and where it is in the contract", () => {
    const t = term("a", { category: "site_fee", name: "Archiving", amountCents: 500000, unit: "once", billing: "auto_paid", evidence: "math", source: { doc: "CTA.pdf", page: 7, quote: "Archiving fee of $5,000" } });
    const [head, row] = termRows(version({ rulebook: rulebook({ terms: [t] }), proofreads: [{ item: "a", by: "Ana", at: "" }] }), [t]);
    const at = (name: string) => row![head!.indexOf(name)];
    expect(at("Amount (USD)")).toBe(5000);
    expect(at("Amount or rule")).toBe("$5,000.00 once");
    expect(at("Proof")).toBe("Totals add up");
    expect(at("Proofread by")).toBe("Ana");
    expect([at("Document"), at("Page"), at("Contract wording")]).toEqual(["CTA.pdf", 7, "Archiving fee of $5,000"]);
  });
});

describe("gridRows", () => {
  it("lists items by visit with the printed lines, and marks an item total as printed or calculated", () => {
    const grid = bigGrid();
    const rows = gridRows(version({ rulebook: rulebook({ grids: [grid] }) }), grid);
    const head = rows.find((r) => r[0] === "Item")!;
    expect(head).toEqual(["Item", "Code", "Unit cost (USD)", "Screening", "Week 4", "Item total (USD)", "Item total is"]);
    const ecg = rows.find((r) => r[0] === "ECG")!;
    expect(ecg.slice(3)).toEqual([98, null, 98, "Calculated"]);
    expect(rows.find((r) => r[1] === "80053")!.slice(3)).toEqual([1234567.89, "Invoice", 1234567.89, "Printed in the contract"]);
    expect(rows.find((r) => r[0] === "Total")!.slice(3)).toEqual([1580372.34, 0, 1580372.34, "Printed in the contract"]);
    // the grid prints its own totals, so no calculated visit totals are added
    expect(rows.some((r) => String(r[0]).startsWith("Calculated total"))).toBe(false);
    expect(rows[1]).toEqual(["Document", "Budget.pdf", "pages 3, 4"]);
  });

  it("adds calculated visit totals only when the contract prints none", () => {
    const grid = bigGrid({ subtotal: null, overhead: null, total: null, grandTotalCents: null });
    const rows = gridRows(version({ rulebook: rulebook({ grids: [grid] }) }), grid);
    expect(rows.at(-1)).toEqual(["Calculated total (not printed in the contract)", null, null, 1234665.89, null, null, "Calculated"]);
  });
});
