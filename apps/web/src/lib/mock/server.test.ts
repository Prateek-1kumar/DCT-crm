import { describe, expect, it, beforeEach, vi } from "vitest";
import { AlertPage, AuditPage, DiffEntry, MasterSearch, type ReviewItem, RulebookVersionDto, SAMPLE, SearchResults, StudyCounts, StudyDetailDto, StudyPage } from "@dct/shared";
import { blankInvoiceable } from "../byhand";
import { getAt } from "../pointer";
import { askAbout, makeRulebook, mockSampling, SEEDS } from "./fixtures";
import { mockRequest, mockReset } from "./server";

// The blind sample without shuffling, as the API tests pin it: in evidence order, a family at a time.
mockSampling.random = () => 1 - 2 ** -32;
/** What Northwind's master holds (the sample server reads it right, except where a question says otherwise). */
const NW = makeRulebook(SEEDS.northwind.cfg!);
const sampleOf = (v: RulebookVersionDto, test: (path: string) => boolean) => v.review.find((i) => i.reason === SAMPLE && test(i.path!))!;

const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const list = async (q = "") => StudyPage.parse(await get(`/studies?limit=100${q}`)).items;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const answer = async (study: string, item: string, body: Record<string, unknown>, v = 1) =>
  RulebookVersionDto.parse((await post(`/studies/${study}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam Rivera", ...body })).json);
/** Approval as the approve page sends it: with the version as `by` last saw it. */
const signOff = async (study: string, v: number, by: string) =>
  post(`/studies/${study}/versions/${v}/sign-off`, { by, asOf: RulebookVersionDto.parse(await get(`/studies/${study}/versions/${v}`)).updatedAt });
/**
 * Settles a question: the first option (with a note), or a value; on a differs, what was read (shown now), with a note,
 * so nothing is written and no spot check misses. A spot check shows nothing: typed again, it's Northwind's value.
 */
const settle = async (study: string, i: Pick<ReviewItem, "id" | "options" | "input">, v = 1) => {
  const r = await answer(study, i.id, i.options.length && !i.input ? { optionId: i.options[0]!.id, note: "checked" } : { value: i.input === "date" ? "2026-01-01" : i.input === "text" ? "x" : 1, note: "checked" }, v);
  const it = r.review.find((x) => x.id === i.id)!;
  if (it.outcome === "differs" && !it.compare) await answer(study, i.id, { value: getAt(NW, it.path!) }, v);
  else if (it.outcome === "differs") await answer(study, i.id, i.input ? { value: it.compare!.read, note: "checked" } : { optionId: String(it.compare!.read), note: "checked" }, v);
};

describe("mock API", () => {
  beforeEach(() => mockReset());

  it("serves data that matches the shared schemas", async () => {
    const studies = (await list());
    expect(studies.length).toBeGreaterThanOrEqual(5);
    for (const s of studies) {
      const d = StudyDetailDto.parse(await get(`/studies/${s.id}`));
      for (const v of d.versions) RulebookVersionDto.parse(await get(`/studies/${s.id}/versions/${v.version}`));
    }
    DiffEntry.array().parse(await get("/studies/st-halcyon/versions/2/diff?against=1"));
  });

  it("lists, counts and searches on the server, a page at a time", async () => {
    const all = await list();
    const first = StudyPage.parse(await get("/studies?limit=2"));
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(all.length);
    const second = StudyPage.parse(await get(`/studies?limit=2&cursor=${first.nextCursor}`));
    expect(second.items.map((s) => s.id)).toEqual(all.slice(2, 4).map((s) => s.id));
    expect(all[0]!.needsYou).toBeGreaterThan(0); // most urgent first

    const counts = StudyCounts.parse(await get("/studies/counts"));
    expect(counts.all).toBe(all.length);
    expect((await list("&view=live")).length).toBe(counts.views.live);
    expect((await list("&q=meridian")).map((s) => s.id)).toEqual(["st-meridian"]);
    expect((await mockRequest("GET", "/studies?limit=500", undefined)).status).toBe(400);

    const found = SearchResults.parse(await get("/search?q=ecg"));
    expect(found.rates.length).toBeGreaterThan(0);
    expect(found.rates.every((r) => r.name.toLowerCase().includes("ecg") || (r.code ?? "").toLowerCase().includes("ecg") || r.detail.toLowerCase().includes("ecg"))).toBe(true);
    const r = found.rates[0]!;
    expect(MasterSearch.parse(await get(`/studies/${r.studyId}/versions/${r.version}/search?q=ecg`)).hits.map((h) => h.path)).toContain(r.path);
  });

  it("raises alerts as contracts reach a step that needs someone; read state is per person", async () => {
    const alerts = async (who: string) => AlertPage.parse(await get(`/alerts?for=${encodeURIComponent(who)}&limit=50`));
    const seeded = await alerts("Taylor Brooks");
    expect(new Set(seeded.items.map((a) => a.kind))).toEqual(new Set(["questions_ready", "ready_for_approval", "couldnt_read"]));
    // 4 found by the read, 11 interpretations, 10 values re-typed blind (as the real API asks after a read)
    expect(seeded.items.find((a) => a.studyId === "st-northwind")).toMatchObject({ kind: "questions_ready", count: 25, protocol: "NWP-418-02", read: false });

    // One answer that leaves questions open changes nothing; the last one makes it ready for approval.
    await answer("st-northwind", "q1", { value: 9800 });
    expect((await alerts("Taylor Brooks")).items).toHaveLength(seeded.items.length);
    const v = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    for (const i of v.review.filter((x) => x.outcome === null)) await settle("st-northwind", i);
    const after = await alerts("Taylor Brooks");
    expect(after.items[0]).toMatchObject({ kind: "ready_for_approval", studyId: "st-northwind", by: "Sam Rivera", read: false });
    expect(after.unread).toBe(seeded.unread + 1);
    expect((await alerts("Sam Rivera")).items[0]!.read).toBe(true); // you're not alerted about what you did

    // Sent back: its own alert, with the note, and no "questions ready" on top.
    const ha = RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"));
    const ids = ha.review.filter((i) => i.outcome !== null).slice(0, 2).map((i) => i.id);
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: ids, note: "Check page 4", by: "Morgan Lee" });
    const sent = (await alerts("Sam Rivera")).items.filter((a) => a.studyId === "st-halcyon" && a.at > seeded.items[0]!.at);
    expect(sent.map((a) => a.kind)).toEqual(["sent_back"]);
    expect(sent[0]).toMatchObject({ count: 2, note: "Check page 4", by: "Morgan Lee" });

    // Marking read: one, then all.
    const first = (await alerts("Taylor Brooks")).items[0]!;
    expect((await post("/alerts/read", { by: "Taylor Brooks", ids: [first.id] })).json).toEqual({ unread: after.unread });
    expect((await alerts("Taylor Brooks")).items[0]!.read).toBe(true);
    expect((await post("/alerts/read", { by: "Taylor Brooks" })).json).toEqual({ unread: 0 });
    expect((await alerts("Jordan Patel")).unread).toBeGreaterThan(0);
    expect((await mockRequest("GET", "/alerts", undefined)).status).toBe(400);
    expect((await post("/alerts/read", { ids: [first.id] })).status).toBe(400);
  }, 30_000); // about 25 requests, each with the sample server's network delay

  it("searching a draft never finds a value that's hidden for blind typing", async () => {
    const nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    const hidden = nw.review.find((i) => i.path === "/invoiceables/0/amountCents")!; // in the blind sample
    expect(hidden).toMatchObject({ reason: SAMPLE, outcome: null });
    const cents = (NW.invoiceables[0]!.amountCents! / 100).toFixed(2);
    const hits = MasterSearch.parse(await get(`/studies/st-northwind/versions/1/search?q=${cents}`)).hits;
    expect(hits.map((h) => h.path)).not.toContain("/invoiceables/0");
  });

  it("seeds a text PDF in Needs you, a scan, a live study and one waiting for approval", async () => {
    const nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    expect(nw.review).toHaveLength(25);
    expect(nw.review.filter((i) => i.reason === SAMPLE)).toHaveLength(10);
    expect(nw.review.filter((i) => i.kind === "interpretation").map((i) => i.reason)).toEqual(["AMBIGUOUS_TERM", ...Array(10).fill("INTERPRETATION")]);
    expect(nw.pdfCheck!.matched).toBe(nw.pdfCheck!.values - 1);
    expect(RulebookVersionDto.parse(await get("/studies/st-cobalt/versions/1")).pdfCheck).toBeNull();
    const ha = RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"));
    expect(ha.review.every((i) => i.outcome !== null)).toBe(true);
    expect((await list()).find((s) => s.id === "st-meridian")!.status).toBe("live");
  });

  it("never sends the right answer or the reading before an answer", async () => {
    const raw = JSON.stringify(await get("/studies/st-northwind/versions/1"));
    const nw = RulebookVersionDto.parse(JSON.parse(raw));
    expect(nw.review.every((i) => i.compare === null && i.answer === null)).toBe(true);
    expect(raw).not.toMatch(/"truth"|"secret"|"apply"/);
  });

  it("matches, differs, then settles (a note only to keep your own value over the PDF text); answers can change; options are chosen", async () => {
    // q1: the tool read $93.00, the page prints $98.00.
    let v = await answer("st-northwind", "q1", { value: 9800 });
    expect(v.review.find((i) => i.id === "q1")).toMatchObject({ outcome: "matched", compare: null });
    expect(v.rulebook!.budgetGrids[0]!.procedures[3]!.cells.V2).toBe(9800);
    expect(v.evidence.find((e) => e.path === "/budgetGrids/0/procedures/3/cells/V2")!.status).toBe("attested");

    // a value of the blind sample: typed differently, it's typed again blind, nothing shown; the confirmed value again was a typo
    const unit = sampleOf(v, (p) => p.endsWith("/unitCents"));
    const price = getAt(NW, unit.path!) as number;
    v = await answer("st-northwind", unit.id, { value: price + 100 });
    expect(v.review.find((i) => i.id === unit.id)).toMatchObject({ outcome: "differs", compare: null });
    v = await answer("st-northwind", unit.id, { value: price });
    expect(v.review.find((i) => i.id === unit.id)).toMatchObject({ outcome: "matched", compare: null });

    // Changing an earlier answer while the version is a draft: it is checked again.
    v = await answer("st-northwind", "q1", { value: 9900 });
    expect(v.review.find((i) => i.id === "q1")!.outcome).toBe("differs");
    v = await answer("st-northwind", "q1", { value: 9800 });
    expect(v.review.find((i) => i.id === "q1")!.outcome).toBe("chosen");

    v = await answer("st-northwind", "q2", { optionId: "g-nw-b" });
    expect(v.rulebook!.governingGridIds).toEqual(["g-nw-b"]);
    expect((await post("/studies/st-northwind/versions/1/review/q2", { optionId: "nope", by: "Sam" })).status).toBe(400);
    v = await answer("st-northwind", "q7", { cantTell: true });
    expect(v.review.find((i) => i.id === "q7")!.outcome).toBe("cant_tell");
    expect(v.editors).toEqual(["Sam Rivera"]);
  });

  it("refuses approval while any question is unsettled or the version changed since, then applies maker-checker (on by default)", async () => {
    expect((await signOff("st-northwind", 1, "Morgan Lee")).status).toBe(409);
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Morgan Lee" })).status).toBe(400); // as seen when?
    const v = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    for (const i of v.review) await settle("st-northwind", i);
    const seen = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1")).updatedAt;
    await post("/studies/st-northwind/versions/1/proofread", { paths: ["/siteFees/0/amountCents"], by: "Avery Chen" });
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Morgan Lee", asOf: seen })).json).toMatchObject({ message: "This contract changed since you opened it. Check it again." });
    expect(((await get("/settings")) as { makerChecker: boolean }).makerChecker).toBe(true);
    for (const by of ["Sam Rivera", " sam rivera "]) expect((await signOff("st-northwind", 1, by)).status, by).toBe(409);
    expect((await signOff("st-northwind", 1, "Morgan Lee")).status).toBe(200);
    expect(StudyDetailDto.parse(await get("/studies/st-northwind")).status).toBe("live");

    // a question not needed to approve still holds approval: left for the approver, it must be settled (ADR-001 §6)
    await answer("st-halcyon", "a5", { cantTell: true, by: "Taylor Brooks" }, 2);
    expect(((await signOff("st-halcyon", 2, "Morgan Lee")).json as { message: string }).message).toBe("1 question still needs an answer before this can be approved.");
    expect((await post("/studies/st-halcyon/versions/2/review/a5", { optionId: "sum", by: "Taylor Brooks" })).json).toMatchObject({ message: "Add a short note for this answer: what should we ask the sponsor?" });
    const sum = await answer("st-halcyon", "a5", { optionId: "sum", note: "Ask why Week 52 is printed low", by: "Taylor Brooks" }, 2);
    const week52 = sum.rulebook!.budgetGrids[0]!.visits[5]!;
    expect(week52.totalCents).toBe(week52.procedureSubtotalCents! + week52.overheadCents! + week52.nonProcedureCents!); // the sum governs: written
    expect((await signOff("st-halcyon", 2, "Morgan Lee")).status).toBe(200);
  }, 30_000); // many requests, each with the sample server's network delay

  it("“This looks wrong” on a draft adds a blocking blind question and sends an approved-ready study back to Needs you", async () => {
    const summary = async () => (await list()).find((s) => s.id === "st-halcyon")!;
    expect((await summary()).needsYou).toBe(0);
    const res = await post("/studies/st-halcyon/versions/2/report", { path: "/payment/netDays/value", note: "Sponsor pays in 45 days", by: "Sam Rivera" });
    const v = RulebookVersionDto.parse(res.json);
    const item = v.review.at(-1)!;
    expect(item).toMatchObject({ kind: "confirm_value", reason: "reported", blocking: true, input: "number", path: "/payment/netDays/value", answer: null, compare: null });
    expect(item.question).toBe("What value is printed for Payment › Net days?");
    expect((await summary()).needsYou).toBe(1);
    expect((await post("/studies/st-halcyon/versions/2/report", { path: "/payment/netDays/value", note: "again", by: "Sam" })).status).toBe(409);
    expect((await post("/studies/st-halcyon/versions/2/report", { path: "/budgetGrids/0", note: "whole grid", by: "Sam" })).status).toBe(400);
  });

  it("“This looks wrong” on the live version opens a correction draft; the live version stays live", async () => {
    const res = await post("/studies/st-meridian/versions/1/report", { path: "/budgetGrids/0/procedures/3/cells/V2", note: "Should be $104", by: "Sam Rivera" });
    const draft = RulebookVersionDto.parse(res.json);
    expect(draft).toMatchObject({ version: 2, status: "draft", byHand: false });
    expect(draft.review).toHaveLength(1);
    expect(draft.review[0]!.question).toMatch(/^What amount is printed for /);
    const st = StudyDetailDto.parse(await get("/studies/st-meridian"));
    expect(st).toMatchObject({ status: "amendment_in_review", liveVersion: 1 });
    // the note names the value being typed blind on the draft: its numbers are blanked until that's answered
    const audit = AuditPage.parse(await get("/audit?studyId=st-meridian")).items;
    expect(audit[0]).toMatchObject({ action: "number.reported", protocol: "MTX-5510", detail: { note: "Should be $•••" } });
    // Only the newest version can be reported on now.
    expect((await post("/studies/st-meridian/versions/1/report", { path: "/payment/netDays/value", note: "x", by: "Sam" })).status).toBe(409);
  });

  it("a mismatch the PDF's text can't decide (a scan) needs a note saying where the page prints it, whichever value is kept", async () => {
    // Cobalt is a scan: nothing printed to check against, so the typed value is compared with the reading (60 days).
    const url = "/studies/st-cobalt/versions/1/review/c2";
    let v = RulebookVersionDto.parse((await post(url, { value: 45, by: "Sam Rivera" })).json);
    expect(v.review.find((i) => i.id === "c2")).toMatchObject({ outcome: "differs", compare: { typed: 45, read: 60, printed: null } });
    for (const value of [45, 60]) {
      const res = await post(url, { value, note: "  ", by: "Sam Rivera" });
      expect(res.status).toBe(400);
      expect((res.json as { message: string }).message).toBe("Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note.");
    }
    v = RulebookVersionDto.parse((await post(url, { value: 45, note: "§4.2 on page 4, first line", by: "Sam Rivera" })).json);
    expect(v.review.find((i) => i.id === "c2")).toMatchObject({ outcome: "chosen", answer: { value: 45, note: "§4.2 on page 4, first line", noPdfText: true } });
    // where the PDF's text decides it, today's rule: only keeping your own value over it needs a note, and nothing is marked
    const unit = sampleOf(RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1")), (p) => p.endsWith("/unitCents"));
    const price = getAt(NW, unit.path!) as number;
    await answer("st-northwind", unit.id, { value: price + 100 });
    expect((await answer("st-northwind", unit.id, { value: price })).review.find((i) => i.id === unit.id)!.answer).not.toHaveProperty("noPdfText");
  }, 30_000);

  it("a note never gives a value away while its question is open: the version, the log, its search and the alert", async () => {
    const ha = RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"));
    const a2 = ha.review.find((i) => i.id === "a2")!; // Remote monitoring visit, answered $420.00
    const note = "Page 4 prints $420.00 (four hundred twenty), see §3";
    const blanked = "Page 4 prints $••• (•••), see §3";
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: [a2.id], note, by: "Morgan Lee" });
    const refused = await post("/studies/st-halcyon/versions/2/send-back", { itemIds: [a2.id], note, by: "Morgan Lee" }); // now unanswered
    expect(refused.status).toBe(409);
    // the sample server leaves masking the values themselves to the web; the notes are its to blank
    const notes = (v: RulebookVersionDto) => v.review.map((i) => [i.sentBack?.note, i.answer?.note, i.reported?.note]);
    // ids and times can hold any digits; only what people read counts
    const words = (x: unknown) => JSON.stringify(x).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z|"id":"[^"]*"/g, "");
    const raw = words([
      refused.json,
      notes(RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"))),
      await get("/audit?studyId=st-halcyon&limit=100"),
      await get("/alerts?for=Avery%20Chen&limit=50"),
      ...(await Promise.all(["420", "four", "hundred"].map((q) => get(`/audit?q=${q}`)))),
    ]);
    expect(raw).not.toMatch(/420|four|hundred|twenty/);
    expect(RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2")).review.find((i) => i.id === "a2")!.sentBack).toMatchObject({ note: blanked });
    const log = AuditPage.parse(await get("/audit?studyId=st-halcyon&limit=100")).items;
    expect(log[0]).toMatchObject({ action: "review.sent_back", detail: { note: blanked } });
    expect(log.find((e) => e.action === "review.answered" && e.detail.itemId === "a2")!.detail).not.toHaveProperty("after");
    expect(AuditPage.parse(await get("/audit?q=420")).items).toEqual([]);

    // "This looks wrong": the note goes with the question, figures blanked for whoever answers it.
    const rep = RulebookVersionDto.parse((await post("/studies/st-halcyon/versions/2/report", { path: "/payment/netDays/value", note: "Should be 45 days, see Amendment 1 §2", by: "Sam Rivera" })).json).review.at(-1)!;
    expect(rep).toMatchObject({ reason: "reported", reported: { by: "Sam Rivera", note: "Should be ••• days, see Amendment 1 §2" } });
    expect(words(notes(RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"))))).not.toMatch(/45/);

    // Answered again: the full note, found by its numbers; the alert went to everyone, so it stays blanked.
    expect((await post(`/studies/st-halcyon/versions/2/review/${rep.id}`, { value: 30, by: "Taylor Brooks" })).status).toBe(200);
    expect(RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2")).review.at(-1)!.reported!.note).toBe("Should be 45 days, see Amendment 1 §2");
    expect((await post("/studies/st-halcyon/versions/2/review/a2", { value: 42000, by: "Taylor Brooks" })).status).toBe(200);
    expect(AuditPage.parse(await get("/audit?studyId=st-halcyon&limit=100")).items.find((e) => e.action === "review.sent_back")!.detail.note).toBe(note);
    expect(AuditPage.parse(await get("/audit?q=420.00")).items.map((e) => e.action)).toEqual(["review.sent_back"]);
    expect(AlertPage.parse(await get("/alerts?for=Avery%20Chen&limit=50")).items.find((a) => a.kind === "sent_back")!.note).toBe(blanked);
  }, 30_000);

  it("pages and searches the activity log on the server", async () => {
    const all = AuditPage.parse(await get("/audit?limit=100"));
    expect(all.nextCursor).toBeNull();
    expect(all.items.map((e) => e.at)).toEqual([...all.items.map((e) => e.at)].sort().reverse());
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AuditPage = AuditPage.parse(await get(`/audit?limit=6${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((e) => e.id));
    const mine = AuditPage.parse(await get("/audit?studyId=st-meridian&limit=100")).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.studyId === "st-meridian" && e.protocol === "MTX-5510" && e.sponsor === "Meridian Therapeutics")).toBe(true);
    const actions = async (q: string) => AuditPage.parse(await get(`/audit?q=${encodeURIComponent(q)}&limit=100`)).items.map((e) => `${e.by} ${e.action}`);
    expect(await actions("sam approved")).toEqual(["Sam Rivera version.signed"]); // the person and what the action is called
    expect(await actions("faint")).toEqual(["system extraction.failed"]); // the details
    expect(await actions("nobody here")).toEqual([]);
    expect((await mockRequest("GET", "/audit?limit=500", undefined)).status).toBe(400);
  }, 30_000);

  it("asks for an amount cap's limit as money, as the real API", () => {
    const rb = makeRulebook(SEEDS.meridian.cfg!);
    rb.invoiceables[0]!.cap = { kind: "amount", n: 500000, ratio: null };
    rb.invoiceables[1]!.cap = { kind: "count", n: 3, ratio: null };
    expect([askAbout(rb, [], "/invoiceables/0/cap/n", "x", "reported").input, askAbout(rb, [], "/invoiceables/1/cap/n", "y", "reported").input]).toEqual(["money", "number"]);
  });

  it("refuses typing values on a draft that isn't typed by hand", async () => {
    const res = await mockRequest("PATCH", "/studies/st-northwind/versions/1/values", { path: "/payment/netDays/value", value: 30, note: "x", by: "Sam" });
    expect(res.status).toBe(409);
  });

  it("types a contract in by hand, then someone else re-types a blind sample of up to 10 values", async () => {
    const start = await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const v0 = RulebookVersionDto.parse(start.json);
    expect(v0).toMatchObject({ version: 1, status: "draft", byHand: true, evidence: [], review: [] }); // replaces the failed read, as the real API
    const type = async (path: string, value: unknown) => {
      const r = await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path, value, note: "Typed by hand", by: "Avery Chen" });
      expect(r.status, path).toBe(200);
      return RulebookVersionDto.parse(r.json);
    };
    await type("/payment/netDays/value", 45);
    await type("/budgetGrids/0/procedures", [{ ...v0.rulebook!.budgetGrids[0]!.procedures[0]! }, { ...v0.rulebook!.budgetGrids[0]!.procedures[0]! }]);
    await type("/budgetGrids/0/procedures/0/name", "Blood draw");
    await type("/budgetGrids/0/procedures/1/name", "ECG");
    let v = await type("/budgetGrids/0/procedures/1/cells/V1", 7600);
    expect(v.evidence.find((e) => e.path === "/budgetGrids/0/procedures/1/cells/V1")!.status).toBe("attested");
    // Removing row 0 moves row 1's typed values up.
    v = await type("/budgetGrids/0/procedures", [v.rulebook!.budgetGrids[0]!.procedures[1]!]);
    expect(v.evidence.map((e) => e.path).sort()).toEqual(["/budgetGrids/0/procedures/0/cells/V1", "/budgetGrids/0/procedures/0/name", "/payment/netDays/value"]);
    expect((await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/budgetGrids/0/visits/0/totalCents", value: null, note: "x", by: "Avery Chen" })).status).toBe(400);
    expect((await list()).find((s) => s.id === "st-solace")!.needsYou).toBe(1);
    expect(((await signOff("st-solace", 1, "Morgan Lee")).json as { message: string }).message).toBe("Typing isn't marked done yet, so nobody has re-typed the values.");

    // 3 typed values → all 3 are re-typed; the visit total nobody typed holds the blank form's 0, and the form's choices
    // nobody made their defaults (how the visit is paid, the row's kind and overhead, terms "not stated"): asked as missing
    v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.review.map((i) => i.reason).sort()).toEqual([...Array(8).fill("REQUIRED_MISSING"), "spot_check", "spot_check", "spot_check"]);
    expect(v.review.find((i) => i.path === "/budgetGrids/0/visits/0/totalCents")).toMatchObject({ reason: "REQUIRED_MISSING", input: "money", blocking: true });
    expect(v.review.every((i) => i.blocking && i.answer === null)).toBe(true);
    expect((await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path: "/payment/netDays/value", value: 30, note: "x", by: "Avery Chen" })).status).toBe(409);
    const days = v.review.find((i) => i.path === "/payment/netDays/value")!;
    // the API's own ids now (spot:<path>), so the URL encodes them
    expect((await post(`/studies/st-solace/versions/1/review/${encodeURIComponent(days.id)}`, { value: 45, by: "Avery Chen" })).status).toBe(409);
    v = RulebookVersionDto.parse((await post(`/studies/st-solace/versions/1/review/${encodeURIComponent(days.id)}`, { value: 40, by: "Sam Rivera" })).json);
    expect(v.review.find((i) => i.id === days.id)).toMatchObject({ outcome: "differs", compare: { typed: 40, read: 45, printed: null } });
    // keeping a different value is a correction: the re-typer is then an editor, and can't approve alone
    v = RulebookVersionDto.parse((await post(`/studies/st-solace/versions/1/review/${encodeURIComponent(days.id)}`, { value: 40, note: "page 4, §4.2", by: "Sam Rivera" })).json);
    expect(v.editors).toEqual(["Avery Chen", "Sam Rivera"]);
  }, 30_000); // many requests, each with the mock's simulated network delay

  it("re-types at most 10 hand-typed values", async () => {
    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const patch = async (path: string, value: unknown) =>
      RulebookVersionDto.parse((await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path, value, note: "x", by: "Avery Chen" })).json);
    for (let i = 0; i < 4; i++) {
      const rb = (await patch("/payment/netDays/value", null)).rulebook!;
      await patch("/invoiceables", [...rb.invoiceables, blankInvoiceable()]);
      for (const k of ["name", "amountCents", "amountWithOverheadCents"]) await patch(`/invoiceables/${i}/${k}`, k === "name" ? `Item ${i}` : 1000 * (i + 1));
    }
    const v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.evidence).toHaveLength(12);
    expect(v.review.filter((i) => i.reason === "spot_check")).toHaveLength(10);
  }, 30_000); // many requests, each with the mock's simulated network delay

  it("amendment diff lists changed fees with readable labels", async () => {
    const diff = DiffEntry.array().parse(await get("/studies/st-halcyon/versions/2/diff?against=1"));
    expect(diff.find((e) => e.path === "/payment/netDays/value")).toMatchObject({ change: "changed", before: 45, after: 30, label: "Payment › Net days" });
    expect(diff.some((e) => e.change === "added" && e.label.includes("Remote monitoring visit"))).toBe(true);
  });
});

