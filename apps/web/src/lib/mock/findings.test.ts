import { AuditPage, type ReviewItem, RulebookVersionDto, SAMPLE, settled, withheldPaths } from "@dct/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { getAt } from "../pointer";
import { makeRulebook, mockSampling, SEEDS } from "./fixtures";
import { mockExport, mockRequest, mockReset } from "./server";

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

const patch = (path: string, body: unknown) => mockRequest("PATCH", path, body);
const log = async (study: string) => AuditPage.parse(await get(`/audit?studyId=${study}&limit=100`)).items;
/** Settles a question as server.test's `settle` does: the first option, or a value; a spot check typed again as Northwind has it. */
const settle = async (study: string, i: Pick<ReviewItem, "id" | "options" | "input">) => {
  const r = RulebookVersionDto.parse((await post(`/studies/${study}/versions/1/review/${encodeURIComponent(i.id)}`, { by: "Sam Rivera", ...(i.options.length && !i.input ? { optionId: i.options[0]!.id, note: "checked" } : { value: i.input === "date" ? "2026-01-01" : i.input === "text" ? "x" : 1, note: "checked" }) })).json);
  const it = r.review.find((x) => x.id === i.id)!;
  if (it.outcome === "differs" && !it.compare) await answer(study, i.id, { value: getAt(NW, it.path!) });
  else if (it.outcome === "differs") await answer(study, i.id, i.input ? { value: it.compare!.read, note: "checked" } : { optionId: String(it.compare!.read), note: "checked" });
};
/** Typing by hand on Solace, by Avery Chen: `values` in order (the pinned draw re-types the first 10), then marked done. */
const typed = async (values: [string, unknown][]) => {
  await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
  for (const [path, value] of values) expect((await patch("/studies/st-solace/versions/1/values", { path, value, note: "x", by: "Avery Chen" })).status, path).toBe(200);
  return RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
};

