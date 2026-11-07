import { randomUUID } from "node:crypto";
import type { Study } from "@dct/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, parties, studies } from "../src/db/schema.js";
import { fillStudy } from "../src/lib/parties.js";
import { type App, type Built, testApp } from "./helpers.js";

let built: Built;
let app: App;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());

const db = () => built.ctx.db;
const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url: `/api/v1${url}`, payload });
const tag = () => randomUUID().slice(0, 8);
const party = async (kind: string, name: string, aliases?: string[]) => (await call("POST", "/parties", { kind, name, aliases, by: "Asha" })).json() as { id: string; name: string; aliases: string[]; kind: string };
const study = async (slots: Partial<typeof studies.$inferInsert> = {}) => (await db().insert(studies).values({ createdBy: "test", ...slots }).returning())[0]!;
const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);
const listed = async (id: string) => ((await call("GET", "/parties")).json() as { id: string; studies: number }[]).find((p) => p.id === id);

describe("GET /parties", () => {
  it("counts the studies using a party once each, whatever the role", async () => {
    const p = await party("sponsor", `Count ${tag()}`);
    expect((await listed(p.id))!.studies).toBe(0);
    await study({ sponsorId: p.id });
    await study({ sponsorId: p.id, payerId: p.id, siteId: p.id });
    await study();
    expect((await listed(p.id))!.studies).toBe(2);
  });
});

describe("PATCH /parties/:id", () => {
  it("renames, keeps the old name as an alias, and a later read of the old wording still finds the party", async () => {
    const t = tag();
    const p = await party("sponsor", `Old Pharma ${t}`, [`OP ${t}`]);
    const res = await call("PATCH", `/parties/${p.id}`, { name: `  New Pharma ${t}  `, by: "Asha" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: p.id, name: `New Pharma ${t}`, aliases: [`OP ${t}`, `Old Pharma ${t}`] });
    expect((await audits(p.id)).at(-1)).toMatchObject({ action: "party.rename", by: "Asha", detail: { from: `Old Pharma ${t}`, to: `New Pharma ${t}` } });

    const s = await study();
    await db().transaction((tx) => fillStudy(tx, s.id, { protocol: "P-1", sponsor: `Old Pharma ${t}`, payer: null, siteEntity: null } as unknown as Study));
    expect((await db().select().from(studies).where(eq(studies.id, s.id)))[0]!.sponsorId).toBe(p.id);
  });

  it("lets a party take back one of its own aliases, or change only its letter case, without duplicating names", async () => {
    const t = tag();
    const p = await party("site", `Mary Hospital ${t}`, [`St Mary ${t}`]);
    const swapped = (await call("PATCH", `/parties/${p.id}`, { name: `ST. MARY ${t}`, by: "Asha" })).json();
    expect(swapped).toMatchObject({ name: `ST. MARY ${t}`, aliases: [`Mary Hospital ${t}`] });
    const recased = (await call("PATCH", `/parties/${p.id}`, { name: `st mary ${t}`, by: "Asha" })).json();
    expect(recased).toMatchObject({ name: `st mary ${t}`, aliases: [`Mary Hospital ${t}`] });
  });

  it("refuses a name another party of the same kind already has, but not one of another kind", async () => {
    const t = tag();
    const a = await party("site", `Alpha ${t}`);
    await party("site", `Beta ${t}`, [`B-Hospital ${t}`]);
    await party("cro", `Gamma ${t}`);
    const byName = await call("PATCH", `/parties/${a.id}`, { name: `beta ${t}`, by: "Asha" });
    expect([byName.statusCode, byName.json().message]).toEqual([409, `"Beta ${t}" is already the name of a different site in your list. Merge the two instead of renaming.`]);
    const byAlias = await call("PATCH", `/parties/${a.id}`, { name: `B Hospital ${t}`, by: "Asha" });
    expect([byAlias.statusCode, byAlias.json().message]).toEqual([409, `"Beta ${t}" is already another name for a different site in your list. Merge the two instead of renaming.`]);
    expect((await call("PATCH", `/parties/${a.id}`, { name: `Gamma ${t}`, by: "Asha" })).statusCode).toBe(200);
    expect((await db().select().from(parties).where(eq(parties.id, a.id)))[0]!.name).toBe(`Gamma ${t}`);
  });

  it("refuses a missing party, a bad name and a missing person in plain words", async () => {
    const p = await party("site", `Hosp ${tag()}`);
    const missing = await call("PATCH", `/parties/${randomUUID()}`, { name: "X", by: "Asha" });
    expect([missing.statusCode, missing.json().message]).toEqual([404, "That party doesn't exist."]);
    expect((await call("PATCH", `/parties/${p.id}`, { by: "Asha" })).json().message).toBe("Give a name.");
    expect((await call("PATCH", `/parties/${p.id}`, { name: "&&&", by: "Asha" })).json().message).toBe("A name needs at least one letter or digit.");
    expect((await call("PATCH", `/parties/${p.id}`, { name: "x".repeat(201), by: "Asha" })).json().message).toBe("That name is too long.");
    expect((await call("PATCH", `/parties/${p.id}`, { name: "X" })).json().message).toBe("Say who is doing this: pick your name first.");
    expect((await call("PATCH", "/parties/nope", { name: "X", by: "Asha" })).statusCode).toBe(400);
  });
});