describe("mock API: in step with the real API's rules", () => {
  beforeEach(() => mockReset());

  it("withholds a value with an open question: the value, its printed text, its quote and the words that restate it", async () => {
    const nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    // net days, in the blind sample: a confirmed value, withheld while it's re-typed; the fixture's evidence prints it
    expect(nw.review.find((i) => i.path === "/payment/netDays/value")).toMatchObject({ reason: SAMPLE });
    expect(nw.rulebook!.payment.netDays.value).toBeNull();
    expect(nw.evidence.find((e) => e.path === "/payment/netDays/value")).toMatchObject({ status: "confirmed", printed: null });
    expect(nw.rulebook!.payment.netDays.prov.source).not.toHaveProperty("quote");
    expect(nw.rulebook!.budgetGrids[0]!.procedures[3]!.cells.V2).toBeNull(); // q1
    expect(nw.rulebook!.payment.visitPayment.value).toBeNull(); // an interpretation, picked blind
    await answer("st-northwind", "sample:/payment/netDays/value", { value: 45 });
    expect(RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1")).rulebook!.payment.netDays.prov.source).toHaveProperty("quote");
  });

  it("bill by hand lists the term on the master; another answer takes it off; send back too", async () => {
    let v = await answer("st-northwind", "q7", { optionId: "bill_by_hand" });
    expect(v.rulebook!.unclassified).toMatchObject([{ label: "§7.2 Parking. Sponsor will reimburse parking at $12.00 per…", amounts: [1200], itemId: "q7" }]);
    v = await answer("st-northwind", "q7", { optionId: "not_payment" });
    expect(v.rulebook!.unclassified).toEqual([]);
    await answer("st-northwind", "q7", { optionId: "bill_by_hand" });
    v = RulebookVersionDto.parse((await post("/studies/st-northwind/versions/1/send-back", { itemIds: ["q7"], note: "Is it per visit?", by: "Morgan Lee" })).json);
    expect(v.rulebook!.unclassified).toEqual([]);
    // the seeded amendment lists its courier pickups
    expect(RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2")).rulebook!.unclassified.map((u) => u.amounts)).toEqual([[9500]]);
  });

  it("the same settling answer again changes nothing; picking one arm's grid keeps the others'", async () => {
    const id = "interpret:/rounding/value";
    await answer("st-northwind", id, { optionId: "cents" }); // differs from the read's "printed amounts"
    const kept = await answer("st-northwind", id, { optionId: "cents", note: "Exhibit A §1: exact cents" });
    expect(kept.review.find((i) => i.id === id)!.outcome).toBe("chosen");
    const logged = AuditPage.parse(await get("/audit?studyId=st-northwind&limit=100")).items.length;
    expect((await answer("st-northwind", id, { optionId: "cents", note: "Exhibit A §1: exact cents" })).review.find((i) => i.id === id)!.outcome).toBe("chosen");
    expect(AuditPage.parse(await get("/audit?studyId=st-northwind&limit=100")).items).toHaveLength(logged);
  });

  it("asks the interpretations blind, as the real API: a pick that differs is shown with the read and confirmed", async () => {
    const nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    expect(nw.review.filter((i) => i.kind === "interpretation").map((i) => i.path)).toEqual([
      "/overhead/appliesTo/value", "/payment/visitPayment/value", ...NW.siteFees.map((_, i) => `/siteFees/${i}/trigger`),
      "/screenFail/basis", "/screenFail/cap/kind", "/screenFail/paidVia", "/holdback/appliesTo", "/rounding/value",
    ]);
    expect(nw.review.find((i) => i.path === "/overhead/appliesTo/value")).toMatchObject({ reason: "AMBIGUOUS_TERM", question: expect.stringMatching(/^The budget says overhead is “applied to the costs above”\. Which lines/) });
    // withheld, with the cap's ratio its kind gives meaning to
    expect([nw.rulebook!.payment.visitPayment.value, nw.rulebook!.screenFail!.cap.kind, nw.rulebook!.screenFail!.cap.ratio]).toEqual([null, null, null]);
    const id = "interpret:/payment/visitPayment/value";
    expect((await answer("st-northwind", id, { optionId: "invoice" })).review.find((i) => i.id === id)).toMatchObject({ outcome: "differs", compare: { typed: "invoice", read: "auto_edc" } });
    expect((await post(`/studies/st-northwind/versions/1/review/${encodeURIComponent(id)}`, { optionId: "invoice", by: "Sam Rivera" })).status).toBe(400);
    const v = await answer("st-northwind", id, { optionId: "invoice", note: "§4.1: visits are invoiced" });
    expect(v.review.find((i) => i.id === id)).toMatchObject({ outcome: "chosen", answer: { noPdfText: true } });
    expect(v.rulebook!.payment.visitPayment.value).toBe("invoice");
    // a cap kind other than the read's asks its figures again (here, a ratio cap's ratio)
    const cap = "interpret:/screenFail/cap/kind";
    await answer("st-northwind", cap, { optionId: "count" });
    const after = await answer("st-northwind", cap, { optionId: "count", note: "§5: at most 3" });
    expect(after.review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ id: "cap:/screenFail/cap/n", reason: "CAP_KIND_CHANGED", input: "number", outcome: null });
  });

  it("an amendment's start date: typed, or prospective only (the amendment's own date, typed blind)", async () => {
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: ["interpret:/appliesFrom/value"], note: "Check §1", by: "Morgan Lee" });
    const q = RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2")).review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q).toMatchObject({ kind: "contract_problem", reason: "RETROACTIVE_NO_DATE", input: "date", options: [{ id: "prospective", label: "Prospective only: from the amendment's own date" }] });
    const v = await answer("st-halcyon", q.id, { optionId: "prospective", value: "2026-09-30", by: "Taylor Brooks" }, 2);
    expect([v.review.find((i) => i.id === q.id)!.outcome, v.rulebook!.appliesFrom.value]).toEqual(["matched", "2026-09-30"]);
  });

  it("a random spot check that misses: logged and alerted, and approval waits until its kind of value is proofread", async () => {
    let nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    expect(nw.review.filter((i) => i.reason === SAMPLE)).toHaveLength(10);
    const unit = sampleOf(nw, (p) => p.endsWith("/unitCents"));
    const price = getAt(NW, unit.path!) as number;
    await answer("st-northwind", unit.id, { value: price + 100 });
    // typed again blind, the same: that answer stands, and the sample missed
    await answer("st-northwind", unit.id, { value: price + 100 });
    const log = AuditPage.parse(await get("/audit?studyId=st-northwind&limit=100")).items;
    expect(log[0]).toMatchObject({ action: "sample.missed", by: "Sam Rivera", detail: { itemId: unit.id, values: "budget grid prices" } });
    expect(AlertPage.parse(await get("/alerts?for=Morgan%20Lee&limit=50")).items[0]).toMatchObject({ kind: "sample_missed", studyId: "st-northwind" });
    nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    for (const i of nw.review.filter((x) => x.outcome === null || x.outcome === "differs")) await settle("st-northwind", i);
    const refused = await signOff("st-northwind", 1, "Morgan Lee");
    expect([refused.status, (refused.json as { message: string }).message]).toEqual([409, expect.stringMatching(/^A random spot check found a wrong number among the budget grid prices/)]);
    nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    const left = nw.evidence.filter((e) => e.status === "confirmed" && /\/procedures\/\d+\/(cells|unitCents)/.test(e.path)).map((e) => e.path);
    await post("/studies/st-northwind/versions/1/proofread", { paths: left, by: "Avery Chen" });
    expect((await signOff("st-northwind", 1, "Morgan Lee")).status).toBe(200);
  }, 60_000); // many requests, each with the sample server's network delay

  it("refuses what the API refuses: reading again over a draft, editing approved details, a file that isn't a PDF, bad settings", async () => {
    expect((await post("/studies/st-northwind/extract", { by: "Sam Rivera" })).json).toMatchObject({ statusCode: 409, message: "Version 1 is a draft under review; sign it off before extracting again" });
    const edit = await mockRequest("PATCH", "/studies/st-meridian", { sponsor: "S", protocol: "P", siteName: "S", investigator: "I", by: "Sam Rivera" });
    expect([edit.status, (edit.json as { message: string }).message]).toEqual([409, expect.stringMatching(/approved version/)]);
    const fd = new FormData();
    fd.append("files[]", new File(["hello"], "notes.txt"));
    expect(await mockRequest("POST", "/uploads", fd)).toMatchObject({ status: 415, json: { message: "notes.txt is not a PDF" } });
    expect((await mockRequest("PATCH", "/settings", { makerChecker: "yes", by: "Sam Rivera" })).status).toBe(400);
  });

  it("reads a failed read again in its own version; an amendment being read, or that couldn't be read, isn't waiting for approval", async () => {
    // Solace's read failed: reading again reuses version 1
    expect((await post("/studies/st-solace/extract", { by: "Sam Rivera" })).json).toMatchObject({ version: 1 });
    expect(StudyDetailDto.parse(await get("/studies/st-solace")).versions.map((v) => [v.version, v.status])).toEqual([[1, "extracting"]]);
    // Meridian is live: its amendment is being read, not waiting for approval; "This looks wrong" on the live version says so
    expect((await post("/studies/st-meridian/extract", { by: "Sam Rivera" })).json).toMatchObject({ version: 2 });
    expect((await list()).find((s) => s.id === "st-meridian")).toMatchObject({ status: "extracting", liveVersion: 1 });
    expect((await post("/studies/st-meridian/versions/1/report", { path: "/payment/netDays/value", note: "x", by: "Sam Rivera" })).json).toMatchObject({
      message: "Version 2 is being read right now. When it's ready, report this there.",
    });
  });

  it("a shared file's kind change is logged on every study that uses it", async () => {
    const res = await mockRequest("PATCH", "/documents/doc-hal-cta", { kind: "master_agreement", by: "Sam Rivera" });
    expect(res.status).toBe(200);
    expect(AuditPage.parse(await get("/audit?studyId=st-halcyon&limit=5")).items[0]).toMatchObject({ action: "document.kind_set", detail: { documentId: "doc-hal-cta", to: "master_agreement" } });
  });
});

