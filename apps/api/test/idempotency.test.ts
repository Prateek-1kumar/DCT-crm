import type { DocumentDto, JobDto, RulebookVersionDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { maintain } from "../src/jobs.js";
import { type App, type Built, makePdf, makeTextPdf, multipart, resetDb, settleAll, signOff, storedVersion, testApp, waitJob } from "./helpers.js";

// Every write route, sent twice with one Idempotency-Key: the second gets the first's response, byte for byte, and
// changes nothing (rows, audit entries, alerts, jobs). Sent at once (a double click): one effect.

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

const G2_TOTAL = "/budgetGrids/1/visits/1/totalCents"; // read 8,488.00, printed 8,489.00 (test/helpers.ts makeTextPdf)
const FEE = "/siteFees/0/amountCents"; // confirmed by the PDF's text

type Req = { method: "POST" | "PATCH"; url: string; payload?: object | Buffer; headers?: Record<string, string> };
const send = (r: Req, key?: string) =>
  app.inject({ method: r.method, url: `/api/v1${r.url}`, payload: r.payload as object, headers: { ...r.headers, ...(key ? { "idempotency-key": key } : {}) } });
const quoted = () => `"${randomUUID()}"`; // a structured-field string, as the web sends it
/** Version 1 as the approver last saw it, as the approve page sends it with the approval. */
const asOf = async (studyId: string) => (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).json<RulebookVersionDto>().updatedAt;

/** Everything a write can leave behind. */
async function effects() {
  const { rows } = await built.ctx.db.execute(sql`SELECT
    (SELECT count(*) FROM documents)::int AS documents, (SELECT count(*) FROM studies)::int AS studies,
    (SELECT count(*) FROM study_documents)::int AS links, (SELECT count(*) FROM rulebook_versions)::int AS versions,
    (SELECT count(*) FROM jobs)::int AS jobs, (SELECT count(*) FROM pgboss.job WHERE name IN ('identify', 'extract'))::int AS queued,
    (SELECT count(*) FROM audit_log)::int AS audit, (SELECT count(*) FROM alerts)::int AS alerts,
    (SELECT count(*) FROM alert_reads)::int AS reads, (SELECT count(*) FROM idempotency_keys)::int AS keys,
    (SELECT coalesce(json_agg(json_build_object('v', version, 's', status, 'r', review, 'p', proofread, 'u', rulebook->'unclassified') ORDER BY study_id, version), '[]') FROM rulebook_versions)::text AS state,
    (SELECT coalesce(json_agg(json_build_object('s', status, 'n', needs_you, 'p', sponsor) ORDER BY id), '[]') FROM studies)::text AS studyState,
    (SELECT coalesce(json_agg(people), '[]') FROM settings)::text AS settings`);
  return rows[0]!;
}

/** Waits for whatever job a response started, so its own writes aren't counted as the repeat's. */
async function settled(res: { json: () => unknown }) {
  const { jobId } = (res.json() ?? {}) as { jobId?: string };
  if (jobId) await waitJob(app, jobId);
}

/** Sends `r` with a key, then again with the same key: the same response, marked replayed, and no second effect. */
async function twice(r: Req, status = 200) {
  const key = quoted();
  const first = await send(r, key);
  expect(first.statusCode, first.body).toBe(status);
  expect(first.headers["idempotent-replayed"]).toBeUndefined();
  await settled(first);
  const before = await effects();
  const again = await send(r, key);
  expect(again.statusCode).toBe(status);
  expect(again.body).toBe(first.body);
  expect(again.headers["idempotent-replayed"]).toBe("true");
  expect(await effects()).toEqual(before);
  return first;
}

async function uploadReq(seed: string, scan = false): Promise<Req> {
  const { payload, headers } = await multipart([{ name: "Work Order.pdf", data: scan ? await makePdf(seed) : await makeTextPdf(seed) }], { by: "Asha" });
  return { method: "POST", url: "/uploads", payload, headers };
}

describe("every write, sent twice with one key, writes once", () => {
  it("the read workflow: upload, kind, create, confirm, read, answer, report, proofread, send back, approve, report on live, alerts, settings", async () => {
    const [doc] = (await twice(await uploadReq("idem"), 201)).json<DocumentDto[]>();
    expect(doc!.duplicateOf).toBeNull(); // the replay says the same: not a duplicate of itself
    await twice({ method: "PATCH", url: `/documents/${doc!.id}`, payload: { kind: "work_order", by: "Asha" } });
    const { studyId } = (await twice({ method: "POST", url: "/studies", payload: { documentIds: [doc!.id], by: "Asha" } }, 201)).json<{ studyId: string }>();
    await twice({ method: "PATCH", url: `/studies/${studyId}`, payload: { sponsor: "Synthetic Pharma", protocol: "SYN-001", siteName: "Site A", investigator: "Dr. Test", by: "Asha" } });
    const read = (await twice({ method: "POST", url: `/studies/${studyId}/extract`, payload: { by: "Asha" } }, 202)).json<{ jobId: string }>();
    expect((await app.inject({ url: `/api/v1/jobs/${read.jobId}` })).json<JobDto>().state).toBe("succeeded");

    // The read's own figure, which the page doesn't print: "differs". Applied twice, the second would settle it as chosen.
    const v = `/studies/${studyId}/versions/1`;
    const answered = await twice({ method: "POST", url: `${v}/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, payload: { value: 848800, note: "as read", by: "Sam" } });
    expect(answered.json<RulebookVersionDto>().review.find((i) => i.id === `confirm:${G2_TOTAL}`)!.outcome).toBe("differs");
    expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === `confirm:${G2_TOTAL}`)!.outcome).toBe("differs");

    await twice({ method: "POST", url: `${v}/report`, payload: { path: FEE, note: "check", by: "Sam" } });
    // listing a term to bill by hand writes the master's list once
    const term = (await storedVersion(built, studyId, 1)).review.find((i) => i.reason === "UNACCOUNTED_TERM")!.id;
    await twice({ method: "POST", url: `${v}/review/${encodeURIComponent(term)}`, payload: { optionId: "bill_by_hand", by: "Sam" } });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toHaveLength(1);
    await twice({ method: "POST", url: `${v}/proofread`, payload: { paths: ["/invoiceables/0/amountCents"], by: "Sam" } });
    await settleAll(built, studyId, 1);
    await twice({ method: "POST", url: `${v}/send-back`, payload: { itemIds: [`confirm:${G2_TOTAL}`], note: "look again", by: "Morgan" } });
    await settleAll(built, studyId, 1);
    await twice({ method: "POST", url: `${v}/sign-off`, payload: { by: "Ben", asOf: await asOf(studyId) } });
    // on the live version: a correction draft, once (a repeat without the key is a 409: version 2 is in progress)
    await twice({ method: "POST", url: `${v}/report`, payload: { path: FEE, note: "looks off", by: "Sam" } });
    expect((await storedVersion(built, studyId, 2)).status).toBe("draft");
    await twice({ method: "POST", url: "/alerts/read", payload: { by: "Ben" } });
    await twice({ method: "PATCH", url: "/settings", payload: { people: ["Asha", "Ben"], by: "Asha" } });
  });

  it("a pick that differs from the read and a random spot check that misses: each once, with one incident and one alert", async () => {
    const [doc] = (await send(await uploadReq("miss"))).json<DocumentDto[]>();
    const { studyId, jobId } = (await send({ method: "POST", url: "/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    await settled(await send({ method: "POST", url: `/studies/${studyId}/extract`, payload: {} }));
    const v = `/studies/${studyId}/versions/1`;
    const pay = `${v}/review/${encodeURIComponent("interpret:/payment/visitPayment/value")}`;
    await twice({ method: "POST", url: pay, payload: { optionId: "invoice", by: "Sam" } });
    await twice({ method: "POST", url: pay, payload: { optionId: "invoice", note: "§4.1 says invoiced", by: "Sam" } });
    const cell = `${v}/review/${encodeURIComponent("sample:/budgetGrids/0/procedures/0/cells/V1")}`;
    await send({ method: "POST", url: cell, payload: { value: 5600, by: "Sam" } });
    await twice({ method: "POST", url: cell, payload: { value: 5600, note: "the page prints $56.00", by: "Sam" } });
    const n = async (q: ReturnType<typeof sql>) => (await built.ctx.db.execute<{ n: number }>(q)).rows[0]!.n;
    expect(await n(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'sample.missed'`)).toBe(1);
    expect(await n(sql`SELECT count(*)::int AS n FROM alerts WHERE kind = 'sample_missed'`)).toBe(1);
  });

  it("typing in by hand: start, type a value, done", async () => {
    const [doc] = (await send(await uploadReq("hand", true))).json<DocumentDto[]>();
    const { studyId, jobId } = (await send({ method: "POST", url: "/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    fakeControls.failNext = 1;
    await settled(await send({ method: "POST", url: `/studies/${studyId}/extract`, payload: {} }));
    await twice({ method: "POST", url: `/studies/${studyId}/versions/by-hand`, payload: { by: "Avery" } }, 201);
    await twice({ method: "PATCH", url: `/studies/${studyId}/versions/1/values`, payload: { path: "/payment/netDays/value", value: 45, note: "x", by: "Avery" } });
    await twice({ method: "POST", url: `/studies/${studyId}/versions/1/by-hand/done`, payload: { by: "Avery" } });
  });
});

describe("a double click: the same request at once, one key", () => {
  async function readDraft() {
    const [doc] = (await send(await uploadReq("click"))).json<DocumentDto[]>();
    const { studyId, jobId } = (await send({ method: "POST", url: "/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    await settled(await send({ method: "POST", url: `/studies/${studyId}/extract`, payload: {} }));
    return studyId;
  }
  const all = async (r: Req, n = 3) => {
    const key = quoted();
    const res = await Promise.all(Array.from({ length: n }, () => send(r, key)));
    for (const x of res) expect([x.statusCode, x.body]).toEqual([res[0]!.statusCode, res[0]!.body]);
    return res[0]!;
  };
  const count = async (action: string) => (await built.ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`)).rows[0]!.n;

  it("an answer, an approval and a report on the live version each happen once", async () => {
    const studyId = await readDraft();
    const v = `/studies/${studyId}/versions/1`;
    const res = await all({ method: "POST", url: `${v}/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, payload: { value: 848800, note: "as read", by: "Sam" } });
    expect(res.statusCode).toBe(200);
    expect(await count("review.answered")).toBe(1);
    expect(await count("review.changed")).toBe(0);
    await settleAll(built, studyId, 1);
    expect((await all({ method: "POST", url: `${v}/sign-off`, payload: { by: "Ben", asOf: await asOf(studyId) } })).statusCode).toBe(200);
    expect(await count("version.signed")).toBe(1);
    expect((await all({ method: "POST", url: `${v}/report`, payload: { path: FEE, note: "looks off", by: "Sam" } })).statusCode).toBe(200);
    expect(await count("version.correction_opened")).toBe(1);
    expect((await built.ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rulebook_versions WHERE study_id = ${studyId}`)).rows[0]!.n).toBe(2);
  });

  it("an upload and a read again after a failure each happen once", async () => {
    const res = await all(await uploadReq("dbl"));
    expect(res.statusCode).toBe(201);
    expect(res.json<DocumentDto[]>()[0]!.duplicateOf).toBeNull();
    expect(await count("document.uploaded")).toBe(1);

    const doc = res.json<DocumentDto[]>()[0]!;
    const { studyId, jobId } = (await send({ method: "POST", url: "/studies", payload: { documentIds: [doc.id] } })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    fakeControls.failNext = 1;
    await settled(await send({ method: "POST", url: `/studies/${studyId}/extract`, payload: {} }));
    const calls = fakeControls.calls.extract;
    const again = await all({ method: "POST", url: `/studies/${studyId}/extract`, payload: { by: "Asha" } });
    await settled(again);
    expect(fakeControls.calls.extract - calls).toBe(1); // one AI read paid for
    expect(await count("extraction.queued")).toBe(2); // the failed read and this one
  });
});

describe("the key's rules", () => {
  const settings = (people: string[], makerChecker?: boolean): Req => ({ method: "PATCH", url: "/settings", payload: { people, by: "Asha", ...(makerChecker === undefined ? {} : { makerChecker }) } });

  it("the same key with a different request is refused in plain words (422)", async () => {
    const key = quoted();
    expect((await send(settings(["A"]), key)).statusCode).toBe(200);
    const other = await send(settings(["B"]), key);
    expect(other.statusCode).toBe(422);
    expect(other.json().message).toBe("This Idempotency-Key was already used for a different request. Send a new key for each new action.");
    expect((await send({ method: "POST", url: "/alerts/read", payload: { by: "Asha" } }, key)).statusCode).toBe(422);
    expect((await app.inject({ url: "/api/v1/settings" })).json().people).toEqual(["A"]);
  });

  it("takes a bare token too, and refuses a key that isn't 1–255 printable characters (400)", async () => {
    expect((await send(settings(["A"]), randomUUID())).statusCode).toBe(200);
    for (const bad of ['""', `"${"x".repeat(256)}"`, "two words", '"quote"inside"'])
      expect((await send(settings(["A"]), bad)).json()).toMatchObject({ statusCode: 400, message: "The Idempotency-Key header must be 1 to 255 letters, digits or symbols, such as a UUID." });
  });

  it("a request that fails saves nothing, so the same key runs it again once the problem is fixed", async () => {
    const [doc] = (await send(await uploadReq("fail"))).json<DocumentDto[]>();
    const { studyId, jobId } = (await send({ method: "POST", url: "/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    await settled(await send({ method: "POST", url: `/studies/${studyId}/extract`, payload: {} }));
    const key = quoted();
    await settleAll(built, studyId, 1, "Ben");
    await send(settings(["Ben"], true));
    const signOff: Req = { method: "POST", url: `/studies/${studyId}/versions/1/sign-off`, payload: { by: "Ben", asOf: await asOf(studyId) } };
    expect((await send(signOff, key)).statusCode).toBe(409); // maker-checker: Ben answered
    expect((await effects()).keys).toBe(0);
    await send(settings(["Ben"], false));
    const ok = await send(signOff, key);
    expect([ok.statusCode, ok.headers["idempotent-replayed"]]).toEqual([200, undefined]);
  });

  it("a saved response is replayed for a day; after that the key runs as new, and maintenance deletes it", async () => {
    const key = quoted();
    await send(settings(["A"]), key);
    await built.ctx.db.execute(sql`UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`);
    const later = await send(settings(["B"]), key); // a different request is fine once the old one is gone
    expect([later.statusCode, later.headers["idempotent-replayed"]]).toEqual([200, undefined]);
    await built.ctx.db.execute(sql`UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`);
    await maintain(built.ctx, built.ctx.boss);
    expect((await effects()).keys).toBe(0);
  });
});
