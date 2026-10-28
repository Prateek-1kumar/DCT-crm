import type { AuditPage, DocumentDto, RulebookVersionDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { fakeControls } from "../src/extraction/fake.js";
import { at } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload } from "./helpers.js";

// Regression tests for the security review (backend-audit.md): one block per finding.

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

const get = (url: string) => app.inject({ url: `/api/v1${url}` });
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url: `/api/v1${url}`, payload });
const version = async (id: string, v = 1) => (await get(`/studies/${id}/versions/${v}`)).json<RulebookVersionDto>();
const answer = async (id: string, item: string, body: object, v = 1) => {
  const res = await post(`/studies/${id}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RulebookVersionDto>().review.find((i) => i.id === item)!;
};
const G2_TOTAL = "/budgetGrids/1/visits/1/totalCents"; // read 8,488.00, printed 8,489.00 (test/helpers.ts makeTextPdf)

describe("H1: errors never show the database's message", () => {
  it("a server error says what to do, with a reference, not the SQL or its values", async () => {
    await built.ctx.db.execute(sql`ALTER TABLE settings RENAME TO settings_away`);
    try {
      const res = await get("/settings");
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toMatch(/^Something went wrong on the server\. Try again; if it keeps happening, tell the team \(ref .+\)\.$/);
      expect(res.body).not.toMatch(/select|settings|query|params/i);
    } finally {
      await built.ctx.db.execute(sql`ALTER TABLE settings_away RENAME TO settings`);
    }
  });

  it("ids, version numbers and cursors that don't fit are the request's fault (400), never a database error", async () => {
    const { studyId } = await newStudy(app, "ids");
    expect((await get(`/studies/${studyId}/versions/3000000000`)).json()).toMatchObject({ statusCode: 400, message: 'Invalid version "3000000000"' });
    expect((await get(`/studies/${studyId}/versions/1/diff?against=3000000000`)).statusCode).toBe(400);
    expect((await get("/studies/not-a-uuid")).json()).toMatchObject({ statusCode: 400, message: "Malformed id" });
    expect((await get("/jobs/not-a-uuid")).statusCode).toBe(400);
    const cursor = Buffer.from(JSON.stringify([3000000000, "1", "00000000-0000-0000-0000-000000000000"])).toString("base64url");
    expect((await get(`/studies?cursor=${cursor}`)).json()).toMatchObject({ statusCode: 400, message: "Invalid cursor" });
  });
});

describe("H2: the host guard holds behind the web app's proxy", () => {
  it("refuses a request whose browser Host (X-Forwarded-Host) is foreign, as DNS rebinding through the proxy sends", async () => {
    const res = await app.inject({ url: "/api/v1/settings", headers: { host: "127.0.0.1:4100", "x-forwarded-host": "evil.example:3100" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Host not allowed");
    expect((await app.inject({ url: "/api/v1/settings", headers: { host: "127.0.0.1:4100", "x-forwarded-host": "127.0.0.1:4100" } })).statusCode).toBe(200);
  });
});

describe("H7: blind entry has no side doors", () => {
  it("a value reported again hides its earlier answer, and its grid's numbers in a contract problem's question", async () => {
    const { studyId } = await newStudy(app, "blind");
    await extract(app, studyId);
    // A contract problem withholds the value it's about (its path), so its question can't print it either.
    const problem = (await version(studyId)).review.find((i) => i.reason === "VISIT_TOTAL_MISMATCH")!;
    expect(problem.question).not.toMatch(/848900/);
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 848900 })).toMatchObject({ outcome: "matched" });
    await answer(studyId, problem.id, { optionId: "printed", note: "Query the total" });
    // the typed total doesn't add up in its own grid either: asked on the typed numbers (recheck), and settled
    await answer(studyId, `anomaly:VISIT_TOTAL_MISMATCH:${G2_TOTAL}`, { optionId: "printed", note: "Query the total" });
    // the blind sample's values in its grid, re-typed
    const stored = await storedVersion(built, studyId, 1);
    for (const i of stored.review.filter((x) => x.reason === "SAMPLE" && x.path!.startsWith("/budgetGrids/0/"))) await answer(studyId, i.id, { value: at(stored.rulebook, i.path!) });
    expect((await version(studyId)).review.find((i) => i.id === problem.id)!.question).toMatch(/848900/); // nothing in its grid withheld now

    // "This looks wrong" on two values: one the earlier answer holds, one in the problem's grid.
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: G2_TOTAL, note: "check", by: "Sam" })).statusCode).toBe(200);
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: "/budgetGrids/0/visits/0/totalCents", note: "check", by: "Sam" })).statusCode).toBe(200);
    const v = await version(studyId);
    expect(at(v.rulebook, G2_TOTAL)).toBeNull();
    const earlier = v.review.find((i) => i.id === `confirm:${G2_TOTAL}`)!;
    expect(earlier).toMatchObject({ outcome: "matched", compare: null });
    expect(earlier.answer).not.toHaveProperty("value");
    expect(v.review.find((i) => i.id === problem.id)!.question).not.toMatch(/\d{4,}/);
    expect(at(v.rulebook, "/budgetGrids/0/visits/0/totalCents")).toBeNull();

    const audit = (await get(`/audit?studyId=${studyId}`)).json<AuditPage>().items;
    const answered = audit.filter((e) => e.action === "review.answered");
    expect(answered.find((e) => e.detail.itemId === `confirm:${G2_TOTAL}`)!.detail).not.toHaveProperty("after");
    expect(String(answered.find((e) => e.detail.itemId === problem.id)!.detail.question)).not.toMatch(/\d{4,}/);
  });
});

describe("M1: a signed version can't be changed or removed, even in the database", () => {
  it("refuses any change but superseding and proofread marks, and refuses delete", async () => {
    const { studyId } = await liveStudy(built);
    const refused = async (q: ReturnType<typeof sql>) => expect(built.ctx.db.execute(q)).rejects.toThrow();
    await refused(sql`UPDATE rulebook_versions SET version = 7 WHERE study_id = ${studyId}`);
    await refused(sql`UPDATE rulebook_versions SET sign_note = 'tampered' WHERE study_id = ${studyId}`);
    await refused(sql`UPDATE rulebook_versions SET cost_usd = 0 WHERE study_id = ${studyId}`);
    await refused(sql`DELETE FROM rulebook_versions WHERE study_id = ${studyId}`);
    await built.ctx.db.execute(sql`UPDATE rulebook_versions SET proofread = '[]', updated_at = now() WHERE study_id = ${studyId}`);
  });
});

describe("M2: what was approved stays as approved", () => {
  it("study details lock once a version is approved; the export is named and headed from the approved version", async () => {
    const { studyId } = await newStudy(app, "lock");
    // before approval, the details can still be confirmed (here: differently from what was read)
    expect((await patch(`/studies/${studyId}`, { sponsor: "Row Sponsor", protocol: "ROW-1", siteName: "Row Site", investigator: "Dr Row", by: "Asha" })).statusCode).toBe(200);
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
    expect((await patch(`/studies/${studyId}`, { sponsor: "S", protocol: "P", siteName: "S", investigator: "I", by: "Asha" })).statusCode).toBe(409);
    const x = await get(`/studies/${studyId}/versions/1/export.xlsx`);
    expect(x.headers["content-disposition"]).toBe('attachment; filename="SYN-001-v1-invoicing-master.xlsx"');
  });
});

describe("M5/M6: request sizes and shapes", () => {
  it("bounds bodies and id lists, and ignores a repeated query key", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect((await post("/studies", { documentIds: ids })).statusCode).toBe(400);
    expect((await post("/alerts/read", { by: "x".repeat(2 * 1024 * 1024) })).statusCode).toBe(413);
    const { studyId } = await newStudy(app, "q");
    await extract(app, studyId);
    expect((await get(`/studies/${studyId}/versions/1/search?q=a&q=b`)).statusCode).toBe(200);
  });

  it("a hand-typed row added or removed is in the audit log", async () => {
    const { studyId } = await newStudy(app, "rows", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    const v0 = (await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" })).json<RulebookVersionDto>();
    const row = v0.rulebook!.budgetGrids[0]!.procedures[0]!;
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/budgetGrids/0/procedures", value: [row, row], note: "x", by: "Avery" })).statusCode).toBe(200);
    const [last] = (await get(`/audit?studyId=${studyId}`)).json<AuditPage>().items;
    expect(last).toMatchObject({ action: "value.typed", by: "Avery", detail: { path: "/budgetGrids/0/procedures", items: 2 } });
  });
});

describe("item 3: a blind re-type checks yes/no and fixed-list values too", () => {
  it("samples them, and a different pick differs instead of overwriting", async () => {
    const { studyId } = await newStudy(app, "pick", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" });
    const type = (p: string, value: unknown) => patch(`/studies/${studyId}/versions/1/values`, { path: p, value, note: "x", by: "Avery" });
    const AUTOPAY = "/budgetGrids/0/visits/0/autopay";
    const PAID = "/payment/visitPayment/value";
    for (const [p, value] of [[AUTOPAY, false], [PAID, "invoice"], ["/payment/netDays/value", 45]] as const) expect((await type(p, value)).statusCode).toBe(200);
    const v = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).json<RulebookVersionDto>();
    expect(v.review.filter((i) => i.reason === "spot_check").map((i) => i.path).sort()).toEqual([AUTOPAY, "/payment/netDays/value", PAID].sort());
    expect(await answer(studyId, `spot:${AUTOPAY}`, { optionId: "true" })).toMatchObject({ outcome: "differs", compare: { typed: true, read: false } });
    expect(await answer(studyId, `spot:${PAID}`, { optionId: "invoice" })).toMatchObject({ outcome: "matched" });
  });
});

describe("Lows", () => {
  it("L1/M8: page images come in a few sizes and stay in the browser an hour; JSON is never cached or sniffed", async () => {
    const [doc] = (await upload(app, [{ name: "p.pdf", data: await makePdf("dpi") }])).json<DocumentDto[]>();
    const png = await get(`/documents/${doc!.id}/pages/1.png?dpi=301`);
    expect(png.headers["cache-control"]).toBe("private, max-age=3600");
    expect(existsSync(path.join(config.uploadDir, "pages", `${doc!.sha256}-1@400.png`))).toBe(true);
    const json = await get("/settings");
    expect(json.headers).toMatchObject({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  });

  it("L2: an upload over the page limit is refused with what to do", async () => {
    const res = await upload(app, [{ name: "huge.pdf", data: await makePdf("huge", config.maxUploadPages + 1) }]);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe(`huge.pdf has ${config.maxUploadPages + 1} pages; the limit is ${config.maxUploadPages} per document. Split it into smaller PDFs and upload those.`);
  });

  it("L6: a read is never retried by the queue (each try pays for AI calls) and may run two hours", async () => {
    expect(await built.ctx.boss.getQueue("extract")).toMatchObject({ retryLimit: 0, expireInSeconds: 7200 });
  });
});