describe("mock API: the API's own rules (@dct/shared), where its copies used to drift", () => {
  beforeEach(() => mockReset());

  /**
   * The sample server as a reload finds it, after `edit` changes what it saved: how a test plants a state no sample route
   * makes (a correction an amendment lost, a date the PDF prints in words).
   */
  async function reloadWith(edit: (saved: { versions: RulebookVersionDto[] }) => void) {
    await get("/settings"); // saved after every request
    const saved = JSON.parse(localStorage.getItem("dct.mockdb.v9")!) as { versions: RulebookVersionDto[] };
    edit(saved);
    localStorage.setItem("dct.mockdb.v9", JSON.stringify(saved));
    vi.resetModules();
    const { mockRequest: request } = await import("./server");
    return request;
  }
  const versionIn = (saved: { versions: RulebookVersionDto[] }, studyId: string, v: number) => saved.versions.find((x) => x.studyId === studyId && x.version === v)!;

  it("lists a correction the amendment lost to bill by hand (CORRECTION_LOST), as the API does", async () => {
    const lost: ReviewItem = {
      id: "lost:/siteFees/0/amountCents", kind: "unaccounted", reason: "CORRECTION_LOST", path: null, blocking: true, input: null,
      question: "Avery Chen corrected Site fee › Study start-up fee › Amount on version 1, but the amendment's reading doesn't have it any more. Is it still in the contract?",
      options: [{ id: "removed", label: "No, the amendment removed it" }, { id: "bill_by_hand", label: "Yes: list it to bill by hand", note: "What is billed by hand? Name the term and its amount." }],
      where: [{ documentId: "doc-hal-cta", page: 7, box: null }], answer: null, outcome: null, compare: null, sentBack: null,
    };
    const request = await reloadWith((s) => versionIn(s, "st-halcyon", 2).review.push(lost));
    const res = await request("POST", `/studies/st-halcyon/versions/2/review/${encodeURIComponent(lost.id)}`, { optionId: "bill_by_hand", note: "Start-up fee, once", by: "Taylor Brooks" });
    expect(RulebookVersionDto.parse(res.json).rulebook!.unclassified).toContainEqual(expect.objectContaining({ itemId: lost.id, label: "Page 7 of “Clinical Trial Agreement HAL-2207”", note: "Start-up fee, once" }));
  });

  it("reads a date the PDF prints in words as the binder does (isoDate), not ISO only", async () => {
    const reported = RulebookVersionDto.parse((await post("/studies/st-northwind/versions/1/report", { path: "/study/effectiveDate/value", note: "Check the date", by: "Avery Chen" })).json).review.at(-1)!;
    expect(reported.input).toBe("date");
    // the read says July 1; the page prints July 2
    const request = await reloadWith((s) => versionIn(s, "st-northwind", 1).evidence.push({ path: "/study/effectiveDate/value", status: "confirmed", where: [], printed: "July 2, 2025", note: null }));
    const res = await request("POST", `/studies/st-northwind/versions/1/review/${encodeURIComponent(reported.id)}`, { value: "2025-07-02", by: "Sam Rivera" });
    expect(RulebookVersionDto.parse(res.json).review.find((i) => i.id === reported.id)!.outcome).toBe("matched");
  });

  it("keeps the date a version's terms apply from: the effective date it falls back to, withheld while asked", async () => {
    const shown = async (study: string, v: number) => [RulebookVersionDto.parse(await get(`/studies/${study}/versions/${v}`)).appliesFrom, StudyDetailDto.parse(await get(`/studies/${study}`)).versions.find((x) => x.version === v)!.appliesFrom];
    expect(await shown("st-northwind", 1)).toEqual(["2025-07-01", "2025-07-01"]); // a draft, from the contract's effective date
    expect(await shown("st-meridian", 1)).toEqual(["2024-11-18", "2024-11-18"]); // approved with it
    expect(await shown("st-halcyon", 2)).toEqual(["2026-09-01", "2026-09-01"]); // the amendment's start date, answered
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: ["interpret:/appliesFrom/value"], note: "Check §1", by: "Morgan Lee" });
    expect(await shown("st-halcyon", 2)).toEqual([null, null]); // asked again, blind
    await answer("st-halcyon", "interpret:/appliesFrom/value", { optionId: "prospective", value: "2026-09-30", by: "Taylor Brooks" }, 2);
    expect(await shown("st-halcyon", 2)).toEqual(["2026-09-30", "2026-09-30"]);
  });

  it("proofreading the same values again changes nothing and logs nothing", async () => {
    const mark = async () => RulebookVersionDto.parse((await post("/studies/st-meridian/versions/1/proofread", { paths: ["/siteFees/0/amountCents"], by: "Avery Chen" })).json);
    const first = await mark();
    const logged = AuditPage.parse(await get("/audit?studyId=st-meridian&limit=100")).items.length;
    expect((await mark()).updatedAt).toBe(first.updatedAt);
    expect(AuditPage.parse(await get("/audit?studyId=st-meridian&limit=100")).items).toHaveLength(logged);
  });

  it("re-types yes/no and list values typed by hand too", async () => {
    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const typed = { "/budgetGrids/0/visits/0/autopay": false, "/payment/requiredReferences/value": ["protocol number"], "/payment/netDays/value": 45 };
    for (const [path, value] of Object.entries(typed)) expect((await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path, value, note: "x", by: "Avery Chen" })).status, path).toBe(200);
    const v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.review.filter((i) => i.reason === "spot_check").map((i) => i.path).sort()).toEqual(Object.keys(typed).sort());
    expect(v.review.find((i) => i.path === "/budgetGrids/0/visits/0/autopay")!.options.map((o) => o.id)).toEqual(["true", "false"]);
  });

  it("asks a total that doesn't add up once its grid's typed numbers are re-typed (recheck)", async () => {
    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const v0 = "/budgetGrids/0/visits/0";
    // subtotal 100 + overhead 40 ≠ total 150
    for (const [path, value] of [[`${v0}/procedureSubtotalCents`, 10000], [`${v0}/overheadCents`, 4000], [`${v0}/totalCents`, 15000]] as const)
      await mockRequest("PATCH", "/studies/st-solace/versions/1/values", { path, value, note: "x", by: "Avery Chen" });
    let v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/1/by-hand/done", { by: "Avery Chen" })).json);
    // with the form's choices nobody made (asked as missing): the row's kind holds the check back with the typed numbers
    expect(v.review.map((i) => i.reason)).toEqual([...Array(3).fill("spot_check"), ...Array(7).fill("REQUIRED_MISSING")]);
    const typedAt = { [`${v0}/procedureSubtotalCents`]: 10000, [`${v0}/overheadCents`]: 4000, [`${v0}/totalCents`]: 15000 } as Record<string, number>;
    const blank = (p: string) => (/autopay$/.test(p) ? "true" : /overheadApplied$/.test(p) ? "false" : /category$/.test(p) ? "procedure" : "unspecified");
    for (const i of v.review) v = await answer("st-solace", i.id, i.reason === "spot_check" ? { value: typedAt[i.path!] } : { optionId: blank(i.path!) });
    expect(v.review.find((i) => i.reason === "VISIT_TOTAL_MISMATCH")).toMatchObject({ id: `anomaly:VISIT_TOTAL_MISMATCH:${v0}/totalCents`, kind: "contract_problem", outcome: null });
  });

  it("diffs array items by identity and escapes a key in the path, as the API", async () => {
    const request = await reloadWith((s) => {
      const rb = versionIn(s, "st-halcyon", 2).rulebook!;
      rb.invoiceables.unshift(rb.invoiceables.pop()!); // the amendment's new fee, listed first
      rb.budgetGrids[0]!.procedures[0]!.cells["W/4"] = 18500; // a visit code with a slash in it
    });
    const diff = DiffEntry.array().parse((await request("GET", "/studies/st-halcyon/versions/2/diff?against=1", undefined)).json);
    expect(diff.filter((e) => e.path.startsWith("/invoiceables/")).map((e) => [e.change, e.path])).toEqual([["added", "/invoiceables/0"]]);
    expect(diff.find((e) => e.path.endsWith("/cells/W~14"))).toMatchObject({ change: "added", after: 18500, label: expect.stringMatching(/ › W\/4$/) });
  });
});

describe("mock API idempotency keys", () => {
  beforeEach(() => mockReset());

  it("the same key again gets the first response and applies nothing twice; a different request with it is refused", async () => {
    const logged = async () => AuditPage.parse(await get("/audit?limit=100")).items.filter((e) => e.action.startsWith("review.")).length;
    const before = await logged();
    const send = () => mockRequest("POST", "/studies/st-northwind/versions/1/review/q1", { value: 9800, by: "Sam Rivera" }, "k1");
    const first = await send();
    expect(first.status).toBe(200);
    expect(await send()).toEqual(first);
    expect((await logged()) - before).toBe(1);
    expect((await mockRequest("POST", "/alerts/read", { by: "Sam Rivera" }, "k1")).status).toBe(422);
  });
});
