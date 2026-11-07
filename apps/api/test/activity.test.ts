import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, documents, reads, studies, studyDocuments, versions } from "../src/db/schema.js";
import { describeAudit } from "../src/lib/activity.js";
import { type App, type Built, testApp } from "./helpers.js";

let built: Built;
let app: App;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());

const db = () => built.ctx.db;
const get = (qs = "") => app.inject({ url: `/api/v1/activity${qs}` });
const log = async (by: string, action: string, entity: string, entityId: string, detail: Record<string, unknown> = {}) => (await db().insert(auditLog).values({ by, action, entity, entityId, detail }).returning())[0]!;

describe("describeAudit", () => {
  const ana = (action: string, detail: Record<string, unknown> = {}, versionNumber: number | null = null) => describeAudit({ by: "Ana", action, detail, versionNumber });
  const cases: [string, Record<string, unknown>, number | null, string, string][] = [
    ["read.started", {}, 1, "Ana started reading version 1", "reading"],
    ["read.started", { number: 3 }, null, "Ana started reading version 3", "reading"],
    ["study.fill", {}, null, "Ana finished reading the contract and filled in its details", "reading"],
    ["version.answered", { label: "Use the printed total" }, 2, 'Ana answered a decision on version 2 with "Use the printed total"', "decision"],
    ["version.answered", {}, 2, "Ana answered a decision on version 2", "decision"],
    ["version.approved", {}, 2, "Ana approved version 2 and made it live", "approval"],
    ["version.superseded", {}, 1, "Ana approved a newer version, so version 1 is no longer live", "approval"],
    ["version.proofread", { items: ["a", "b"] }, 2, "Ana proofread 2 items on version 2", "proofread"],
    ["version.proofread", { items: ["a"] }, 2, "Ana proofread 1 item on version 2", "proofread"],
    ["version.unproofread", { item: "a" }, 2, "Ana took their proofreading mark off an item on version 2", "proofread"],
    ["document.upload", { name: "budget.pdf" }, null, 'Ana uploaded "budget.pdf"', "files"],
    ["study.document.add", { name: "budget.pdf" }, null, 'Ana added "budget.pdf" to this contract', "files"],
    ["study.document.remove", { name: "budget.pdf" }, null, 'Ana removed "budget.pdf" from this contract', "files"],
    ["study.document.remove", {}, null, "Ana removed a file from this contract", "files"],
    ["study.create", {}, null, "Ana added a new contract", "other"],
    ["party.create", { kind: "cro", name: "Quintiles" }, null, 'Ana added the CRO "Quintiles"', "parties"],
    ["party.alias", { alias: "QNT", name: "Quintiles" }, null, 'Ana added "QNT" as a name for "Quintiles"', "parties"],
    ["party.alias", { alias: "QNT" }, null, 'Ana added "QNT" as a name for a party', "parties"],
    ["party.rename", { from: "Old", to: "New" }, null, 'Ana renamed "Old" to "New"', "parties"],
    ["party.merge", { from: "A", into: "B", studies: 1 }, null, 'Ana merged "A" into "B" (1 contract moved)', "parties"],
    ["party.merge", { from: "A", into: "B", studies: 3 }, null, 'Ana merged "A" into "B" (3 contracts moved)', "parties"],
    ["study.parties", { set: { sponsor: "Acme" } }, null, 'Ana set the sponsor to "Acme" on this contract', "parties"],
    ["study.parties", { set: { sponsor: "Acme", payer: null, site: "St Mary" } }, null, 'Ana set the sponsor to "Acme", cleared the CRO and set the site to "St Mary" on this contract', "parties"],
    ["something.new", { secret: "x" }, null, "Something changed", "other"],
  ];
  it.each(cases)("%s %j", (action, detail, version, summary, kind) => {
    expect(ana(action, detail, version)).toEqual({ summary, kind });
  });

  it("never shows a code or raw detail, even for rows missing their detail", () => {
    for (const [action] of cases) {
      const { summary } = ana(action);
      expect(summary).not.toMatch(/[a-z]+\.[a-z]+|[{}[\]]|undefined|null/);
    }
  });
});

