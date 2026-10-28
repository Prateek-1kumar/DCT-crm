import { RulebookVersionDto } from "@dct/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { keyTerms } from "./approve";
import { mockRequest, mockReset } from "./mock/server";

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
    expect((await mockRequest("POST", "/studies/st-halcyon/versions/2/send-back", { itemIds: answered, note: "again", by: "Morgan Lee" })).status).toBe(400);
  });
});
