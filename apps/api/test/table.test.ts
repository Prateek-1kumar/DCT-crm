import { bindEvidence, reviewFromEvidence } from "@dct/extraction";
import { type AuditPage, type ReviewItem, type Rulebook, RulebookVersionDto, settled, TABLE_CHECK, type TableCheck, tableQuestions, type ValueEvidence } from "@dct/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rulebookVersions } from "../src/db/schema.js";
import { fakeControls } from "../src/extraction/fake.js";
import { at, reviewDraft, sampling } from "../src/review.js";
import { type App, type Built, extract, newStudy, resetDb, settleAll, signOff, storedVersion, testApp } from "./helpers.js";

// The table check (ADR-001): a scanned table whose columns line up with the visits by count and order, though its
// headers don't match, is held for two blind picks of its columns instead of a question for every price.

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());
beforeEach(async () => {
  fakeControls.failNext = 0;
  await resetDb(built);
});

const get = async <T>(url: string) => (await app.inject({ url: `/api/v1${url}` })).json<T>();
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const answer = (id: string, item: string, optionId: string, by = "Asha") => post(`/studies/${id}/versions/1/review/${encodeURIComponent(item)}`, { optionId, by });
const cellsOf = (rb: Rulebook) => rb.budgetGrids[0]!.procedures.flatMap((p, pi) => Object.keys(p.cells).map((code) => ({ code, path: `/budgetGrids/0/procedures/${pi}/cells/${code.replace(/~/g, "~0").replace(/\//g, "~1")}` })));
const boxFor = (documentId: string, i: number): TableCheck["columns"][number]["box"] => ({ documentId, page: 1, box: [0.1 + i * 0.1, 0.2, 0.08, 0.5] });
const checkOf = (rb: Rulebook): TableCheck => ({ id: "t1", grid: 0, page: 1, columns: rb.budgetGrids[0]!.visits.map((v, i) => ({ box: boxFor(rb.documents[0]!.id, i), visit: v.code })) });

/** A drafted study whose first grid is held for its columns, as the read leaves it after the binder holds a table: every price of the grid held, its other questions gone. */
async function held() {
  const { studyId } = await newStudy(app, "table");
  expect((await extract(app, studyId)).job.state).toBe("succeeded");
  const row = await storedVersion(built, studyId, 1);
  const rb = row.rulebook!;
  const grid = new Set(cellsOf(rb).map((c) => c.path));
  const evidence = row.evidence.map((e): ValueEvidence => (grid.has(e.path) ? { ...e, status: "ungrounded", note: null, held: "t1" } : e));
  const check = checkOf(rb);
  const review = [...row.review.filter((i) => !grid.has(i.path ?? "")), ...tableQuestions(rb, evidence, [check], () => 1 - 2 ** -32)];
  await built.ctx.db.update(rulebookVersions).set({ evidence, review }).where(eq(rulebookVersions.id, row.id));
  return { studyId, grid: [...grid], expect: Object.fromEntries(review.filter((i) => i.table).map((i) => [i.id, i.table!.expect])) as Record<string, string> };
}
const picksOf = async (studyId: string) => (await storedVersion(built, studyId, 1)).review.filter((i) => i.reason === TABLE_CHECK);

