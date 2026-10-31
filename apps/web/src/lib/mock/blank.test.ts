import { beforeEach, describe, expect, it } from "vitest";
import { AuditPage, BLANK_INVOICEABLE, RulebookVersionDto, withheldPaths } from "@dct/shared";
import { getAt } from "../pointer";
import { mockSampling } from "./fixtures";
import { mockRequest, mockReset } from "./server";

// The blank check in the sample server (Cobalt: a second grid's "invoiceable" cells print nothing, on a table whose
// columns are held): answered by the same shared rules as the API's (answerQuestion, followUps), and blind the same way.
// It waits for its table's column questions (the table check).

mockSampling.random = () => 1 - 2 ** -32;
const url = "/studies/st-cobalt/versions/1";
const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const version = async () => RulebookVersionDto.parse(await get(url));
const group = async () => (await version()).review.find((i) => i.reason === BLANK_INVOICEABLE)!;
const picks = async () => (await version()).review.filter((i) => i.reason === "TABLE_CHECK");
const pick = (id: string, body: object, by = "Sam Rivera") => post(`${url}/review/${encodeURIComponent(id)}`, { by, ...body });
const actions = async () => AuditPage.parse(await get("/audit?limit=100")).items.map((e) => e.action);

/** The blind way to learn which option of a table pick is right: try each in a fresh sample server. `before`: picks already right. */
async function rightOption(index: number, before: string[] = []) {
  const options = (await picks())[index]!.options.map((o) => o.id);
  const right: string[] = [];
  for (const o of options) {
    mockReset();
    for (const [i, c] of before.entries()) await pick((await picks())[i]!.id, { optionId: c });
    const id = (await picks())[index]!.id;
    if (RulebookVersionDto.parse((await pick(id, { optionId: o })).json).review.find((x) => x.id === id)?.outcome === "matched") right.push(o);
  }
  mockReset();
  return right;
}
/** Every pick of the table right, as a person who can read the page would answer. */
async function confirmTable() {
  const first = (await rightOption(0))[0]!;
  const second = (await rightOption(1, [first]))[0]!;
  const [a, b] = await picks();
  expect((await pick(a!.id, { optionId: first })).status).toBe(200);
  expect((await pick(b!.id, { optionId: second })).status).toBe(200);
}

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

  it("waits for its table's columns: refused with what to do first, nothing changed, until every column pick is right", async () => {
    const q = await group();
    expect(q.after).toBeTruthy();
    const before = JSON.stringify(await get(url));
    const res = await pick(q.id, { optionId: "printed_only" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toMatch(/Confirm the table's columns first/);
    expect(JSON.stringify(await get(url))).toBe(before);
    // one right pick isn't enough
    const first = (await rightOption(0))[0]!;
    await pick((await picks())[0]!.id, { optionId: first });
    expect((await pick(q.id, { optionId: "printed_only" })).status).toBe(409);
    // all right: it can be answered
    mockReset();
    await confirmTable();
    expect((await group()).after).toBeUndefined();
    expect((await pick(q.id, { optionId: "printed_only" })).status).toBe(200);
  }, 60_000);

  it("is rejected with its table: a wrong column pick (or can't tell) turns its cells into blind questions to type, as the table's held prices are", async () => {
    const cells = (await version()).evidence.filter((e) => e.blank).map((e) => e.path);
    const [a] = await picks();
    // can't tell always rejects
    expect((await pick(a!.id, { cantTell: true })).status).toBe(200);
    const v = await version();
    expect(v.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(v.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(v.evidence.some((e) => e.blank)).toBe(false);
    expect(await actions()).toContain("review.table_rejected");
    // and a pick that differs does the same
    mockReset();
    const right = (await rightOption(0))[0]!;
    mockReset();
    const [b] = await picks();
    const other = b!.options.map((o) => o.id).find((o) => o !== right)!;
    expect((await pick(b!.id, { optionId: other })).status).toBe(200);
    expect((await version()).review.filter((i) => i.reason === "BLANK_REJECTED")).toHaveLength(cells.length);
  }, 60_000);

  it("only a listed pick settles it, never a typed value or a note", async () => {
    await confirmTable();
    const q = await group();
    for (const body of [{}, { value: "x" }, { optionId: "nope" }, { optionId: "every_visit", note: "all" }]) expect((await pick(q.id, body)).status, JSON.stringify(body)).toBe(400);
  }, 60_000);

  it("“Only where the contract prints a price” removes the cells and logs it; the answer is final", async () => {
    await confirmTable();
    const q = await group();
    const cells = (await version()).evidence.filter((e) => e.blank).map((e) => e.path);
    expect((await pick(q.id, { optionId: "printed_only" })).status).toBe(200);
    const v = await version();
    for (const p of cells) expect(getAt(v.rulebook, p), p).toBeUndefined();
    expect(v.evidence.some((e) => e.blank || cells.includes(e.path))).toBe(false);
    expect(v.review.find((i) => i.id === q.id)).toMatchObject({ outcome: "chosen" });
    expect(await actions()).toContain("review.blank_removed");
    expect((await pick(q.id, { optionId: "every_visit" }, "Taylor Brooks")).status).toBe(409);
    // and it can't be sent back, as a table pick can't
    expect((await post(`${url}/send-back`, { itemIds: [q.id], note: "again", by: "Taylor Brooks" })).status).toBe(409);
  }, 60_000);

  it("“At every scheduled visit shown” keeps the cells, attested; “can't tell” asks each one blind", async () => {
    await confirmTable();
    const q = await group();
    const cells = (await version()).evidence.filter((e) => e.blank).map((e) => e.path);
    expect((await pick(q.id, { optionId: "every_visit" })).status).toBe(200);
    const v = await version();
    for (const p of cells) {
      expect(getAt(v.rulebook, p), p).toBe("invoiceable");
      expect(v.evidence.find((e) => e.path === p)).toMatchObject({ status: "attested" });
    }
    mockReset();
    await confirmTable();
    expect((await pick((await group()).id, { cantTell: true })).status).toBe(200);
    const w = await version();
    expect(w.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(w.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(await actions()).toContain("review.blank_rejected");
  }, 60_000);
});