describe("POST /parties/:id/merge", () => {
  it("moves every study in every role, folds in names and aliases once, removes the party, and a later read finds the survivor", async () => {
    const t = tag();
    const from = await party("sponsor", `Acme Pharma Inc ${t}`, [`ACME ${t}`, `Shared ${t}`]);
    const into = await party("sponsor", `Acme ${t}`, [`shared. ${t}`]);
    const [s1, s2, s3, other] = [await study({ sponsorId: from.id }), await study({ sponsorId: from.id, payerId: from.id }), await study({ siteId: from.id }), await study({ sponsorId: into.id })];

    const res = await call("POST", `/parties/${from.id}/merge`, { into: into.id, by: "Asha" });
    expect(res.statusCode).toBe(200);
    // "ACME <tag>" has the survivor's own name once normalised, so it is not an alias; "Shared" is there once
    expect(res.json()).toMatchObject({ id: into.id, name: `Acme ${t}`, aliases: [`shared. ${t}`, `Acme Pharma Inc ${t}`] });

    const slots = async (id: string) => (await db().select().from(studies).where(eq(studies.id, id)))[0]!;
    expect(await slots(s1.id)).toMatchObject({ sponsorId: into.id });
    expect(await slots(s2.id)).toMatchObject({ sponsorId: into.id, payerId: into.id });
    expect(await slots(s3.id)).toMatchObject({ siteId: into.id });
    expect(await slots(other.id)).toMatchObject({ sponsorId: into.id });
    expect(await db().select().from(parties).where(eq(parties.id, from.id))).toEqual([]);
    expect((await audits(into.id)).at(-1)).toMatchObject({ action: "party.merge", by: "Asha", detail: { from: `Acme Pharma Inc ${t}`, into: `Acme ${t}`, studies: 3 } });
    expect((await listed(into.id))!.studies).toBe(4);

    await db().transaction((tx) => fillStudy(tx, other.id, { protocol: "P-2", sponsor: `Acme Pharma Inc. ${t}`, payer: null, siteEntity: null } as unknown as Study));
    expect((await slots(other.id)).sponsorId).toBe(into.id);
  });

  it("refuses itself, another kind, a missing party and a bad request in plain words", async () => {
    const t = tag();
    const site = await party("site", `Site ${t}`);
    const other = await party("site", `Other ${t}`);
    const cro = await party("cro", `Cro ${t}`);
    const self = await call("POST", `/parties/${site.id}/merge`, { into: site.id, by: "Asha" });
    expect([self.statusCode, self.json().message]).toEqual([400, "A party can't be merged into itself. Pick a different one."]);
    const kind = await call("POST", `/parties/${site.id}/merge`, { into: cro.id, by: "Asha" });
    expect([kind.statusCode, kind.json().message]).toEqual([400, `"Site ${t}" is a site and "Cro ${t}" is a CRO. Only two of the same kind can be merged.`]);
    const gone = await call("POST", `/parties/${randomUUID()}/merge`, { into: site.id, by: "Asha" });
    expect([gone.statusCode, gone.json().message]).toEqual([404, "That party doesn't exist."]);
    const noTarget = await call("POST", `/parties/${site.id}/merge`, { into: randomUUID(), by: "Asha" });
    expect([noTarget.statusCode, noTarget.json().message]).toEqual([404, "The party to merge into doesn't exist."]);
    expect((await call("POST", `/parties/${site.id}/merge`, { by: "Asha" })).json().message).toBe("Pick the party to merge into.");
    expect((await call("POST", `/parties/${site.id}/merge`, { into: "nope", by: "Asha" })).json().message).toBe("Pick the party to merge into.");
    expect((await call("POST", `/parties/${site.id}/merge`, { into: other.id })).json().message).toBe("Say who is doing this: pick your name first.");
    // nothing above changed anything
    expect((await db().select().from(parties).where(eq(parties.id, site.id))).length).toBe(1);
  });
});

