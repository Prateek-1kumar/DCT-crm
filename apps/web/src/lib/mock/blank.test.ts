import { beforeEach, describe, expect, it } from "vitest";
import { AuditPage, BLANK_INVOICEABLE, RulebookVersionDto, withheldPaths } from "@dct/shared";
import { getAt } from "../pointer";
import { mockSampling } from "./fixtures";
import { mockRequest, mockReset } from "./server";

// The blank check in the sample server (Cobalt: its second grid's "invoiceable" cells print nothing): answered by the
// same shared rules as the API's (answerQuestion, followUps), and blind the same way.

mockSampling.random = () => 1 - 2 ** -32;
const url = "/studies/st-cobalt/versions/1";
const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const version = async () => RulebookVersionDto.parse(await get(url));
const group = async () => (await version()).review.find((i) => i.reason === BLANK_INVOICEABLE)!;
const pick = (id: string, body: object, by = "Sam Rivera") => post(`${url}/review/${encodeURIComponent(id)}`, { by, ...body });
const actions = async () => AuditPage.parse(await get("/audit?limit=100")).items.map((e) => e.action);

describe("mock API blank check", () => {
  beforeEach(() => mockReset());

  it("asks one blind pick with the table's and rows' boxes, and withholds its cells: null in the master, no printed text", async () => {
    const q = await group();
    expect(q).toMatchObject({ path: null, blocking: true, outcome: null, input: null });
    expect(q.options.map((o) => o.id)).toEqual(["printed_only", "every_visit"]);
    expect(q.where.length).toBeGreaterThan(2);
    expect(q.where.every((w) => w.box)).toBe(true);
    const v = await version();
    const cells = v.evidence.filter((e) => e.blank);
    expect(cells.length).toBeGreaterThan(0);
    for (const e of cells) {
      expect(getAt(v.rulebook, e.path), e.path).toBeNull();
      expect(e).toMatchObject({ printed: null, status: "ungrounded" });
    }
    expect(withheldPaths(v)).toEqual(expect.arrayContaining(cells.map((e) => e.path)));
    expect(JSON.stringify(await get(url))).not.toContain('"invoiceable"');
    // approval waits for it
    expect((await post(`${url}/sign-off`, { by: "Taylor Brooks", asOf: v.updatedAt })).status).toBe(409);
  });

  it("only a listed pick settles it, never a typed value or a note", async () => {
    const q = await group();
    for (const body of [{}, { value: "x" }, { optionId: "nope" }, { optionId: "every_visit", note: "all" }]) expect((await pick(q.id, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("“Only where the contract prints a price” removes the cells and logs it; the answer is final", async () => {
    const q = await group();
    const cells = (await version()).evidence.filter((e) => e.blank).map((e) => e.path);
    expect((await pick(q.id, { optionId: "printed_only" })).status).toBe(200);
    const v = await version();
    for (const p of cells) expect(getAt(v.rulebook, p), p).toBeUndefined();
    expect(v.evidence.some((e) => e.blank || cells.includes(e.path))).toBe(false);
    expect(v.review.find((i) => i.id === q.id)).toMatchObject({ outcome: "chosen" });
    expect(await actions()).toContain("review.blank_removed");
    expect((await pick(q.id, { optionId: "every_visit" }, "Taylor Brooks")).status).toBe(409);
  });

  it("“At every scheduled visit shown” keeps the cells, attested; “can't tell” asks each one blind", async () => {
    const q = await group();
    const cells = (await version()).evidence.filter((e) => e.blank).map((e) => e.path);
    expect((await pick(q.id, { optionId: "every_visit" })).status).toBe(200);
    const v = await version();
    for (const p of cells) {
      expect(getAt(v.rulebook, p), p).toBe("invoiceable");
      expect(v.evidence.find((e) => e.path === p)).toMatchObject({ status: "attested" });
    }
    mockReset();
    expect((await pick((await group()).id, { cantTell: true })).status).toBe(200);
    const w = await version();
    expect(w.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(w.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(await actions()).toContain("review.blank_rejected");
    // the send-back refuses a settled group, as a table pick
    mockReset();
    const g = await group();
    await pick(g.id, { optionId: "printed_only" });
    expect((await post(`${url}/send-back`, { itemIds: [g.id], note: "again", by: "Taylor Brooks" })).status).toBe(409);
  });
});
