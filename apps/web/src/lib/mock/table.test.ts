import { beforeEach, describe, expect, it } from "vitest";
import { AuditPage, RulebookVersionDto } from "@dct/shared";
import { getAt } from "../pointer";
import { mockSampling } from "./fixtures";
import { mockRequest, mockReset } from "./server";

// The table check in the sample server (Cobalt, a scan whose first grid is held for its columns): answered by the same
// shared rules as the API's (answerQuestion, followUps), and blind the same way.

mockSampling.random = () => 1 - 2 ** -32;
const url = "/studies/st-cobalt/versions/1";
const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const version = async () => RulebookVersionDto.parse(await get(url));
const picks = async () => (await version()).review.filter((i) => i.reason === "TABLE_CHECK");
const pick = (id: string, optionId: string, by = "Sam Rivera") => post(`${url}/review/${encodeURIComponent(id)}`, { optionId, by });
const actions = async () => AuditPage.parse(await get("/audit?limit=100")).items.map((e) => e.action);

/** The blind way to learn which option is right: try each in a fresh sample server; exactly one matches. `before`: picks already right. */
async function rightOption(index: number, before: string[] = []) {
  const options = (await picks())[index]!.options.map((o) => o.id);
  const right: string[] = [];
  for (const o of options) {
    mockReset();
    for (const [i, c] of before.entries()) await pick((await picks())[i]!.id, c);
    const id = (await picks())[index]!.id;
    const r = RulebookVersionDto.parse((await pick(id, o)).json);
    if (r.review.find((x) => x.id === id)?.outcome === "matched") right.push(o);
  }
  mockReset();
  return right;
}

describe("mock API table check", () => {
  beforeEach(() => mockReset());

  it("asks two blind picks with the column's box, never sends the visit the read gave it, and holds the prices", async () => {
    const qs = await picks();
    expect(qs).toHaveLength(2);
    expect(qs.every((q) => q.path === null && q.blocking && q.where[0]!.box && q.options.length > 2 && q.outcome === null)).toBe(true);
    const raw = JSON.stringify(await get(url));
    expect(raw).not.toContain('"expect"');
    expect(raw).not.toContain('"table":');
    expect(JSON.stringify((await pick(qs[0]!.id, qs[0]!.options[0]!.id)).json)).not.toContain('"expect"');
    // every held price is withheld as an asked one is: null in the master, no printed text, no spot on the page
    const v = await version();
    const heldEv = v.evidence.filter((e) => e.held);
    expect(heldEv.length).toBeGreaterThan(0);
    for (const e of heldEv) {
      expect(getAt(v.rulebook, e.path), e.path).toBeNull();
      expect(e).toMatchObject({ printed: null });
      expect(e.where.every((w) => w.box === null)).toBe(true);
    }
    const asOf = (await version()).updatedAt;
    expect((await post(`${url}/sign-off`, { by: "Taylor Brooks", asOf })).status).toBe(409);
  });

  it("only a pick settles it, and “can't tell” rejects the mapping: its prices are asked blind", async () => {
    const [a] = await picks();
    for (const body of [{}, { value: "x" }, { optionId: "nope" }]) expect((await post(`${url}/review/${encodeURIComponent(a!.id)}`, { by: "Sam Rivera", ...body })).status).toBe(400);
    expect((await post(`${url}/review/${encodeURIComponent(a!.id)}`, { by: "Sam Rivera", cantTell: true })).status).toBe(200);
    const v = await version();
    expect(v.evidence.some((e) => e.held)).toBe(false);
    expect(v.review.some((i) => i.reason === "TABLE_CHECK")).toBe(false);
    const typed = v.review.filter((i) => i.reason === "TABLE_REJECTED");
    expect(typed.length).toBeGreaterThan(0);
    for (const i of typed) expect(getAt(v.rulebook, i.path!), i.path!).toBeNull();
  });

  it("every pick right confirms the table's prices; a wrong one rejects the columns and asks each price", async () => {
    const right0 = await rightOption(0);
    expect(right0).toHaveLength(1);
    const right1 = await rightOption(1, right0);
    expect(right1).toHaveLength(1);

    await pick((await picks())[0]!.id, right0[0]!);
    await pick((await picks())[1]!.id, right1[0]!);
    const v = await version();
    expect(v.evidence.some((e) => e.held)).toBe(false);
    expect(v.evidence.filter((e) => e.path.includes("/cells/")).every((e) => e.status === "confirmed")).toBe(true);
    expect(await actions()).toContain("review.table_confirmed");
    // the answer is final: no second answer, no send-back
    expect((await pick((await picks())[0]!.id, right0[0]!, "Morgan Lee")).status).toBe(409);
    expect((await post(`${url}/send-back`, { itemIds: [(await picks())[0]!.id], note: "again", by: "Morgan Lee" })).status).toBe(409);

    mockReset();
    await pick((await picks())[0]!.id, right0[0]!);
    const wrong = (await picks())[1]!.options.find((o) => o.id !== right1[0])!.id;
    await pick((await picks())[1]!.id, wrong);
    const after = await version();
    expect(after.evidence.some((e) => e.held)).toBe(false);
    const typed = after.review.filter((i) => i.reason === "TABLE_REJECTED");
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((i) => i.outcome === null && i.input === "money")).toBe(true);
    expect(await actions()).toContain("review.table_rejected");
  }, 30_000);
});