describe("PATCH /studies/:id/parties", () => {
  it("sets, clears and keeps slots, returns the study as GET does, and audits what changed", async () => {
    const t = tag();
    const [sponsor, cro, site] = [await party("sponsor", `Sp ${t}`), await party("cro", `Cro ${t}`), await party("site", `Site ${t}`)];
    const s = await study({ siteId: site.id });
    const res = await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: sponsor.id, payerId: cro.id, siteId: null, by: "Asha" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual((await call("GET", `/studies/${s.id}`)).json());
    expect(res.json()).toMatchObject({ sponsorId: sponsor.id, payerId: cro.id, siteId: null, sponsor: { name: `Sp ${t}` }, payer: { name: `Cro ${t}` }, site: null });
    expect((await audits(s.id)).at(-1)).toMatchObject({ action: "study.parties", by: "Asha", detail: { studyId: s.id, set: { sponsor: `Sp ${t}`, payer: `Cro ${t}`, site: null } } });

    // a slot left out is kept; an unchanged one leaves nothing in the log
    const before = (await audits(s.id)).length;
    const kept = await call("PATCH", `/studies/${s.id}/parties`, { payerId: cro.id, by: "Asha" });
    expect(kept.json()).toMatchObject({ sponsorId: sponsor.id, payerId: cro.id });
    expect((await audits(s.id)).length).toBe(before);
  });

  it("refuses a party of the wrong kind, a missing one, a missing study and a bad request in plain words", async () => {
    const t = tag();
    const [sponsor, cro] = [await party("sponsor", `Sp ${t}`), await party("cro", `Cro ${t}`)];
    const s = await study();
    const wrong = await call("PATCH", `/studies/${s.id}/parties`, { siteId: sponsor.id, by: "Asha" });
    expect([wrong.statusCode, wrong.json().message]).toEqual([400, `"Sp ${t}" is a sponsor, so it can't be this contract's site. Pick a site from the list.`]);
    const wrongPayer = await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: cro.id, by: "Asha" });
    expect(wrongPayer.json().message).toBe(`"Cro ${t}" is a CRO, so it can't be this contract's sponsor. Pick a sponsor from the list.`);
    const gone = await call("PATCH", `/studies/${s.id}/parties`, { payerId: randomUUID(), by: "Asha" });
    expect([gone.statusCode, gone.json().message]).toEqual([400, "That CRO doesn't exist. Pick one from the list."]);
    expect((await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: "nope", by: "Asha" })).json().message).toBe("Pick a sponsor from the list, or leave it empty.");
    expect((await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: 5, by: "Asha" })).json().message).toBe("Pick a sponsor from the list, or leave it empty.");
    expect((await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: sponsor.id })).json().message).toBe("Say who is doing this: pick your name first.");
    const missing = await call("PATCH", `/studies/${randomUUID()}/parties`, { by: "Asha" });
    expect([missing.statusCode, missing.json().message]).toEqual([404, "That study doesn't exist. Go back to the study list and pick it again."]);
    // a refusal changed nothing, even when another slot in the same request was fine
    await call("PATCH", `/studies/${s.id}/parties`, { sponsorId: sponsor.id, siteId: sponsor.id, by: "Asha" });
    expect((await db().select().from(studies).where(eq(studies.id, s.id)))[0]).toMatchObject({ sponsorId: null, siteId: null });
  });
});
