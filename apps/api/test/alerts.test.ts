import type { AlertPage, AuditEntryDto } from "@dct/shared";
import { desc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alerts, studies } from "../src/db/schema.js";
import { fakeControls } from "../src/extraction/fake.js";
import { type App, type Built, extract as extractJob, newStudy as create, resetDb, settleAll, testApp } from "./helpers.js";

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

const get = async <T>(url: string) => (await app.inject({ url })).json<T>();
const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
const alertsFor = (person: string, qs = "") => get<AlertPage>(`/api/v1/alerts?for=${encodeURIComponent(person)}${qs}`);
const markRead = async (by: string, ids?: string[]) => {
  const res = await post("/api/v1/alerts/read", { by, ids });
  expect(res.statusCode).toBe(200);
  return res.json<{ unread: number }>();
};

// ---- through the real workflow (fake extraction) ----

const newStudy = async (seedText: string) => (await create(app, seedText)).studyId;
const extract = (studyId: string) => extractJob(app, studyId);

describe("raised by the workflow", () => {
  it("reading with open questions, then answering the last one; none while the stage stays put", async () => {
    const id = await newStudy("flow");
    await extract(id);
    expect((await alertsFor("Asha")).items).toEqual([
      { id: expect.any(String), kind: "questions_ready", studyId: id, protocol: "SYN-001", sponsor: "Synthetic Pharma", version: 1, at: expect.any(String), by: "system", count: 8, note: null, read: false },
    ]);
    await settleAll(built, id, 1, "Asha", 3); // still needs you
    expect((await alertsFor("Ben")).items).toHaveLength(1);
    await settleAll(built, id, 1, "Asha");
    const page = await alertsFor("Ben");
    expect(page.items.map((a) => [a.kind, a.by, a.count])).toEqual([
      ["ready_for_approval", "Asha", null],
      ["questions_ready", "system", 8],
    ]);
    expect(await post(`/api/v1/studies/${id}/versions/1/sign-off`, { by: "Ben" })).toMatchObject({ statusCode: 200 });
    expect((await alertsFor("Ben")).items).toHaveLength(2); // live raises nothing
  });

  it("a failed read raises couldnt_read; a retry that reads raises questions_ready", async () => {
    const id = await newStudy("bad");
    fakeControls.failNext = 1;
    await extract(id);
    expect((await alertsFor("Asha")).items).toEqual([expect.objectContaining({ kind: "couldnt_read", studyId: id, version: 1, by: "system", count: null })]);
    await extract(id);
    expect((await alertsFor("Asha")).items.map((a) => a.kind)).toEqual(["questions_ready", "couldnt_read"]);
  });
});

describe("list", () => {
  it("newest first, paged with an opaque cursor: no duplicates or gaps", async () => {
    const [s] = await built.ctx.db.insert(studies).values({ protocol: "P" }).returning();
    // 4 distinct microsecond timestamps for 23 rows: ties broken by id, and precision a JS Date can't hold
    await built.ctx.db.insert(alerts).values(
      Array.from({ length: 23 }, (_, i) => ({
        kind: "questions_ready" as const,
        studyId: s!.id,
        version: 1,
        by: "system",
        count: i,
        createdAt: sql`${`2026-01-01 00:00:00.12345${i % 4}+00`}::timestamptz`,
      })),
    );
    const newestFirst = (await built.ctx.db.select({ id: alerts.id }).from(alerts).orderBy(desc(alerts.createdAt), desc(alerts.id))).map((r) => r.id);
    const ids: string[] = [];
    let page = await alertsFor("Asha", "&limit=5");
    ids.push(...page.items.map((a) => a.id));
    while (page.nextCursor) {
      expect(page.items).toHaveLength(5);
      page = await alertsFor("Asha", `&limit=5&cursor=${page.nextCursor}`);
      ids.push(...page.items.map((a) => a.id));
    }
    expect(ids).toEqual(newestFirst);
    expect(page.unread).toBe(23);
    expect((await app.inject({ url: "/api/v1/alerts?for=Asha&cursor=bm9wZQ" })).statusCode).toBe(400);
    const bad = Buffer.from(JSON.stringify([1.5, s!.id])).toString("base64url");
    expect((await app.inject({ url: `/api/v1/alerts?for=Asha&cursor=${bad}` })).statusCode).toBe(400);
  });
});

describe("read state", () => {
  it("is per person; your own alerts are read for you; unread counts every alert", async () => {
    const [s] = await built.ctx.db.insert(studies).values({ protocol: "P" }).returning();
    const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
    const [a1, a2, mine] = await built.ctx.db
      .insert(alerts)
      .values([
        { kind: "questions_ready", studyId: s!.id, version: 1, by: "system", count: 2, createdAt: at(1) },
        { kind: "couldnt_read", studyId: s!.id, version: 1, by: "system", createdAt: at(2) },
        { kind: "ready_for_approval", studyId: s!.id, version: 1, by: "Asha", createdAt: at(3) },
      ])
      .returning();
    const readOf = async (person: string) => Object.fromEntries((await alertsFor(person)).items.map((a) => [a.id, a.read]));

    expect((await alertsFor("Asha")).unread).toBe(2);
    expect(await readOf("Asha")).toEqual({ [a1!.id]: false, [a2!.id]: false, [mine!.id]: true });
    expect(await alertsFor("Ben", "&limit=1")).toMatchObject({ unread: 3, items: [{ id: mine!.id, read: false }] });

    expect(await markRead("Ben", [a1!.id, "00000000-0000-4000-8000-000000000000"])).toEqual({ unread: 2 }); // unknown id ignored
    expect(await markRead("Ben", [a1!.id])).toEqual({ unread: 2 }); // again: no-op
    expect(await readOf("Ben")).toEqual({ [a1!.id]: true, [a2!.id]: false, [mine!.id]: false });
    expect((await alertsFor("Asha")).unread).toBe(2); // Ben's reads are his

    expect(await markRead("Asha")).toEqual({ unread: 0 });
    expect(await readOf("Asha")).toEqual({ [a1!.id]: true, [a2!.id]: true, [mine!.id]: true });
    expect((await alertsFor("Ben")).unread).toBe(2);
    expect((await get<AuditEntryDto[]>("/api/v1/audit")).some((e) => e.action === "alerts.read")).toBe(false); // reading alerts changes no contract
  });

  it("400s on a bad query or body", async () => {
    for (const url of ["/api/v1/alerts", "/api/v1/alerts?for=", "/api/v1/alerts?for=Asha&limit=0", "/api/v1/alerts?for=Asha&limit=51"])
      expect((await app.inject({ url })).statusCode, url).toBe(400);
    for (const payload of [{}, { by: "" }, { by: "Asha", ids: [] }, { by: "Asha", ids: "x" }, { by: "Asha", ids: ["not-a-uuid"] }])
      expect((await post("/api/v1/alerts/read", payload)).statusCode, JSON.stringify(payload)).toBe(400);
  });
});
