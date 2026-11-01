import { describe, expect, it } from "vitest";
import { confirmed, grid, rulebook } from "../test/fixtures";
import { keyTerms } from "./approve";

describe("key terms", () => {
  it("lists the terms that decide the money, each pointing at the contract", () => {
    const rb = rulebook();
    const terms = keyTerms(rb, confirmed(rb));
    expect(terms.map((t) => t.label)).toEqual(expect.arrayContaining(["Payment", "Holdback", "Overhead", "Screen failures", "Per patient", "Site fee", "Invoice deadline"]));
    expect(terms.filter((t) => t.label === "Site fee")).toHaveLength(3); // the biggest three of four
    expect(terms.find((t) => t.id === "payment")).toMatchObject({ value: "45 days", where: { page: 4 } });
  });

  it("states an absent term instead of leaving it out", () => {
    const rb = rulebook();
    expect(keyTerms({ ...rb, holdback: null }, confirmed(rb)).find((t) => t.id === "holdback")).toMatchObject({ value: "None", where: null });
  });

  it("an amendment's start date: the answer; prospective only says so", () => {
    const rb = rulebook();
    rb.documents.push({ id: "doc-2", kind: "amendment", title: "Amendment 1", date: "2026-09-30" });
    const at = (value: string | null) => keyTerms({ ...rb, appliesFrom: { ...rb.appliesFrom, value } }, []).find((t) => t.id === "applies-from");
    expect(at("2026-09-01")).toMatchObject({ value: "Sep 1, 2026", detail: "The date this version's prices start" });
    expect(at("2026-09-30")).toMatchObject({ value: "Sep 30, 2026", detail: "Prospective only: from the amendment's own date" });
    // an amendment never left without one
    expect(at(null)).toMatchObject({ value: "Not stated", detail: expect.stringMatching(/effective date/) });
  });

  it("each arm's chosen grid is billed: one per-patient total per arm", () => {
    const rb = rulebook();
    rb.budgetGrids = [grid("g-a", "Exhibit A – Arm A", "Arm A"), grid("g-b", "Exhibit A – Arm B", "Arm B", 100), grid("g-a2", "Arm A budget", "Arm A", 200)];
    rb.governingGridIds = ["g-a2"];
    expect(keyTerms(rb, []).filter((t) => t.label === "Per patient").map((t) => t.detail)).toEqual([expect.stringContaining("Exhibit A – Arm B"), expect.stringContaining("Arm A budget")]);
  });

  it("an arm whose grids differ with none chosen is said, never left out", () => {
    const rb = rulebook();
    rb.budgetGrids = [grid("g-a", "Exhibit A – Budget"), grid("g-b", "Attachment 2 – Payment Schedule", null, 100)];
    expect(keyTerms(rb, []).filter((t) => t.label === "Per patient")).toEqual([
      expect.objectContaining({ value: "No grid chosen", detail: "Exhibit A – Budget and Attachment 2 – Payment Schedule disagree, so nothing is billed until one is chosen" }),
    ]);
  });

  it("keeps the value's path when it's empty, so a value asked about isn't shown as missing", () => {
    const rb = rulebook();
    const terms = keyTerms({ ...rb, payment: { ...rb.payment, netDays: { ...rb.payment.netDays, value: null } } }, confirmed(rb));
    expect(terms.find((t) => t.id === "payment")).toMatchObject({ value: "Not stated", paths: ["/payment/netDays/value"] });
  });
});
