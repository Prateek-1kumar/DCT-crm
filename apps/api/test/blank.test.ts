import { bindEvidence, reviewFromEvidence } from "@dct/extraction";
import { type AuditPage, BLANK_INVOICEABLE, type BlankCheck, blankQuestions, type ReviewItem, type Rulebook, RulebookVersionDto, settled, tableQuestions, type ValueEvidence } from "@dct/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rulebookVersions } from "../src/db/schema.js";
import { fakeControls } from "../src/extraction/fake.js";
import { at, reviewDraft } from "../src/review.js";
import { type App, type Built, extract, newStudy, resetDb, settleAll, signOff, storedVersion, testApp } from "./helpers.js";

// The blank check (ADR-001): cells the read calls "invoiceable" where the table prints nothing are one blind question
// per table, answered through the ordinary answer route.

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
const post = (url: string, payload: object, key?: string) => app.inject({ method: "POST", url: `/api/v1${url}`, payload, headers: key ? { "idempotency-key": key } : {} });
const answer = (id: string, item: string, body: object, by = "Asha") => post(`/studies/${id}/versions/1/review/${encodeURIComponent(item)}`, { by, ...body });
const ptr = (code: string) => code.replace(/~/g, "~0").replace(/\//g, "~1");
const actions = async (studyId: string) => (await get<AuditPage>(`/audit?studyId=${studyId}&limit=100`)).items.map((e) => e.action);
const ID = "blank:0:d1#1:0";

/**
 * A drafted study where the first row of the first grid is "invoiceable" at every visit its row has, and the page prints
 * nothing there: as the read leaves it after the binder groups them. Their own questions are gone.
 */
async function blanked() {
  const { studyId } = await newStudy(app, "blank");
  expect((await extract(app, studyId)).job.state).toBe("succeeded");
  const row = await storedVersion(built, studyId, 1);
  const rb = structuredClone(row.rulebook!);
  const proc = rb.budgetGrids[0]!.procedures[0]!;
  const cells = Object.keys(proc.cells).map((code) => `/budgetGrids/0/procedures/0/cells/${ptr(code)}`);
  for (const code of Object.keys(proc.cells)) proc.cells[code] = "invoiceable";
  const mark = new Set(cells);
  const evidence = row.evidence.map((e): ValueEvidence => (mark.has(e.path) ? { ...e, status: "ungrounded", printed: null, note: null, blank: ID } : e));
  const check: BlankCheck = { id: ID, grid: 0, page: 1, table: { documentId: rb.documents[0]!.id, page: 1, box: [0.1, 0.2, 0.8, 0.5] }, rows: [0], cells };
  const review = [...row.review.filter((i) => !mark.has(i.path ?? "")), ...blankQuestions(evidence, [check])];
  await built.ctx.db.update(rulebookVersions).set({ rulebook: rb, evidence, review }).where(eq(rulebookVersions.id, row.id));
  return { studyId, cells, original: row.rulebook! };
}

describe("the blank check, over the API", () => {
  it("is one question; its cells wait with it (no printed text), and approval waits", async () => {
    const { studyId, cells } = await blanked();
    const raw = (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body;
    const v = RulebookVersionDto.parse(JSON.parse(raw));
    const q = v.review.filter((i) => i.reason === BLANK_INVOICEABLE);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: ID, path: null, blocking: true, outcome: null, input: null });
    expect(q[0]!.options.map((o) => o.id)).toEqual(["printed_only", "every_visit"]);
    for (const p of cells) {
      expect(v.evidence.find((e) => e.path === p), p).toMatchObject({ printed: null, blank: ID });
    }
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
  });

  it("“Only where the contract prints a price” removes the cells in the same write, logs it, and the contract can then be approved by someone else", async () => {
    const { studyId, cells } = await blanked();
    const res = await answer(studyId, ID, { optionId: "printed_only" });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    for (const p of cells) {
      expect(at(stored.rulebook, p), p).toBeUndefined();
      expect(stored.evidence.some((e) => e.path === p)).toBe(false);
    }
    expect(stored.evidence.some((e) => e.blank)).toBe(false);
    expect(stored.editors).toEqual(["Asha"]);
    const log = await actions(studyId);
    expect(log.filter((a) => a === "review.blank_removed")).toHaveLength(1);
    // final, from anyone, and it can't be sent back
    expect((await answer(studyId, ID, { optionId: "every_visit" }, "Ben")).statusCode).toBe(409);
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: [ID], note: "again", by: "Ben" })).statusCode).toBe(409);
    await settleAll(built, studyId, 1, "Asha");
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("“At every scheduled visit shown” keeps the cells, attested by the person, and the contract can be approved", async () => {
    const { studyId, cells, original } = await blanked();
    expect((await answer(studyId, ID, { optionId: "every_visit" })).statusCode).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    for (const p of cells) {
      expect(at(stored.rulebook, p), p).toBe("invoiceable");
      expect(stored.evidence.find((e) => e.path === p), p).toMatchObject({ status: "attested", note: "Typed by Asha" });
      expect(stored.evidence.find((e) => e.path === p)!.blank).toBeUndefined();
    }
    expect(at(stored.rulebook, "/budgetGrids/0/procedures/1")).toEqual(at(original, "/budgetGrids/0/procedures/1"));
    expect(await actions(studyId)).not.toContain("review.blank_removed");
    await settleAll(built, studyId, 1, "Asha");
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("“can't tell” asks each cell instead, and refuses anything that isn't a listed pick", async () => {
    const { studyId, cells } = await blanked();
    const before = await storedVersion(built, studyId, 1);
    for (const body of [{}, { value: "only where printed" }, { optionId: "nope" }, { optionId: "every_visit", note: "all of them" }, { optionId: "every_visit", value: 1 }])
      expect((await answer(studyId, ID, body)).statusCode, JSON.stringify(body)).toBe(400);
    const same = await storedVersion(built, studyId, 1);
    expect([same.review, same.evidence, same.editors, same.rulebook]).toEqual([before.review, before.evidence, before.editors, before.rulebook]);
    expect((await answer(studyId, ID, { cantTell: true })).statusCode).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    expect(stored.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    const typed = stored.review.filter((i) => i.reason === "BLANK_REJECTED");
    expect(typed.map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(typed.every((i) => i.blocking && !settled(i))).toBe(true);
    expect(stored.evidence.some((e) => e.blank)).toBe(false);
    expect(await actions(studyId)).toContain("review.blank_rejected");
    // still withheld, now by their own questions
    const v = RulebookVersionDto.parse(await get(`/studies/${studyId}/versions/1`));
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
  });

  it("the same answer with the same key is replayed byte for byte and writes nothing more", async () => {
    const { studyId } = await blanked();
    const key = `"blank-${studyId}"`;
    const first = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(ID)}`, { optionId: "printed_only", by: "Asha" }, key);
    expect(first.statusCode, first.body).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    const logged = (await actions(studyId)).length;
    const again = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(ID)}`, { optionId: "printed_only", by: "Asha" }, key);
    expect(again.body).toBe(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(await storedVersion(built, studyId, 1)).toEqual(stored);
    expect((await actions(studyId)).length).toBe(logged);
  });
});

describe("reviewDraft with blank checks", () => {
  it("asks the group once, and no question of its own for any cell in it", async () => {
    const { studyId, cells } = await blanked();
    const rb = (await storedVersion(built, studyId, 1)).rulebook as Rulebook;
    const check: BlankCheck = { id: ID, grid: 0, page: 1, table: { documentId: rb.documents[0]!.id, page: 1, box: [0.1, 0.2, 0.8, 0.5] }, rows: [0], cells };
    const port = {
      // the binder's own, with the group's cells marked as it marks them: ungrounded, blank
      bindEvidence: (r: Rulebook, pages: Parameters<typeof bindEvidence>[1]) => {
        const b = bindEvidence(r, pages);
        const mark = new Set(cells);
        const evidence = b.evidence.filter((e) => !mark.has(e.path)).concat(cells.map((path): ValueEvidence => ({ path, status: "ungrounded", where: [], printed: null, note: "the scan is unclear here", blank: ID })));
        return { ...b, evidence, blankChecks: [check] };
      },
      reviewFromEvidence,
    };
    const out = reviewDraft(port, rb, [], [], []);
    expect(out.review.filter((i): i is ReviewItem => i.reason === BLANK_INVOICEABLE).map((i) => i.id)).toEqual([ID]);
    // not asked one by one (the cells' status is ungrounded, which would ask each), nor drawn for the sample
    expect(out.review.some((i) => cells.includes(i.path ?? ""))).toBe(false);
    expect(out.evidence.filter((e) => e.blank === ID)).toHaveLength(cells.length);
  });
});

describe("a blank check on a table whose columns are held, over the API", () => {
  /** The blanked study, with the rest of its first grid held for the table's columns (a table check `t1`), and the group waiting for it. */
  async function waiting() {
    const { studyId, cells } = await blanked();
    const row = await storedVersion(built, studyId, 1);
    const rb = row.rulebook!;
    const rest = new Set(rb.budgetGrids[0]!.procedures.flatMap((p, pi) => Object.keys(p.cells).map((code) => `/budgetGrids/0/procedures/${pi}/cells/${ptr(code)}`)).filter((p) => !cells.includes(p)));
    const evidence = row.evidence.map((e): ValueEvidence => (rest.has(e.path) ? { ...e, status: "ungrounded", note: null, held: "t1" } : e));
    const columns = rb.budgetGrids[0]!.visits.map((v, i) => ({ box: { documentId: rb.documents[0]!.id, page: 1, box: [0.1 + i * 0.1, 0.2, 0.08, 0.5] as [number, number, number, number] }, visit: v.code }));
    const table = tableQuestions(rb, evidence, [{ id: "t1", grid: 0, page: 1, columns }], () => 1 - 2 ** -32);
    const check: BlankCheck = { id: ID, grid: 0, page: 1, table: columns[0]!.box, rows: [0], cells, after: "t1" };
    const review = [...row.review.filter((i) => i.reason !== BLANK_INVOICEABLE && !rest.has(i.path ?? "")), ...table, ...blankQuestions(evidence, [check])];
    await built.ctx.db.update(rulebookVersions).set({ evidence, review }).where(eq(rulebookVersions.id, row.id));
    return { studyId, cells, rest: [...rest], right: Object.fromEntries(table.map((i) => [i.id, i.table!.expect])) as Record<string, string> };
  }

  it("is refused with what to do first while the table's columns are open, and nothing changes", async () => {
    const { studyId } = await waiting();
    const before = await storedVersion(built, studyId, 1);
    for (const body of [{ optionId: "printed_only" }, { optionId: "every_visit" }, { cantTell: true }]) {
      const res = await answer(studyId, ID, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json<{ message: string }>().message).toMatch(/^Confirm the table's columns first/);
    }
    const same = await storedVersion(built, studyId, 1);
    expect([same.review, same.evidence, same.editors, same.rulebook]).toEqual([before.review, before.evidence, before.editors, before.rulebook]);
    // the response says it waits
    const v = RulebookVersionDto.parse(await get(`/studies/${studyId}/versions/1`));
    expect(v.review.find((i) => i.id === ID)!.after).toBe("t1");
  });

  it("becomes answerable once the table's columns are confirmed, and not before", async () => {
    const { studyId, cells, right } = await waiting();
    const [first, second] = Object.keys(right);
    expect((await answer(studyId, first!, { optionId: right[first!] })).statusCode).toBe(200);
    expect((await answer(studyId, ID, { optionId: "printed_only" })).statusCode).toBe(409);
    expect((await answer(studyId, second!, { optionId: right[second!] })).statusCode).toBe(200);
    expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === ID)!.after).toBeUndefined();
    expect((await answer(studyId, ID, { optionId: "printed_only" })).statusCode).toBe(200);
    for (const p of cells) expect(at((await storedVersion(built, studyId, 1)).rulebook, p)).toBeUndefined();
  });

  it.each(["a wrong pick", "can't tell"])("is rejected with the table (%s): its cells are asked one by one, as the held prices are", async (how) => {
    const { studyId, cells, rest, right } = await waiting();
    const [first] = Object.keys(right);
    const body = how === "a wrong pick"
      ? { optionId: (await get<RulebookVersionDto>(`/studies/${studyId}/versions/1`)).review.find((i) => i.id === first)!.options.find((o) => o.id !== right[first!])!.id }
      : { cantTell: true };
    expect((await answer(studyId, first!, body)).statusCode).toBe(200);
    const stored = await storedVersion(built, studyId, 1);
    expect(stored.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(stored.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(stored.review.filter((i) => i.reason === "TABLE_REJECTED").map((i) => i.path).sort()).toEqual([...rest].sort());
    expect(stored.evidence.some((e) => e.blank || e.held)).toBe(false);
    // every one is withheld by its own question; the master keeps what the read had
    const v = RulebookVersionDto.parse(await get(`/studies/${studyId}/versions/1`));
    expect(at(stored.rulebook, cells[0]!)).toBe("invoiceable");
    expect(await actions(studyId)).toContain("review.table_rejected");
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
  });

  it("reviewDraft rejects a group whose table has no columns to pick from, and keeps one whose table has them", async () => {
    const { studyId, cells } = await blanked();
    const rb = (await storedVersion(built, studyId, 1)).rulebook as Rulebook;
    const doc = rb.documents[0]!.id;
    const box = { documentId: doc, page: 1, box: [0.1, 0.2, 0.8, 0.5] as [number, number, number, number] };
    const out = (columns: { box: typeof box; visit: string }[]) =>
      reviewDraft(
        {
          bindEvidence: (r: Rulebook, pages: Parameters<typeof bindEvidence>[1]) => {
            const b = bindEvidence(r, pages);
            const mark = new Set(cells);
            const evidence = b.evidence.filter((e) => !mark.has(e.path)).concat(cells.map((path): ValueEvidence => ({ path, status: "ungrounded", where: [], printed: null, note: null, blank: ID })));
            return { ...b, evidence, tableChecks: [{ id: "t1", grid: 0, page: 1, table: box, columns }], blankChecks: [{ id: ID, grid: 0, page: 1, table: box, rows: [0], cells, after: "t1" }] };
          },
          reviewFromEvidence,
        },
        rb, [], [], [],
      );
    const waits = out(rb.budgetGrids[0]!.visits.map((v) => ({ box, visit: v.code })));
    expect(waits.review.find((i) => i.id === ID)!.after).toBe("t1");
    const none = out([]);
    expect(none.review.some((i) => i.reason === BLANK_INVOICEABLE)).toBe(false);
    expect(none.review.filter((i) => i.reason === "BLANK_REJECTED").map((i) => i.path).sort()).toEqual([...cells].sort());
    expect(none.evidence.some((e) => e.blank)).toBe(false);
  });
});
