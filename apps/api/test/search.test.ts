import type { AuditPage, MasterSearch, SearchResults, StudyCounts, StudyPage } from "@dct/shared";
import { sql } from "drizzle-orm";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { studies } from "../src/db/schema.js";
import { fakeControls } from "../src/extraction/fake.js";
import { type App, type Built, extract as extractJob, liveStudy as approved, newStudy as create, resetDb, settleAll, signOff, testApp } from "./helpers.js";

// ExcelJS is a dependency of @dct/shared only; load it from there to read the export back.
type Sheet = { name: string; getColumn(n: number): { values: unknown[] }; getRow(n: number): { getCell(n: number): { value: unknown } } };
type Workbook = { xlsx: { load(b: Buffer): Promise<unknown> }; worksheets: Sheet[] };
const ExcelJS = createRequire(path.resolve(import.meta.dirname, "../../../packages/shared/package.json"))("exceljs") as { Workbook: new () => Workbook };

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
const list = (qs = "") => get<StudyPage>(`/api/v1/studies${qs}`);
const protocols = (p: StudyPage) => p.items.map((s) => s.protocol);

type Seed = { protocol: string; status: string; needsYou?: number; siteName?: string | null; sponsor?: string; investigator?: string; daysAgo: number };
const day = 86_400_000;
const seed = (rows: Seed[]) =>
  built.ctx.db.insert(studies).values(rows.map(({ daysAgo, ...r }) => ({ needsYou: 0, siteName: null, ...r, updatedAt: new Date(Date.now() - daysAgo * day) })));

// one of each stage, two where the order inside a stage matters
const EIGHT: Seed[] = [
  { protocol: "NY-OLD", status: "needs_review", needsYou: 2, siteName: "Site A", sponsor: "Acme Pharma", investigator: "Dr. Rao", daysAgo: 5 },
  { protocol: "NY-NEW", status: "amendment_in_review", needsYou: 1, siteName: "Site B", sponsor: "Zen Bio", daysAgo: 1 },
  { protocol: "APPROVE", status: "needs_review", needsYou: 0, siteName: "Site A", sponsor: "Acme Pharma", daysAgo: 2 },
  { protocol: "FAILED", status: "extraction_failed", siteName: "Site B", daysAgo: 4 },
  { protocol: "SETUP", status: "setting_up", daysAgo: 6 },
  { protocol: "READING", status: "extracting", siteName: "Site A", daysAgo: 1 },
  { protocol: "LIVE-OLD", status: "live", siteName: "Site B", sponsor: "Zen Bio", daysAgo: 3 },
  { protocol: "LIVE-NEW", status: "live", siteName: "Site A", investigator: "Dr. Okafor", daysAgo: 1 },
];

