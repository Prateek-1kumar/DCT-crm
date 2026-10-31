import { RulebookVersionDto } from "@dct/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { keyTerms } from "./approve";
import { mockSampling } from "./mock/fixtures";
import { mockRequest, mockReset } from "./mock/server";

// the blind sample pinned, as in server.test.ts: which values it withholds is the same every run
mockSampling.random = () => 1 - 2 ** -32;

const version = async (study: string, v = 1) => RulebookVersionDto.parse((await mockRequest("GET", `/studies/${study}/versions/${v}`, undefined)).json);

describe("key terms", () => {
  beforeEach(() => mockReset());

  it("lists the terms that decide the money, each pointing at the contract", async () => {
    const v = await version("st-meridian");
    const terms = keyTerms(v.rulebook!, v.evidence);
    expect(terms.map((t) => t.label)).toEqual(expect.arrayContaining(["Payment", "Holdback", "Overhead", "Screen failures", "Per patient", "Site fee", "Invoice deadline"]));
    expect(terms.filter((t) => t.label === "Site fee").length).toBeLessThanOrEqual(3);
    expect(terms.find((t) => t.id === "payment")).toMatchObject({ value: expect.stringMatching(/^\d+ days$/), where: { page: expect.any(Number) } });
  });

  it("states an absent term instead of leaving it out", async () => {
    const v = await version("st-meridian");
    const terms = keyTerms({ ...v.rulebook!, holdback: null }, v.evidence);
    expect(terms.find((t) => t.id === "holdback")).toMatchObject({ value: "None", where: null });
  });

  it("an amendment's start date: the answer; prospective only says so", async () => {
    const ha = await version("st-halcyon", 2);
    const at = (rb: typeof ha.rulebook) => keyTerms(rb!, ha.evidence).find((t) => t.id === "applies-from");
    expect(at(ha.rulebook)).toMatchObject({ value: "Sep 1, 2026", detail: "The date this version's prices start" }); // typed when seeded
    expect(at({ ...ha.rulebook!, appliesFrom: { ...ha.rulebook!.appliesFrom, value: "2026-09-30" } })).toMatchObject({ value: "Sep 30, 2026", detail: "Prospective only: from the amendment's own date" });
    // an amendment never left without one
    expect(at({ ...ha.rulebook!, appliesFrom: { ...ha.rulebook!.appliesFrom, value: null } })).toMatchObject({ value: "Not stated", detail: expect.stringMatching(/effective date/) });
  });

  it("each arm's chosen grid is billed: one per-patient total per arm", async () => {
    const v = await version("st-cobalt"); // Arm A and Arm B
    const rb = v.rulebook!;
    const twice = { ...rb, budgetGrids: [...rb.budgetGrids, { ...rb.budgetGrids[0]!, id: "g-cb-a2", label: "Arm A budget" }], governingGridIds: ["g-cb-a2"] };
    expect(keyTerms(twice, v.evidence).filter((t) => t.label === "Per patient").map((t) => t.detail)).toEqual([expect.stringContaining("Exhibit A – Arm B"), expect.stringContaining("Arm A budget")]);
  });

  it("an arm whose grids differ with none chosen is said, never left out", async () => {
    const nw = await version("st-northwind"); // its two grids differ, none chosen yet
    const terms = keyTerms(nw.rulebook!, nw.evidence);
    expect(terms.filter((t) => t.label === "Per patient")).toEqual([expect.objectContaining({ value: "No grid chosen", detail: "Exhibit A – Budget and Attachment 2 – Payment Schedule disagree, so nothing is billed until one is chosen" })]);
  });

  it("keeps the value's path when it's empty, so a withheld value isn't shown as missing", async () => {
    const v = await version("st-meridian");
    const rb = v.rulebook!;
    const terms = keyTerms({ ...rb, payment: { ...rb.payment, netDays: { ...rb.payment.netDays, value: null } } }, v.evidence);
    expect(terms.find((t) => t.id === "payment")).toMatchObject({ value: "Not stated", paths: ["/payment/netDays/value"] });
  });

  it("an approver can send answers back; they reopen blind with the note", async () => {
    const ha = await version("st-halcyon", 2);
    const answered = ha.review.filter((i) => i.outcome !== null).slice(0, 2).map((i) => i.id);
    const res = await mockRequest("POST", "/studies/st-halcyon/versions/2/send-back", { itemIds: answered, note: "Check the amendment page again", by: "Morgan Lee" });
    const after = RulebookVersionDto.parse(res.json);
    for (const id of answered) expect(after.review.find((i) => i.id === id)).toMatchObject({ outcome: null, answer: null, sentBack: { by: "Morgan Lee", note: "Check the amendment page again" } });
    expect((await mockRequest("POST", "/studies/st-halcyon/versions/2/send-back", { itemIds: answered, note: "again", by: "Morgan Lee" })).status).toBe(409);
  });
});