describe("GET /activity", () => {
  /** A study with a protocol, two versions and a read, and audit rows about each, oldest first. */
  async function seed(protocol: string | null = `P-${randomUUID().slice(0, 8)}`) {
    const [s] = await db().insert(studies).values({ createdBy: "test", protocol }).returning();
    const [v1, v2] = await db().insert(versions).values([1, 2].map((number) => ({ studyId: s!.id, number, status: "draft" as const, documentIds: [], createdBy: "test" }))).returning();
    const [read] = await db().insert(reads).values({ versionId: v1!.id, budgetUsd: 1 }).returning();
    const ids = [
      (await log("Ana", "study.create", "study", s!.id)).id,
      (await log("Ana", "read.started", "read", read!.id, { studyId: s!.id, versionId: v1!.id, number: 1 })).id,
      (await log("Contract reader", "study.fill", "study", s!.id)).id,
      (await log("Ana Answerer", "version.answered", "version", v2!.id, { questionId: "q", option: 0, label: "Use the printed total" })).id,
      (await log("Ben Approver", "version.approved", "version", v2!.id, { number: 2 })).id,
      (await log("Ana", "document.upload", "document", randomUUID(), { studyId: s!.id, name: "named-by-detail.pdf" })).id,
    ];
    return { studyId: s!.id, ids };
  }

  it("lists a study's entries newest first with their contract and version resolved", async () => {
    const { studyId, ids } = await seed("P-100");
    await seed();
    const res = await get(`?study=${studyId}`);
    expect(res.statusCode).toBe(200);
    const { items, next } = res.json();
    expect(next).toBeNull();
    expect(items.map((i: { id: number }) => i.id)).toEqual([...ids].reverse());
    expect(items.map((i: { summary: string }) => i.summary)).toEqual([
      'Ana uploaded "named-by-detail.pdf"',
      "Ben Approver approved version 2 and made it live",
      'Ana Answerer answered a decision on version 2 with "Use the printed total"',
      "Contract reader finished reading the contract and filled in its details",
      "Ana started reading version 1",
      "Ana added a new contract",
    ]);
    expect(items.map((i: { versionNumber: number | null }) => i.versionNumber)).toEqual([null, 2, 2, null, 1, null]);
    expect(items.map((i: { kind: string }) => i.kind)).toEqual(["files", "approval", "decision", "reading", "reading", "other"]);
    for (const i of items) expect(i).toMatchObject({ studyId, studyTitle: "P-100", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
    expect(Object.keys(items[0]).sort()).toEqual(["at", "by", "id", "kind", "studyId", "studyTitle", "summary", "versionNumber"]);
  });

  it("titles a study without a protocol by its first document, else null", async () => {
    const { studyId } = await seed(null);
    expect((await get(`?study=${studyId}&limit=1`)).json().items[0].studyTitle).toBeNull();
    const [doc] = await db().insert(documents).values({ sha256: randomUUID(), name: "first.pdf", bytes: 1, pages: [], createdBy: "test" }).returning();
    await db().insert(studyDocuments).values({ studyId, documentId: doc!.id, addedBy: "test" });
    expect((await get(`?study=${studyId}&limit=1`)).json().items[0].studyTitle).toBe("first.pdf");
  });

  it("pages with before and next, and the all-studies feed includes entries with no contract", async () => {
    const { studyId, ids } = await seed();
    const first = (await get(`?study=${studyId}&limit=4`)).json();
    expect(first.items.map((i: { id: number }) => i.id)).toEqual(ids.slice(2).reverse());
    expect(first.next).toBe(ids[2]);
    const rest = (await get(`?study=${studyId}&limit=4&before=${first.next}`)).json();
    expect(rest.items.map((i: { id: number }) => i.id)).toEqual(ids.slice(0, 2).reverse());
    expect(rest.next).toBeNull();
    // a page that ends exactly at the last entry has no next
    expect((await get(`?study=${studyId}&limit=6`)).json().next).toBeNull();

    const orphan = await log("Ana", "party.create", "party", randomUUID(), { kind: "site", name: "Hosp" });
    const all = (await get("?limit=100")).json();
    const row = all.items.find((i: { id: number }) => i.id === orphan.id);
    expect(row).toMatchObject({ summary: 'Ana added the site "Hosp"', kind: "parties", studyId: null, studyTitle: null, versionNumber: null });
    expect(all.items.length).toBeLessThanOrEqual(100);
    expect((await get()).json().items.length).toBeLessThanOrEqual(30);
  });

  it("describes an action it doesn't know as something that changed, never by its code", async () => {
    const unknown = await log("Ana", "weird.thing", "party", randomUUID(), { secret: "hunter2" });
    const row = (await get("?limit=100")).json().items.find((i: { id: number }) => i.id === unknown.id);
    expect(row).toMatchObject({ summary: "Something changed", kind: "other" });
    expect(JSON.stringify(row)).not.toMatch(/weird|hunter2/);
  });

  it("refuses bad input in plain words", async () => {
    const msg = async (qs: string) => {
      const res = await get(qs);
      return [res.statusCode, res.json().message];
    };
    expect(await msg("?study=nope")).toEqual([400, "Pick a contract from the list."]);
    expect(await msg("?limit=0")).toEqual([400, "How many to show must be a whole number from 1 to 100."]);
    expect(await msg("?limit=101")).toEqual([400, "How many to show must be a whole number from 1 to 100."]);
    expect(await msg("?limit=2.5")).toEqual([400, "How many to show must be a whole number from 1 to 100."]);
    expect(await msg("?limit=abc")).toEqual([400, "How many to show must be a whole number from 1 to 100."]);
    expect(await msg("?before=abc")).toEqual([400, "The place to continue from must be a whole number."]);
    expect(await msg("?before=0")).toEqual([400, "The place to continue from must be a whole number."]);
  });
});