describe("contract list", () => {
  it("orders by urgency: needs you oldest first, everything else newest first", async () => {
    await seed(EIGHT);
    const all = await list();
    expect(protocols(all)).toEqual(["NY-OLD", "NY-NEW", "FAILED", "SETUP", "APPROVE", "READING", "LIVE-NEW", "LIVE-OLD"]);
    expect(all).toMatchObject({ total: 8, nextCursor: null });
    expect(all.items[0]).toMatchObject({ needsYou: 2, liveVersion: null, siteName: "Site A" });
  });

  it("filters by view, site and every word of q", async () => {
    await seed(EIGHT);
    expect(protocols(await list("?view=needs-you"))).toEqual(["NY-OLD", "NY-NEW"]);
    expect(protocols(await list("?view=approval"))).toEqual(["APPROVE"]);
    expect(protocols(await list("?view=live"))).toEqual(["LIVE-NEW", "LIVE-OLD"]);
    expect(protocols(await list("?view=failed"))).toEqual(["FAILED"]);
    expect(protocols(await list("?site=Site%20A"))).toEqual(["NY-OLD", "APPROVE", "READING", "LIVE-NEW"]);
    expect(protocols(await list("?site=Site%20A&view=live"))).toEqual(["LIVE-NEW"]);
    expect(protocols(await list("?q=acme"))).toEqual(["NY-OLD", "APPROVE"]);
    expect(protocols(await list("?q=ACME%20rao"))).toEqual(["NY-OLD"]); // words can match different fields
    expect(protocols(await list("?q=zen%20live&site=Site%20B"))).toEqual(["LIVE-OLD"]);
    expect(protocols(await list("?q=okafor"))).toEqual(["LIVE-NEW"]);
    expect(await list("?q=%25")).toMatchObject({ items: [], total: 0 }); // % is a literal, not a wildcard
    expect((await list("?view=needs-you&q=new")).total).toBe(1);
    expect((await app.inject({ url: "/api/v1/studies?view=nope" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/studies?limit=0" })).statusCode).toBe(400);
  });

  it("pages with an opaque cursor: no duplicates or gaps, ties broken by id", async () => {
    const statuses = ["needs_review", "amendment_in_review", "extraction_failed", "setting_up", "extracting", "live", "needs_review"];
    // 4 distinct microsecond timestamps for 23 rows: lots of ties, and precision a JS Date can't hold
    await built.ctx.db.insert(studies).values(
      Array.from({ length: 23 }, (_, i) => ({
        protocol: `P-${i}`,
        status: statuses[i % statuses.length]!,
        needsYou: i % 2,
        siteName: i % 3 ? "Site A" : "Site B",
        updatedAt: sql`${`2026-01-01 00:00:00.12345${i % 4}+00`}::timestamptz`,
      })),
    );
    const walk = async (qs: string) => {
      const ids: string[] = [];
      let page = await list(`?limit=5${qs}`);
      ids.push(...page.items.map((s) => s.id));
      while (page.nextCursor) {
        expect(page.items).toHaveLength(5);
        page = await list(`?limit=5${qs}&cursor=${page.nextCursor}`);
        ids.push(...page.items.map((s) => s.id));
      }
      return { ids, total: page.total };
    };
    for (const qs of ["", "&site=Site%20A", "&view=needs-you", "&view=live", "&q=P-1"]) {
      const whole = await list(`?limit=100${qs}`);
      const paged = await walk(qs);
      expect(paged.ids).toEqual(whole.items.map((s) => s.id));
      expect(new Set(paged.ids).size).toBe(paged.ids.length);
      expect(paged.total).toBe(whole.total);
    }
    expect((await list("?limit=100")).total).toBe(23);
    expect((await app.inject({ url: "/api/v1/studies?cursor=bm9wZQ" })).statusCode).toBe(400);
  });

  it("counts per view and per site; site narrows the views, not the site list", async () => {
    await seed(EIGHT);
    const sites = [
      { name: "Site A", count: 4 },
      { name: "Site B", count: 3 },
    ];
    expect(await get<StudyCounts>("/api/v1/studies/counts")).toEqual({ all: 8, views: { "needs-you": 2, approval: 1, live: 2, failed: 1 }, sites });
    expect(await get<StudyCounts>("/api/v1/studies/counts?site=Site%20A")).toEqual({ all: 4, views: { "needs-you": 1, approval: 1, live: 1, failed: 0 }, sites });
  });
});

// ---- through the real workflow (fake extraction) ----

const newStudy = async (seedText: string) => (await create(app, seedText)).studyId;
const extract = (studyId: string) => extractJob(app, studyId);
const liveStudy = async (seedText = "live") => (await approved(built, seedText)).studyId;
const viewsNow = async () => (await get<StudyCounts>("/api/v1/studies/counts")).views;

describe("stored stage follows the workflow", () => {
  it("setting up → needs you → approval → live; a failed read is in failed", async () => {
    const id = await newStudy("flow");
    expect((await list()).items[0]).toMatchObject({ id, status: "setting_up", needsYou: 0 });
    await extract(id);
    // 8 for what didn't check out, 7 interpretations picked blind, 10 confirmed values re-typed blind (ADR-001 §6)
    expect((await list("?view=needs-you")).items[0]).toMatchObject({ id, needsYou: 25 });
    await settleAll(built, id, 1, "Asha", 24);
    expect((await list("?view=needs-you")).items[0]).toMatchObject({ id, needsYou: 1 });
    await settleAll(built, id, 1);
    expect(protocols(await list("?view=approval"))).toEqual(["SYN-001"]);
    await signOff(app, id, 1, { by: "Ben" });
    expect((await list("?view=live")).items[0]).toMatchObject({ id, liveVersion: 1, needsYou: 0 });

    const bad = await newStudy("bad");
    fakeControls.failNext = 1;
    await extract(bad);
    expect((await list("?view=failed")).items.map((s) => s.id)).toEqual([bad]);
    expect(await viewsNow()).toEqual({ "needs-you": 0, approval: 0, live: 1, failed: 1 });
  });
});

describe("global search", () => {
  it("finds contracts and rates in live versions, by words or by amount", async () => {
    const live = await liveStudy();
    const draft = await newStudy("draft"); // a draft's rates are not searched
    await extract(draft);
    const search = (q: string, extra = "") => get<SearchResults>(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`);

    const byName = await search("synthetic");
    expect(byName.contracts.map((s) => s.id).sort()).toEqual([live, draft].sort());
    expect(byName.rates).toEqual([]);

    const blood = await search("BLOOD draw");
    expect(blood.contracts).toEqual([]);
    expect(blood.rates).toEqual([
      { studyId: live, protocol: "SYN-001", sponsor: "Synthetic Pharma", version: 1, path: "/budgetGrids/0/procedures/0", kind: "procedure", name: "Blood draw", code: "36415", cents: 5500, detail: "Exhibit A" },
      { studyId: live, protocol: "SYN-001", sponsor: "Synthetic Pharma", version: 1, path: "/budgetGrids/1/procedures/0", kind: "procedure", name: "Blood draw", code: "36415", cents: 5500, detail: "Exhibit A (revised)" },
    ]);
    expect((await search("$55.00")).rates.map((r) => r.path)).toEqual(["/budgetGrids/0/procedures/0", "/budgetGrids/1/procedures/0"]);
    expect((await search("12,000")).rates).toEqual([expect.objectContaining({ kind: "fee", path: "/siteFees/0", name: "Administrative fee", cents: 1200000, detail: "On study initiation" })]);
    expect((await search("unsch")).rates).toEqual([expect.objectContaining({ kind: "invoiceable", path: "/invoiceables/0", code: "UNSCH", cents: 57200, detail: "per occurrence" })]);
    expect((await search("blood", "&limit=1")).rates).toHaveLength(1);
    expect(await search("  ")).toEqual({ contracts: [], rates: [] });
  });
});

describe("one invoicing master", () => {
  it("searches the version's items", async () => {
    const id = await liveStudy();
    const res = await get<MasterSearch>(`/api/v1/studies/${id}/versions/1/search?q=blood`);
    expect(res.q).toBe("blood");
    expect(res.hits).toEqual(expect.arrayContaining([{ path: "/budgetGrids/0/procedures/0", section: "grid", label: "Blood draw (36415)" }]));
    expect((await get<MasterSearch>(`/api/v1/studies/${id}/versions/1/search?q=572`)).hits).toEqual([{ path: "/invoiceables/0", section: "invoiceables", label: "Unscheduled visit" }]);
    expect((await app.inject({ url: `/api/v1/studies/${id}/versions/9/search?q=x` })).statusCode).toBe(404);
  });

  it("exports an xlsx workbook, named after the protocol, and logs it", async () => {
    const id = await liveStudy();
    // Once approved, the study's details are locked; the workbook is named and headed from the approved version.
    const edit = await app.inject({ method: "PATCH", url: `/api/v1/studies/${id}`, payload: { sponsor: "S", protocol: 'SYN/001 "b"', siteName: "Site A", investigator: "Dr. Test", by: "Asha" } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toMatch(/approved version, so its sponsor, protocol, site and investigator can't be changed/);
    const res = await app.inject({ url: `/api/v1/studies/${id}/versions/1/export.xlsx?by=Asha` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="SYN-001-v1-invoicing-master.xlsx"');
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from("PK\x03\x04"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Budget grid", "Fees & invoiceables", "Payment terms", "Bill by hand"]);
    const summary = wb.worksheets[0]!;
    const cell = (label: string) => summary.getColumn(1).values.indexOf(label);
    expect(summary.getRow(cell("Sponsor")).getCell(2).value).toBe("Synthetic Pharma");
    expect((await get<AuditPage>(`/api/v1/audit?studyId=${id}`)).items[0]).toMatchObject({ by: "Asha", action: "version.exported", detail: { version: 1, format: "xlsx" } });
  });

  it("exports only approved versions", async () => {
    const id = await newStudy("draft");
    await extract(id);
    expect((await app.inject({ url: `/api/v1/studies/${id}/versions/1/export.xlsx` })).statusCode).toBe(409);
  });

  it("404s when the version has no rulebook", async () => {
    const id = await newStudy("failed");
    fakeControls.failNext = 1;
    await extract(id);
    expect((await app.inject({ url: `/api/v1/studies/${id}/versions/1/export.xlsx` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/studies/${id}/versions/1/search?q=a` })).statusCode).toBe(404);
  });
});

describe("activity log", () => {
  const audit = async (qs: string) => {
    const res = await app.inject({ url: `/api/v1/audit${qs}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AuditPage>();
  };

  it("pages newest first with an opaque cursor: no duplicates or gaps", async () => {
    await liveStudy();
    await newStudy("other");
    const all = (await audit("?limit=100")).items;
    expect(all.length).toBeGreaterThan(10);
    expect(all.map((e) => Number(e.id))).toEqual([...all.map((e) => Number(e.id))].sort((a, b) => b - a));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AuditPage = await audit(`?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((e) => e.id));
    expect((await app.inject({ url: "/api/v1/audit?cursor=nope" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/audit?limit=500" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/audit?studyId=nope" })).json()).toMatchObject({ statusCode: 400, message: "Malformed id" });
  });

  it("narrows to one contract, names it, and searches the person, the action and the details on the server", async () => {
    const id = await liveStudy();
    const other = await newStudy("other");
    const mine = (await audit(`?studyId=${id}&limit=100`)).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.studyId === id && e.protocol === "SYN-001" && e.sponsor === "Synthetic Pharma")).toBe(true);
    expect(mine.map((e) => e.studyId)).not.toContain(other);
    const actions = async (q: string, qs = "") => (await audit(`?q=${encodeURIComponent(q)}&limit=100${qs}`)).items.map((e) => e.action);
    expect(await actions("ben")).toEqual(["version.signed"]); // the person
    expect(await actions("Approved")).toEqual(["version.signed"]); // what the action is called
    expect(await actions("version.signed")).toEqual(["version.signed"]); // its code
    expect(await actions("ben approved")).toEqual(["version.signed"]); // every word
    expect(await actions("asha approved")).toEqual([]);
    expect(new Set(await actions("Synthetic"))).toEqual(new Set(["study.identified"])); // the details: the study guess
    expect(await actions("synthetic", `&studyId=${other}`)).toEqual(["study.identified"]);
    expect(await actions("100%_")).toEqual([]); // wildcards are literal
    // settings changes belong to no contract
    await app.inject({ method: "PATCH", url: "/api/v1/settings", payload: { makerChecker: true, by: "Morgan" } });
    expect((await audit("?q=settings")).items[0]).toMatchObject({ action: "settings.updated", studyId: null, protocol: null, sponsor: null });
  });
});