describe("the second review of 2026-10-29, by the API's rules", () => {
  it("C1, L4. two grids typed alike that an answer sets a cell apart: which to bill is asked", async () => {
    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const one = RulebookVersionDto.parse(await get("/studies/st-solace/versions/1")).rulebook!.budgetGrids[0]!;
    await patch("/studies/st-solace/versions/1/values", { path: "/budgetGrids", value: [one, { ...structuredClone(one), id: "g-hand-2", label: "Budget (revised)" }], note: "x", by: "Avery Chen" });
    for (const g of [0, 1]) await patch("/studies/st-solace/versions/1/values", { path: `/budgetGrids/${g}/procedures/0/cells/V1`, value: 5500, note: "x", by: "Avery Chen" });
    const v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.review.some((i) => i.reason === "GRID_CONFLICT")).toBe(false); // typed alike: one is billed
    const spot = "spot:/budgetGrids/1/procedures/0/cells/V1";
    await answer("st-solace", spot, { value: 6000 });
    const after = await answer("st-solace", spot, { value: 6000, note: "the revised budget prints 60.00" });
    expect(after).toMatchObject({ outcome: "chosen" });
    const asked = (await version("st-solace")).review.find((i) => i.reason === "GRID_CONFLICT");
    expect(asked).toMatchObject({ outcome: null, options: [{ id: "g-hand" }, { id: "g-hand-2" }] });
  });

  it("H1. the blind sample: “can't tell” after a differing answer doesn't reset it", async () => {
    const unit = (await version("st-northwind")).review.find((i) => i.reason === SAMPLE && i.path!.endsWith("/unitCents"))!;
    const price = getAt(NW, unit.path!) as number;
    await answer("st-northwind", unit.id, { value: price + 100 });
    expect(await answer("st-northwind", unit.id, { cantTell: true })).toMatchObject({ outcome: "cant_tell", retyped: true });
    expect(await answer("st-northwind", unit.id, { value: price + 200 })).toMatchObject({ outcome: "chosen", missed: true });
  });

  it("M1. a sampled value's evidence shows its page, not the spot the check bound it to", async () => {
    const v = await version("st-northwind");
    const sampled = v.review.filter((i) => i.reason === SAMPLE).map((i) => i.path!);
    expect(sampled.length).toBeGreaterThan(0);
    for (const p of sampled) expect(v.evidence.find((e) => e.path === p)!.where.every((w) => w.box === null), p).toBe(true);
  });

  it("M2. the amendment's own date is withheld while the start date is typed blind", async () => {
    const Q = "interpret:/appliesFrom/value";
    expect((await version("st-halcyon", 2)).rulebook!.documents.map((d) => d.date)).toContain("2026-09-30");
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: [Q], note: "Check §1", by: "Morgan Lee" });
    expect((await version("st-halcyon", 2)).rulebook!.documents.map((d) => d.date)).not.toContain("2026-09-30");
  });

  it("M3. the log blanks a typed amount in its fee's typed name while it's re-typed blind", async () => {
    const v = await typed([
      ["/siteFees", [{ code: null, name: "", amountCents: null, trigger: "one_time", dueDays: null, prov: { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } }]],
      ["/siteFees/0/amountCents", 25000], ["/payment/netDays/value", 30], ["/budgetGrids/0/visits/0/name", "Screening"], ["/budgetGrids/0/visits/0/totalCents", 5500],
      ["/budgetGrids/0/procedures/0/name", "Blood draw"], ["/budgetGrids/0/procedures/0/cells/V1", 5500], ["/budgetGrids/0/procedures/0/unitCents", 5500],
      ["/budgetGrids/0/visits/0/autopay", true], ["/budgetGrids/0/procedures/0/overheadApplied", false], ["/budgetGrids/0/procedures/0/category", "procedure"],
      ["/siteFees/0/name", "Archiving fee $250"],
    ]);
    expect(v.review.some((i) => i.id === "spot:/siteFees/0/amountCents" && !settled(i))).toBe(true);
    expect((await log("st-solace")).find((e) => e.action === "value.typed" && e.detail.path === "/siteFees/0/name")!.detail).toMatchObject({ value: "Site fee › Archiving fee ••• › Name", after: "Archiving fee •••" });
  });

  it("L2. a cap with no limit has no limit to report", async () => {
    expect((await version("st-northwind")).rulebook!.invoiceables[0]!.cap.kind).toBe("none");
    expect(await post("/studies/st-northwind/versions/1/report", { path: "/invoiceables/0/cap/n", note: "check", by: "Avery Chen" })).toMatchObject({
      status: 409,
      json: { message: "This cap has “No limit”, so there's no limit to report. If that's wrong, report the cap's kind instead." },
    });
  });

  it("L5. the export is built from what was approved, as the API's; a value typed again as it is logs nothing", async () => {
    // the editable study row says otherwise than the master the approver approved
    await patch("/studies/st-northwind", { sponsor: "Edited Sponsor", protocol: "EDITED-1", siteName: "Edited site", investigator: "Dr. Edited", by: "Avery Chen" });
    for (const i of (await version("st-northwind")).review) await settle("st-northwind", i);
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Morgan Lee", asOf: (await version("st-northwind")).updatedAt })).status).toBe(200);
    const { filename } = await mockExport("st-northwind", 1, "Morgan Lee");
    expect(filename).toBe(`${NW.study.protocol.value}-v1-invoicing-master.xlsx`);
    expect((await log("st-northwind")).filter((e) => e.action === "version.exported")).toHaveLength(1);

    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    for (let n = 0; n < 2; n++) await patch("/studies/st-solace/versions/1/values", { path: "/payment/netDays/value", value: 54, note: "x", by: "Avery Chen" });
    expect((await log("st-solace")).filter((e) => e.action === "value.typed")).toHaveLength(1);
  }, 30_000);
});