describe("the table check, over the API", () => {
  it("asks two picks, each with the visit the read gave its column (what we suggest), and approval waits", async () => {
    const { studyId, expect: right } = await held();
    const raw = (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body;
    const v = RulebookVersionDto.parse(JSON.parse(raw));
    const qs = v.review.filter((i) => i.reason === TABLE_CHECK);
    expect(qs).toHaveLength(2);
    expect(qs.every((q) => q.blocking && q.path === null && q.outcome === null && q.where[0]!.box)).toBe(true);
    for (const q of qs) expect(q.table?.expect, q.id).toBe(right[q.id]);
    const res = await answer(studyId, qs[0]!.id, right[qs[0]!.id]!);
    expect(res.statusCode, res.body).toBe(200);
    // approval waits for the table
    const refused = await signOff(app, studyId, 1, { by: "Ben" });
    expect(refused.statusCode).toBe(409);
  });

  it("settles only by a real pick; “can't tell” rejects the mapping and the prices are asked one by one", async () => {
    const { studyId, grid, expect: right } = await held();
    const [first] = Object.keys(right);
    const url = `/studies/${studyId}/versions/1/review/${encodeURIComponent(first!)}`;
    const before = await storedVersion(built, studyId, 1);
    for (const body of [{}, { value: right[first!] }, { optionId: "nope" }, { optionId: right[first!], note: "it's this" }]) expect((await post(url, { by: "Asha", ...body })).statusCode, JSON.stringify(body)).toBe(400);
    const same = await storedVersion(built, studyId, 1);
    expect([same.review, same.evidence, same.editors]).toEqual([before.review, before.evidence, before.editors]);
    expect((await post(url, { by: "Asha", cantTell: true })).statusCode).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    expect(stored.evidence.some((e) => e.held)).toBe(false);
    expect(stored.review.some((i) => i.reason === TABLE_CHECK)).toBe(false);
    expect(stored.review.filter((i) => i.reason === "TABLE_REJECTED").map((i) => i.path).sort()).toEqual([...grid].sort());
    const v = RulebookVersionDto.parse(await get(`/studies/${studyId}/versions/1`));
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
  });

  it("every pick right confirms the table's prices in the same write, and the contract can be approved", async () => {
    const { studyId, grid, expect: right } = await held();
    const before = await storedVersion(built, studyId, 1);
    expect(before.evidence.filter((e) => e.held === "t1")).toHaveLength(grid.length);
    for (const id of Object.keys(right)) expect((await answer(studyId, id, right[id]!)).statusCode).toBe(200);
    const after = await storedVersion(built, studyId, 1);
    expect(after.evidence.some((e) => e.held)).toBe(false);
    expect(after.evidence.filter((e) => grid.includes(e.path)).every((e) => e.status === "confirmed" && /^Checked by Asha: the table's columns were confirmed/.test(e.note!))).toBe(true);
    const log = (await get<AuditPage>(`/audit?studyId=${studyId}&limit=100`)).items.map((e) => e.action);
    expect(log).toContain("review.table_confirmed");
    // one answer, one log entry each; nothing logged for the pick that didn't finish the table
    expect(log.filter((a) => a === "review.table_confirmed")).toHaveLength(1);
    await settleAll(built, studyId, 1, "Asha");
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("a wrong pick rejects the columns: each price is asked, the other pick closes, and the answer is final", async () => {
    const { studyId, grid, expect: right } = await held();
    const [first, second] = Object.keys(right);
    const wrong = (await get<RulebookVersionDto>(`/studies/${studyId}/versions/1`)).review.find((i) => i.id === first)!.options.find((o) => o.id !== right[first!])!.id;
    expect((await answer(studyId, first!, wrong)).statusCode).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    expect(stored.evidence.some((e) => e.held)).toBe(false);
    expect(stored.review.find((i) => i.id === second)).toBeUndefined();
    const typed = stored.review.filter((i) => i.reason === "TABLE_REJECTED");
    expect(typed.map((i) => i.path).sort()).toEqual([...grid].sort());
    expect(typed.every((i) => i.blocking && !settled(i))).toBe(true);
    // blind: their values are withheld until typed
    const v = await get<RulebookVersionDto>(`/studies/${studyId}/versions/1`);
    expect((await get<AuditPage>(`/audit?studyId=${studyId}&limit=100`)).items.map((e) => e.action)).toContain("review.table_rejected");
    // final, and not sent back
    expect((await answer(studyId, first!, right[first!]!, "Ben")).statusCode).toBe(409);
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: [first], note: "again", by: "Ben" })).statusCode).toBe(409);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
  });
});

describe("reviewDraft with table checks", () => {
  /** What the binder gives: the real binding, its grid's prices held, a placeholder question for the check. */
  async function bound(columns: (rb: Rulebook) => TableCheck["columns"]) {
    const { studyId } = await newStudy(app, "bound");
    await extract(app, studyId);
    const rb = (await storedVersion(built, studyId, 1)).rulebook!;
    const grid = new Set(cellsOf(rb).map((c) => c.path));
    const check = { ...checkOf(rb), columns: columns(rb) };
    const port = {
      bindEvidence: (r: Rulebook, pages: Parameters<typeof bindEvidence>[1]) => {
        const b = bindEvidence(r, pages);
        const evidence = [...b.evidence.filter((e) => !grid.has(e.path)), ...[...grid].map((path): ValueEvidence => ({ path, status: "ungrounded", where: [], printed: null, note: null, held: "t1" }))];
        return { ...b, evidence, tableChecks: [{ ...check, table: check.columns[0]?.box ?? boxFor(rb.documents[0]!.id, 0) }] };
      },
      // the binder's own: one placeholder per check, and no question for a held price
      reviewFromEvidence,
    };
    return { rb, grid, out: reviewDraft(port, rb, [], [], []) };
  }

  it("replaces the binder's placeholder with the picks, keeps held prices out of the sample, and leaves them held", async () => {
    sampling.random = () => 0.5;
    const { out, grid } = await bound((rb) => checkOf(rb).columns);
    expect(out.review.filter((i) => i.reason === TABLE_CHECK).map((i) => i.question)).toEqual(Array(2).fill(expect.stringMatching(/^Which visit is the highlighted column/)));
    expect(out.review.some((i) => i.id === "t1")).toBe(false); // the binder's placeholder
    expect(out.review.some((i) => grid.has(i.path ?? ""))).toBe(false); // neither asked one by one, nor sampled
    expect(out.evidence.filter((e) => e.held === "t1")).toHaveLength(grid.size);
    expect(out.evidence.filter((e) => e.held).every((e) => e.status !== "confirmed")).toBe(true);
  });

  it("a table with no columns to pick from asks each held price instead, never leaving them held", async () => {
    const { out, grid } = await bound(() => []);
    expect(out.review.some((i) => i.reason === TABLE_CHECK)).toBe(false);
    expect(out.evidence.some((e) => e.held)).toBe(false);
    expect(out.review.filter((i) => i.reason === "TABLE_REJECTED").map((i) => i.path).sort()).toEqual([...grid].sort());
  });
});
