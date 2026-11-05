import { HttpError } from "../src/lib/http.js";
import type { ModelClient, Reader } from "@dct/harness";
import { pdfReader } from "@dct/harness";
import { eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { auditLog, documents, parties, reads, studies, studyDocuments, versions, type PageInfo } from "../src/db/schema.js";
import { savePdf } from "../src/lib/storage.js";
import type { Models } from "../src/jobs/models.js";
import { type Built, noOcr } from "./helpers.js";

// Reading a contract as a background job, with fake models: nothing here can reach a real one.

const CLAUSE = "Startup fee of $500.00 is payable on signature.";
const FILLER = "This page carries ordinary contract wording so that it has a real text layer and is not mistaken for a scan.";

let built: Built;
let models: () => Models = () => {
  throw new Error("this test set no models");
};
let modelCalls = 0;
const extra: Built[] = [];

/** Another app on the same database, as a restart or a server with no keys; closed after the test, so it never takes a job meant for `built`. */
const start = async (opts: Parameters<typeof buildApp>[0] = {}) => {
  const b = await buildApp({ ocr: noOcr, ...opts });
  extra.push(b);
  return b;
};
const use = (m: Models) => (models = () => m);

type ModelMessage = Awaited<ReturnType<ReturnType<ModelClient["beta"]["messages"]["stream"]>["finalMessage"]>>;
type Block = Record<string, unknown>;
let nextId = 0;
const call = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `tu_${++nextId}`, name, input });
const reply = (...content: Block[]) =>
  ({
    id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: "tool_use",
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as ModelMessage;

const study = { protocol: "P-1", sponsor: "Acme Pharma", siteEntity: "Site LLC", documents: [{ doc: "CTA.pdf", role: "cta" }] };
const startup = { id: "t1", category: "site_fee", name: "Startup fee", amount: "$500.00", unit: "one time", billing: "invoice", source: { doc: "CTA.pdf", page: 1, quote: "Startup fee of $500.00 is payable on signature" } };
const goodScript = (st: object = study) => [reply(call("put_study", { study: st })), reply(call("put_terms", { terms: [startup] })), reply(call("finish"))];

/** A compile model that plays the script, one reply per call; a step can be a function (wait, or fail) instead. */
function scripted(script: (ModelMessage | (() => Promise<ModelMessage>))[]): ModelClient {
  return {
    beta: {
      messages: {
        stream() {
          modelCalls++;
          const next = script.shift();
          if (!next) throw new Error("the script has no more replies");
          return { finalMessage: async () => (typeof next === "function" ? next() : next) };
        },
      },
    },
  };
}

const reader = (model: string, answers: Record<string, unknown>): Reader => ({
  model,
  price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
  async ask<T>(req: { name: string }) {
    modelCalls++;
    return { value: answers[req.name] as T, model, usd: 0.25 };
  },
});

const fakes = (script: Parameters<typeof scripted>[0] = goodScript()): Models => ({
  anthropic: scripted(script),
  claude: reader("claude-sonnet-5-5", {}),
  openai: reader("fake-openai", { review: { findings: [] } }),
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dct-reads-"));
  built = await buildApp({ models: () => models(), ocr: noOcr });
});
afterEach(async () => {
  await Promise.all(extra.splice(0).map((b) => b.app.close()));
});
afterAll(() => built.app.close());

async function pdf(name: string, lines = [CLAUSE, FILLER, FILLER]) {
  const file = await PDFDocument.create();
  const font = await file.embedFont(StandardFonts.Helvetica);
  const page = file.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(`${line} (${name})`, { x: 40, y: 740 - i * 16, size: 9, font }));
  return Buffer.from(await file.save());
}

/** A study with one stored contract (a text PDF, or pages marked as scans), seeded straight into the database. */
async function seedStudy(opts: { name?: string; scanned?: "image" | "ocr"; ocrStatus?: "queued" | "running" | "failed"; none?: boolean } = {}) {
  const { db } = built.ctx;
  const name = opts.name ?? "CTA.pdf";
  const [s] = await db.insert(studies).values({ createdBy: "test" }).returning();
  if (opts.none) return s!;
  const data = await pdf(`${name}${nextId++}`);
  const file = path.join(dir, "seed.pdf");
  await writeFile(file, data);
  const loaded = await pdfReader.load(file);
  const pages: PageInfo[] = loaded.pages.map((p) => ({ page: p.page, kind: opts.scanned ?? p.kind, chars: p.raw.length, firstLine: p.firstLine, confidence: null }));
  const hash = await savePdf(data);
  const [doc] = await db.insert(documents).values({ sha256: hash, name, bytes: data.length, pages, ocrStatus: opts.ocrStatus, ocrError: opts.ocrStatus === "failed" ? "The scanned pages couldn't be read. Upload the file again to try once more." : null, createdBy: "test" }).returning();
  await db.insert(studyDocuments).values({ studyId: s!.id, documentId: doc!.id, addedBy: "test" });
  return s!;
}

const post = (b: Built, studyId: string, body: unknown = { by: "Asha" }) => b.app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/reads`, payload: body as object });
const get = async (b: Built, readId: string) => (await b.app.inject({ url: `/api/v1/reads/${readId}` })).json();

async function finished(b: Built, readId: string) {
  for (let i = 0; i < 400; i++) {
    const r = await get(b, readId);
    if (r.status === "done" || r.status === "failed") return r;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the read never finished");
}

const versionOf = async (id: string) => (await built.ctx.db.select().from(versions).where(eq(versions.id, id)))[0]!;

describe("starting a read", () => {
  it("reads in the background to a draft, with progress, spend, a trace and an audit entry", async () => {
    const s = await seedStudy();
    use(fakes());
    const res = await post(built, s.id);
    expect(res.statusCode).toBe(202);
    const { readId, versionId } = res.json();
    expect(await versionOf(versionId)).toMatchObject({ status: expect.stringMatching(/reading|draft/), number: 1, createdBy: "Asha" });

    const read = await finished(built, readId);
    expect(read).toMatchObject({ id: readId, versionId, status: "done", budgetUsd: 3, error: null });
    expect(read.spentUsd).toBeGreaterThan(0.25);
    expect(read.startedAt).toBeTruthy();
    expect(read.finishedAt).toBeTruthy();
    expect(read).not.toHaveProperty("trace");
    expect(read.progress.length).toBeGreaterThan(3);
    expect(read.progress.findIndex((l: string) => l.startsWith("Second reader"))).toBeGreaterThan(0);

    const version = await versionOf(versionId);
    expect(version.status).toBe("draft");
    expect(version.rulebook!.terms.map((t) => t.id)).toEqual(["t1"]);
    expect(version.problems).toEqual([]);
    const [row] = await built.ctx.db.select().from(reads).where(eq(reads.id, readId));
    expect(row!.trace).toMatchObject({ compile: expect.any(Array), log: read.progress });

    const entries = await built.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, readId));
    expect(entries).toMatchObject([{ by: "Asha", action: "read.started", entity: "read", detail: { studyId: s.id, versionId, number: 1, budgetUsd: 3 } }]);
  });

  it("numbers the next read one higher once the first has failed", async () => {
    const s = await seedStudy();
    use(fakes([() => Promise.reject(new Error("overloaded"))]));
    const first = (await post(built, s.id)).json();
    expect((await finished(built, first.readId)).status).toBe("failed");
    use(fakes());
    const second = (await post(built, s.id)).json();
    expect((await finished(built, second.readId)).status).toBe("done");
    expect((await versionOf(second.versionId)).number).toBe(2);
  });

  it("refuses a study that doesn't exist, has no contract, or a missing name", async () => {
    use(fakes());
    expect((await post(built, "5b4c3a2d-1111-4222-8333-444455556666")).json().message).toBe("There is no such study.");
    const empty = await seedStudy({ none: true });
    const res = await post(built, empty.id);
    expect([res.statusCode, res.json().message]).toEqual([409, "Upload the contract first."]);
    const s = await seedStudy();
    expect((await post(built, s.id, {})).statusCode).toBe(400);
    expect((await post(built, s.id, { by: " " })).json().message).toMatch(/pick your name/);
  });

  it.each(["queued", "running"] as const)("won't start while a scanned document is %s for OCR, and sends nothing to a model or saves nothing", async (ocrStatus) => {
    const s = await seedStudy({ name: "Scan.pdf", scanned: "image", ocrStatus });
    use(fakes());
    const before = modelCalls;
    const res = await post(built, s.id);
    expect([res.statusCode, res.json().message]).toEqual([409, "Some pages are still being prepared (OCR). Reading can start when they're done."]);
    expect(modelCalls).toBe(before);
    expect(await built.ctx.db.select().from(versions).where(eq(versions.studyId, s.id))).toEqual([]);
  });

  it("won't start when a scanned document's OCR failed, naming it with the reason and the way forward", async () => {
    const s = await seedStudy({ name: "Scan.pdf", scanned: "image", ocrStatus: "failed" });
    use(fakes());
    const before = modelCalls;
    const res = await post(built, s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Scan.pdf: The scanned pages couldn't be read. Upload the file again");
    expect(modelCalls).toBe(before);
  });

  it("starts when every scanned page has been read with OCR", async () => {
    const s = await seedStudy({ scanned: "ocr" });
    use(fakes());
    const res = await post(built, s.id);
    expect(res.statusCode).toBe(202);
    expect((await finished(built, res.json().readId)).status).toBe("done");
  });

  it("says plainly that reading isn't set up when the keys are missing, and saves nothing", async () => {
    const bare = await start();
    const s = await seedStudy();
    const res = await post(bare, s.id);
    expect([res.statusCode, res.json().message]).toEqual([503, "Reading isn't set up yet: the Anthropic key is missing. Add ANTHROPIC_API_KEY to .env and restart."]);
    expect(await built.ctx.db.select().from(versions).where(eq(versions.studyId, s.id))).toEqual([]);
  });

  it("refuses a second read of a study while one is running, then allows one after it ends", async () => {
    const s = await seedStudy();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    use(fakes([async () => (await gate, reply(call("put_study", { study }))), reply(call("put_terms", { terms: [startup] })), reply(call("finish"))]));
    const first = (await post(built, s.id)).json();
    try {
      const second = await post(built, s.id);
      expect([second.statusCode, second.json().message]).toEqual([409, "This contract is already being read."]);
      expect(await built.ctx.db.select().from(versions).where(eq(versions.studyId, s.id))).toHaveLength(1);
    } finally {
      release();
    }
    expect((await finished(built, first.readId)).status).toBe("done");
    use(fakes());
    const again = await post(built, s.id);
    expect(again.statusCode).toBe(202);
    await finished(built, again.json().readId);
  });
});

describe("filling the study from the contract", () => {
  const unique = () => Math.random().toString(36).slice(2, 10);
  const studyOf = async (id: string) => (await built.ctx.db.select().from(studies).where(eq(studies.id, id)))[0]!;
  const party = async (id: string | null) => (await built.ctx.db.select().from(parties).where(eq(parties.id, id!)))[0];

  it("fills the protocol and links new parties it creates, leaving the payer empty when the contract names none", async () => {
    const tag = unique();
    const s = await seedStudy();
    expect(await studyOf(s.id)).toMatchObject({ protocol: null, sponsorId: null, payerId: null, siteId: null });
    use(fakes(goodScript({ ...study, sponsor: `Acme Pharma ${tag}`, siteEntity: `Site LLC ${tag}` })));
    const { readId } = (await post(built, s.id)).json();
    expect((await finished(built, readId)).status).toBe("done");

    const filled = await studyOf(s.id);
    expect(filled).toMatchObject({ protocol: "P-1", payerId: null });
    expect(await party(filled.sponsorId)).toMatchObject({ kind: "sponsor", name: `Acme Pharma ${tag}`, createdBy: "Contract reader" });
    expect(await party(filled.siteId)).toMatchObject({ kind: "site", name: `Site LLC ${tag}`, createdBy: "Contract reader" });
    const entries = await built.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, s.id));
    expect(entries.filter((e) => e.action === "study.fill")).toMatchObject([{ by: "Contract reader", detail: { protocol: "P-1", payerId: null } }]);
    expect((await built.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, filled.sponsorId!))).map((e) => e.action)).toEqual(["party.create"]);
  });

  it("links the record a name or alias already matches, of the same kind only", async () => {
    const tag = unique();
    const { db } = built.ctx;
    const [sponsor] = await db.insert(parties).values({ kind: "sponsor", name: `Merck ${tag}`, aliases: [`Acme Pharma Inc. ${tag}`], createdBy: "test" }).returning();
    const [cro] = await db.insert(parties).values({ kind: "cro", name: `Quintiles ${tag}`, createdBy: "test" }).returning();
    const [wrongKind] = await db.insert(parties).values({ kind: "cro", name: `Site LLC ${tag}`, createdBy: "test" }).returning();
    const s = await seedStudy();
    use(fakes(goodScript({ ...study, sponsor: `ACME PHARMA, INC ${tag}`, payer: `quintiles ${tag}`, siteEntity: `Site LLC ${tag}` })));
    expect((await finished(built, (await post(built, s.id)).json().readId)).status).toBe("done");

    const filled = await studyOf(s.id);
    expect([filled.sponsorId, filled.payerId]).toEqual([sponsor!.id, cro!.id]);
    expect(filled.siteId).not.toBe(wrongKind!.id);
    expect(await party(filled.siteId)).toMatchObject({ kind: "site", createdBy: "Contract reader" });
  });

  it("leaves a link empty when the contract's name is blank", async () => {
    const s = await seedStudy();
    use(fakes(goodScript({ ...study, sponsor: `Acme Pharma ${unique()}`, payer: "  ", siteEntity: "&&&" })));
    expect((await finished(built, (await post(built, s.id)).json().readId)).status).toBe("done");
    expect(await studyOf(s.id)).toMatchObject({ payerId: null, siteId: null, sponsorId: expect.any(String) });
  });

  it("leaves the study as it was when the read fails", async () => {
    const s = await seedStudy();
    const sponsor = `Acme Pharma ${unique()}`;
    use(fakes([reply(call("put_study", { study: { ...study, sponsor } })), () => Promise.reject(new Error("overloaded"))]));
    expect((await finished(built, (await post(built, s.id)).json().readId)).status).toBe("failed");
    expect(await studyOf(s.id)).toMatchObject({ protocol: null, sponsorId: null, payerId: null, siteId: null });
    expect(await built.ctx.db.select().from(parties).where(eq(parties.name, sponsor))).toEqual([]);
  });
});

describe("a read that fails", () => {
  it("fails the read and its version, and says so, when it can't be queued", async () => {
    const s = await seedStudy();
    const send = vi.spyOn(built.ctx.boss, "send").mockRejectedValueOnce(new Error("connection lost"));
    const res = await post(built, s.id);
    send.mockRestore();
    expect([res.statusCode, res.json().message]).toEqual([503, "The read couldn't be started. Try again; if it keeps happening, tell the team."]);
    const [version] = await built.ctx.db.select().from(versions).where(eq(versions.studyId, s.id));
    const [read] = await built.ctx.db.select().from(reads).where(eq(reads.versionId, version!.id));
    expect([version!.status, read!.status, read!.error]).toEqual(["failed", "failed", "The read couldn't be started. Try again; if it keeps happening, tell the team."]);
  });

  it("keeps the spend and says in plain words why, when the model stops answering", async () => {
    const s = await seedStudy();
    use(fakes([reply(call("put_study", { study })), () => Promise.reject(new Error("529 overloaded_error req_123"))]));
    const { readId, versionId } = (await post(built, s.id)).json();
    const read = await finished(built, readId);
    expect(read.status).toBe("failed");
    expect(read.error).toBe("The model stopped answering part way through, so nothing was kept. Start the read again.");
    expect(read.spentUsd).toBeGreaterThan(0);
    const version = await versionOf(versionId);
    expect([version.status, version.rulebook]).toEqual(["failed", null]);
  });

  it("says so when the spending limit is reached", async () => {
    const s = await seedStudy();
    const big = { ...reply(call("put_study", { study })), usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    use(fakes([big as unknown as ModelMessage]));
    const read = await finished(built, (await post(built, s.id)).json().readId);
    expect(read.status).toBe("failed");
    expect(read.error).toMatch(/spending limit of \$3\.00/);
    expect(read.spentUsd).toBeGreaterThan(3);
  });

  it("passes a setup error on, and hides any other behind a generic message", async () => {
    const s = await seedStudy();
    let calls = 0;
    models = () => {
      if (++calls > 1) throw new HttpError(503, "The Anthropic key was rejected. Check ANTHROPIC_API_KEY.");
      return fakes();
    };
    const plain = await finished(built, (await post(built, s.id)).json().readId);
    expect([plain.status, plain.error]).toEqual(["failed", "The Anthropic key was rejected. Check ANTHROPIC_API_KEY."]);

    const t = await seedStudy();
    calls = 0;
    models = () => {
      if (++calls > 1) throw new TypeError("password=hunter2 at row $9,999.00");
      return fakes();
    };
    const hidden = await finished(built, (await post(built, t.id)).json().readId);
    expect(hidden.status).toBe("failed");
    expect(hidden.error).toMatch(/problem on the server/);
    expect(JSON.stringify(hidden)).not.toContain("hunter2");
  });
});

describe("recovery when the server starts", () => {
  const seedRead = async (status: "queued" | "running") => {
    const s = await seedStudy();
    const [v] = await built.ctx.db.insert(versions).values({ studyId: s.id, number: 1, status: "reading", documentIds: [], createdBy: "test" }).returning();
    const [r] = await built.ctx.db.insert(reads).values({ versionId: v!.id, status, budgetUsd: 3 }).returning();
    return { read: r!, version: v! };
  };

  it("fails a read the dead process left running, and a queued one with no job; leaves a queued one whose job exists", async () => {
    const running = await seedRead("running");
    const lost = await seedRead("queued");
    const waiting = await seedRead("queued");
    await built.ctx.boss.send("read", { readId: waiting.read.id }, { startAfter: 3600 });

    const restarted = await start({ models: () => models() });
    const status = async (x: { read: { id: string }; version: { id: string } }) => [(await get(restarted, x.read.id)).status, (await versionOf(x.version.id)).status];
    expect(await status(running)).toEqual(["failed", "failed"]);
    expect((await get(restarted, running.read.id)).error).toBe("The server stopped while this contract was being read. Start the read again.");
    expect(await status(lost)).toEqual(["failed", "failed"]);
    expect(await status(waiting)).toEqual(["queued", "reading"]);

    const [job] = await built.ctx.boss.findJobs("read", { data: { readId: waiting.read.id } });
    await built.ctx.boss.cancel("read", job!.id);
    await built.ctx.db.update(reads).set({ status: "failed" }).where(eq(reads.id, waiting.read.id));
    await built.ctx.db.update(versions).set({ status: "failed" }).where(eq(versions.id, waiting.version.id));
  });
});

describe("reading one", () => {
  it("is a 404 for a read that doesn't exist and a 400 for a malformed id", async () => {
    expect((await built.app.inject({ url: "/api/v1/reads/5b4c3a2d-1111-4222-8333-444455556666" })).json().message).toBe("There is no such read.");
    expect((await built.app.inject({ url: "/api/v1/reads/nope" })).statusCode).toBe(400);
  });
});
