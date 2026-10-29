import { AuditPage, RulebookVersionDto, SAMPLE, withheldPaths } from "@dct/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { getAt } from "../pointer";
import { makeRulebook, mockSampling, SEEDS } from "./fixtures";
import { mockRequest, mockReset } from "./server";

// The review findings of 2026-10-29 as the sample server shows them: it runs the API's own rules (@dct/shared), so each
// failed here before its fix too.

mockSampling.random = () => 1 - 2 ** -32;
const NW = makeRulebook(SEEDS.northwind.cfg!);
const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const version = async (study: string, v = 1) => RulebookVersionDto.parse(await get(`/studies/${study}/versions/${v}`));
const answer = async (study: string, item: string, body: Record<string, unknown>, v = 1) => {
  const res = await post(`/studies/${study}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam Rivera", ...body });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return RulebookVersionDto.parse(res.json).review.find((i) => i.id === item)!;
};
const typeByHand = async () => {
  await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
  const r = await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/payment/netDays/value", value: 54, note: "x", by: "Avery Chen" });
  expect(r.status).toBe(200);
};

beforeEach(() => mockReset());

describe("the sample server, by the API's rules", () => {
  it("1. 'as printed' after 'the sum' puts the printed total back", async () => {
    const TOTAL = "/budgetGrids/0/visits/5/totalCents";
    const printed = (await version("st-halcyon", 2)).rulebook!.budgetGrids[0]!.visits[5]!.totalCents; // answered "as printed" when seeded
    await answer("st-halcyon", "a5", { optionId: "sum", note: "Ask Crestline", by: "Taylor Brooks" }, 2);
    expect(getAt((await version("st-halcyon", 2)).rulebook, TOTAL)).toBe(printed + 500);
    await answer("st-halcyon", "a5", { optionId: "printed", note: "Crestline says the printed total governs", by: "Taylor Brooks" }, 2);
    expect(getAt((await version("st-halcyon", 2)).rulebook, TOTAL)).toBe(printed);
  });

  it("5. the blind sample: its page only, nothing shown when it differs, and the second answer stands", async () => {
    const v = await version("st-northwind");
    const unit = v.review.find((i) => i.reason === SAMPLE && i.path!.endsWith("/unitCents"))!;
    expect(unit.where.every((w) => w.box === null)).toBe(true);
    const price = getAt(NW, unit.path!) as number;
    expect(await answer("st-northwind", unit.id, { value: price + 100 })).toMatchObject({ outcome: "differs", compare: null });
    expect(await answer("st-northwind", unit.id, { value: price + 200 })).toMatchObject({ outcome: "chosen", missed: true });
  });

  it("6. 'prospective only' takes the amendment's own date typed", async () => {
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: ["interpret:/appliesFrom/value"], note: "Check §1", by: "Morgan Lee" });
    const res = await post(`/studies/st-halcyon/versions/2/review/${encodeURIComponent("interpret:/appliesFrom/value")}`, { optionId: "prospective", by: "Taylor Brooks" });
    expect(res).toMatchObject({ status: 400, json: { message: "Type the amendment's own date, as it's printed on the amendment." } });
  });

  it("14. “This looks wrong” on a contract typed by hand once typing is done, not before", async () => {
    await typeByHand();
    expect((await post("/studies/st-solace/versions/1/report", { path: "/payment/netDays/value", note: "typo", by: "Avery Chen" })).json).toMatchObject({
      statusCode: 409,
      message: "Typing isn't marked done yet: change the value in the form instead.",
    });
    await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" });
    await answer("st-solace", "spot:/payment/netDays/value", { value: 54 });
    const res = await post("/studies/st-solace/versions/1/report", { path: "/payment/netDays/value", note: "I typed 54; it's 45", by: "Avery Chen" });
    expect(res.status).toBe(200);
    expect(RulebookVersionDto.parse(res.json).review.at(-1)).toMatchObject({ id: expect.stringMatching(/^reported:/), reason: "reported", path: "/payment/netDays/value" });
  });

  it("16. marking typing done: re-typed by path, the checks run, its questions counted in the log", async () => {
    await typeByHand();
    const r = await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/budgetGrids/0/visits/0/totalCents", value: 15000, note: "x", by: "Avery Chen" });
    expect(r.status).toBe(200);
    await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/budgetGrids/0/visits/0/procedureSubtotalCents", value: 10000, note: "x", by: "Avery Chen" });
    await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/budgetGrids/0/visits/0/overheadCents", value: 4000, note: "x", by: "Avery Chen" });
    const v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.review.filter((i) => i.reason === "spot_check").map((i) => i.id).sort()).toEqual(["spot:/budgetGrids/0/visits/0/overheadCents", "spot:/budgetGrids/0/visits/0/procedureSubtotalCents", "spot:/budgetGrids/0/visits/0/totalCents", "spot:/payment/netDays/value"]);
    const log = AuditPage.parse(await get("/audit?studyId=st-solace&limit=100")).items.find((e) => e.action === "byhand.done")!;
    expect(log.detail).toEqual({ version: 1, typed: 4, "re-type": 4, questions: v.review.length - 4 });
  });

  it("16. the diff refuses as the API does", async () => {
    expect(await post("/studies/st-halcyon/versions/2/diff", {})).toMatchObject({ status: 404 }); // a GET route
    expect(await mockRequest("GET", "/studies/st-halcyon/versions/2/diff", undefined)).toMatchObject({ status: 400, json: { message: "Query parameter `against` (version number) is required" } });
    expect(await mockRequest("GET", "/studies/st-halcyon/versions/2/diff?against=x", undefined)).toMatchObject({ status: 400, json: { message: 'Invalid version "x"' } });
    expect(await mockRequest("GET", "/studies/st-halcyon/versions/2/diff?against=9", undefined)).toMatchObject({ status: 404, json: { message: "Version 9 of study st-halcyon not found" } });
  });

  it("12, 16. the log labels a value as the API does, and a question about it is worded as the API words it", async () => {
    const v = await version("st-northwind");
    const i = v.rulebook!.invoiceables.findIndex((_, n) => !withheldPaths(v).includes(`/invoiceables/${n}/amountCents`));
    const name = v.rulebook!.invoiceables[i]!.name;
    const res = await post("/studies/st-northwind/versions/1/report", { path: `/invoiceables/${i}/amountCents`, note: "check", by: "Avery Chen" });
    expect(res.status).toBe(200);
    const entry = AuditPage.parse(await get("/audit?studyId=st-northwind&limit=100")).items.find((e) => e.action === "number.reported")!;
    expect(entry.detail.value).toBe(`Invoiceable › ${name} › Amount`);
    expect(RulebookVersionDto.parse(res.json).review.at(-1)).toMatchObject({ id: `reported:${v.review.length + 1}`, question: `What amount is printed for Invoiceable › ${name} › Amount?` });
  });
});
