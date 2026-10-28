import { describe, expect, it, beforeEach } from "vitest";
import { AlertPage, AuditPage, DiffEntry, MasterSearch, RulebookVersionDto, SearchResults, StudyCounts, StudyDetailDto, StudyPage } from "@dct/shared";
import { blankInvoiceable } from "../byhand";
import { askAbout, makeRulebook, SEEDS } from "./fixtures";
import { mockRequest, mockReset } from "./server";

const get = async (path: string) => (await mockRequest("GET", path, undefined)).json;
const list = async (q = "") => StudyPage.parse(await get(`/studies?limit=100${q}`)).items;
const post = (path: string, body: unknown) => mockRequest("POST", path, body);
const answer = async (study: string, item: string, body: Record<string, unknown>) =>
  RulebookVersionDto.parse((await post(`/studies/${study}/versions/1/review/${item}`, { by: "Sam Rivera", ...body })).json);

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
    expect(seeded.items.find((a) => a.studyId === "st-northwind")).toMatchObject({ kind: "questions_ready", count: 7, protocol: "NWP-418-02", read: false });

    // One answer that leaves questions open changes nothing; the last one makes it ready for approval.
    await answer("st-northwind", "q1", { value: 9800 });
    expect((await alerts("Taylor Brooks")).items).toHaveLength(seeded.items.length);
    const v = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    for (const i of v.review.filter((x) => x.outcome === null))
      await answer("st-northwind", i.id, i.options.length ? { optionId: i.options[0]!.id } : { value: 1, note: "checked" }).then(async (r) => {
        if (r.review.find((x) => x.id === i.id)!.outcome === "differs") await answer("st-northwind", i.id, { value: 1, note: "checked" });
      });
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
    const hidden = nw.review.find((i) => i.path === "/screenFail/amountCents")!;
    expect(hidden.outcome).toBeNull();
    const cents = (nw.rulebook!.screenFail!.amountCents! / 100).toFixed(2);
    const hits = MasterSearch.parse(await get(`/studies/st-northwind/versions/1/search?q=${cents}`)).hits;
    expect(hits.map((h) => h.path)).not.toContain("/screenFail");
  });

  it("seeds a text PDF in Needs you, a scan, a live study and one waiting for approval", async () => {
    const nw = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    expect(nw.review).toHaveLength(7);
    expect(nw.review.filter((i) => i.reason === "spot_check")).toHaveLength(2);
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
    expect(raw).not.toMatch(/truth|secret|apply/);
  });

  it("matches, differs, then settles (a note only to keep your own value over the PDF text); answers can change; options are chosen", async () => {
    // q1: the tool read $93.00, the page prints $98.00.
    let v = await answer("st-northwind", "q1", { value: 9800 });
    expect(v.review.find((i) => i.id === "q1")).toMatchObject({ outcome: "matched", compare: null });
    expect(v.rulebook!.budgetGrids[0]!.procedures[3]!.cells.V2).toBe(9800);
    expect(v.evidence.find((e) => e.path === "/budgetGrids/0/procedures/3/cells/V2")!.status).toBe("attested");

    v = await answer("st-northwind", "q5", { value: 2600 });
    expect(v.review.find((i) => i.id === "q5")).toMatchObject({ outcome: "differs", compare: { typed: 2600, read: 2500, printed: "$25.00" } });
    expect((await post("/studies/st-northwind/versions/1/review/q5", { value: 2600, by: "Sam Rivera" })).status).toBe(400);
    v = await answer("st-northwind", "q5", { value: 2500 });
    expect(v.review.find((i) => i.id === "q5")).toMatchObject({ outcome: "chosen", compare: null });

    // Changing an earlier answer while the version is a draft: it is checked again.
    v = await answer("st-northwind", "q1", { value: 9900 });
    expect(v.review.find((i) => i.id === "q1")!.outcome).toBe("differs");
    v = await answer("st-northwind", "q1", { value: 9800 });
    expect(v.review.find((i) => i.id === "q1")!.outcome).toBe("chosen");

    v = await answer("st-northwind", "q2", { optionId: "g-nw-b" });
    expect(v.rulebook!.governingGridId).toBe("g-nw-b");
    expect((await post("/studies/st-northwind/versions/1/review/q2", { optionId: "nope", by: "Sam" })).status).toBe(400);
    v = await answer("st-northwind", "q7", { cantTell: true });
    expect(v.review.find((i) => i.id === "q7")!.outcome).toBe("cant_tell");
    expect(v.editors).toEqual(["Sam Rivera"]);
  });

  it("refuses approval while blocking questions are unsettled, then applies maker-checker", async () => {
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Morgan Lee" })).status).toBe(409);
    const v = RulebookVersionDto.parse(await get("/studies/st-northwind/versions/1"));
    for (const i of v.review.filter((x) => x.blocking))
      await answer("st-northwind", i.id, i.options.length ? { optionId: i.options[0]!.id } : { value: 1, note: "checked" }).then(async (r) => {
        if (r.review.find((x) => x.id === i.id)!.outcome === "differs") await answer("st-northwind", i.id, { value: 1, note: "checked" });
      });
    await mockRequest("PATCH", "/settings", { makerChecker: true, by: "Morgan Lee" });
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Sam Rivera" })).status).toBe(409);
    expect((await post("/studies/st-northwind/versions/1/sign-off", { by: "Morgan Lee" })).status).toBe(200);
    expect(StudyDetailDto.parse(await get("/studies/st-northwind")).status).toBe("live");
  });

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
    await answer("st-northwind", "q5", { value: 2600 });
    expect((await answer("st-northwind", "q5", { value: 2500 })).review.find((i) => i.id === "q5")!.answer).not.toHaveProperty("noPdfText");
  }, 30_000);

  it("a note never gives a value away while its question is open: the version, the log, its search and the alert", async () => {
    const ha = RulebookVersionDto.parse(await get("/studies/st-halcyon/versions/2"));
    const a2 = ha.review.find((i) => i.id === "a2")!; // Remote monitoring visit, answered $420.00
    const note = "Page 4 prints $420.00 (four hundred twenty), see §3";
    const blanked = "Page 4 prints $••• (•••), see §3";
    await post("/studies/st-halcyon/versions/2/send-back", { itemIds: [a2.id], note, by: "Morgan Lee" });
    const refused = await post("/studies/st-halcyon/versions/2/send-back", { itemIds: [a2.id], note, by: "Morgan Lee" }); // now unanswered
    expect(refused.status).toBe(400);
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
    expect(v0).toMatchObject({ version: 2, status: "draft", byHand: true, evidence: [], review: [] });
    const type = async (path: string, value: unknown) => {
      const r = await mockRequest("PATCH", "/studies/st-solace/versions/2/values", { path, value, note: "Typed by hand", by: "Avery Chen" });
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
    expect((await mockRequest("PATCH", "/studies/st-solace/versions/2/values", { path: "/budgetGrids/0/visits/0/totalCents", value: null, note: "x", by: "Avery Chen" })).status).toBe(400);
    expect((await list()).find((s) => s.id === "st-solace")!.needsYou).toBe(1);

    // 3 typed values → all 3 are re-typed.
    v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/2/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.review).toHaveLength(3);
    expect(v.review.every((i) => i.reason === "spot_check" && i.blocking && i.answer === null)).toBe(true);
    expect((await mockRequest("PATCH", "/studies/st-solace/versions/2/values", { path: "/payment/netDays/value", value: 30, note: "x", by: "Avery Chen" })).status).toBe(409);
    const days = v.review.find((i) => i.path === "/payment/netDays/value")!;
    expect((await post(`/studies/st-solace/versions/2/review/${days.id}`, { value: 45, by: "Avery Chen" })).status).toBe(409);
    v = RulebookVersionDto.parse((await post(`/studies/st-solace/versions/2/review/${days.id}`, { value: 40, by: "Sam Rivera" })).json);
    expect(v.review.find((i) => i.id === days.id)).toMatchObject({ outcome: "differs", compare: { typed: 40, read: 45, printed: null } });
  }, 30_000); // many requests, each with the mock's simulated network delay

  it("re-types at most 10 hand-typed values", async () => {
    await post("/studies/st-solace/versions/by-hand", { by: "Avery Chen" });
    const patch = async (path: string, value: unknown) =>
      RulebookVersionDto.parse((await mockRequest("PATCH", "/studies/st-solace/versions/2/values", { path, value, note: "x", by: "Avery Chen" })).json);
    for (let i = 0; i < 4; i++) {
      const rb = (await patch("/payment/netDays/value", null)).rulebook!;
      await patch("/invoiceables", [...rb.invoiceables, blankInvoiceable()]);
      for (const k of ["name", "amountCents", "amountWithOverheadCents"]) await patch(`/invoiceables/${i}/${k}`, k === "name" ? `Item ${i}` : 1000 * (i + 1));
    }
    const v = RulebookVersionDto.parse((await post("/studies/st-solace/versions/2/by-hand/done", { by: "Avery Chen" })).json);
    expect(v.evidence).toHaveLength(12);
    expect(v.review).toHaveLength(10);
  }, 30_000); // many requests, each with the mock's simulated network delay

  it("amendment diff lists changed fees with readable labels", async () => {
    const diff = DiffEntry.array().parse(await get("/studies/st-halcyon/versions/2/diff?against=1"));
    expect(diff.find((e) => e.path === "/payment/netDays/value")).toMatchObject({ change: "changed", before: 45, after: 30, label: "Payment › Net days" });
    expect(diff.some((e) => e.change === "added" && e.label.includes("Remote monitoring visit"))).toBe(true);
  });
});
