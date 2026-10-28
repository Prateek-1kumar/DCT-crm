import { bindEvidence, isoDate, reviewFromEvidence, runContractChecks } from "@dct/extraction";
import { type AlertPage, type AuditPage, capFollowUps, type ContractAnomaly, type DocumentDto, type ReviewItem, type Rulebook, RulebookVersionDto, SAMPLE } from "@dct/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appliesFromOf, manualRulebook } from "../src/domain.js";
import { fakeControls } from "../src/extraction/fake.js";
import { answer as answerDraft, askAbout, at, reviewDraft } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload } from "./helpers.js";

// The review lists that aren't flags (ADR-001 §6): interpretations picked blind, an amendment's start date, the random
// blind sample of confirmed values and what a miss holds back, and corrections an amendment's read couldn't carry over.

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
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const version = (id: string, v = 1) => get<RulebookVersionDto>(`/studies/${id}/versions/${v}`);
const auditOf = async (id: string) => (await get<AuditPage>(`/audit?studyId=${id}&limit=100`)).items;
const answer = async (id: string, item: string, body: object, v = 1) => {
  const res = await post(`/studies/${id}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RulebookVersionDto>().review.find((i) => i.id === item)!;
};
async function draft(seed = "s", opts?: { scan?: boolean }) {
  const s = await newStudy(app, seed, opts);
  expect((await extract(app, s.studyId)).job.state).toBe("succeeded");
  return s;
}
/** Settles every question but `except` the way settleAll does. */
const settleRest = async (studyId: string, v = 1, by = "Sam") => settleAll(built, studyId, v, by);

describe("interpretations, picked blind (ADR-001 §6)", () => {
  it("each field is a pick from its own values next to its quote, nothing preselected, and the read's value withheld until answered", async () => {
    const { studyId } = await draft();
    const raw = (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body;
    const v = RulebookVersionDto.parse(JSON.parse(raw)); // still a valid version: null only where withheld
    const pay = v.review.find((i) => i.id === "interpret:/payment/visitPayment/value")!;
    expect(pay).toMatchObject({ kind: "interpretation", reason: "INTERPRETATION", blocking: true, input: null, answer: null, outcome: null });
    expect(pay.options.map((o) => o.id)).toEqual(["auto_edc", "invoice", "mixed", "unspecified"]);
    expect(v.review.find((i) => i.id === "interpret:/siteFees/0/trigger")).toMatchObject({ question: "When is the site fee “Administrative fee” billed? The contract says: “due within ••• days of study initiation”" });
    // the read's values never leave the server while they're open: not in the master, the search or the log
    for (const p of ["/payment/visitPayment/value", "/siteFees/0/trigger", "/screenFail/basis", "/screenFail/paidVia", "/rounding/value", "/overhead/appliesTo/value"]) expect(at(v.rulebook, p), p).toBeNull();
    expect(JSON.stringify(v.rulebook)).not.toMatch(/auto_edc|study_initiation|printed_amounts|all_per_patient_lines/);
    // the cap's kind is asked, so its limit (cents or a count, by the kind) is withheld with it and isn't sampled
    expect(at(v.rulebook, "/screenFail/cap/n")).toBeNull();
    expect(v.review.some((i) => i.path === "/screenFail/cap/n")).toBe(false);
    // nor can "This looks wrong" ask it while it's withheld
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: "/screenFail/cap/n", note: "check", by: "Sam" })).json().message).toBe("There's already an open question about this value.");
  });

  it("a fee's trigger isn't findable by searching its words while it's asked", async () => {
    const { studyId } = await draft();
    const search = async (q: string) => (await get<{ hits: { path: string }[] }>(`/studies/${studyId}/versions/1/search?q=${encodeURIComponent(q)}`)).hits.map((h) => h.path);
    expect(await search("study initiation")).toEqual([]);
    expect(await search("administrative")).toEqual(["/siteFees/0"]); // its name still is
    await answer(studyId, "interpret:/siteFees/0/trigger", { optionId: "study_initiation" });
    expect(await search("study initiation")).toEqual(["/siteFees/0"]);
  });

  it("a pick that differs from the read shows both and is confirmed with a note; one that matches settles at once", async () => {
    const { studyId } = await draft();
    const id = "interpret:/payment/visitPayment/value";
    const differs = await answer(studyId, id, { optionId: "invoice" });
    expect(differs).toMatchObject({ outcome: "differs", compare: { typed: "invoice", read: "auto_edc", printed: null } });
    expect(at((await version(studyId)).rulebook, "/payment/visitPayment/value")).toBeNull(); // still open, still withheld
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(id)}`, { optionId: "invoice", by: "Sam" })).json().message).toMatch(/^Add a short note saying where the page prints this value/);
    expect(await answer(studyId, id, { optionId: "invoice", note: "§4.1: visits are invoiced monthly" })).toMatchObject({ outcome: "chosen", answer: { optionId: "invoice", noPdfText: true } });
    expect(at((await version(studyId)).rulebook, "/payment/visitPayment/value")).toBe("invoice");
    expect(await answer(studyId, "interpret:/rounding/value", { optionId: "printed_amounts" })).toMatchObject({ outcome: "matched" });
    // every interpretation is settled before approval
    await settleRest(studyId);
    const stored = await storedVersion(built, studyId, 1);
    expect(stored.review.filter((i) => i.kind === "interpretation").every((i) => i.outcome === "matched" || i.outcome === "chosen")).toBe(true);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("an AMBIGUOUS_TERM about one of them is that question, marked ambiguous; one about anything else stays its own", () => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    const note = (path: string, message: string): ContractAnomaly => ({ id: `AMBIGUOUS_TERM:${path}`, code: "AMBIGUOUS_TERM", severity: "warning", message, path, refs: [], detail: {}, resolution: null });
    const anomalies = [
      ...runContractChecks(rb), // overhead scope not stated
      note("/payment/visitPayment", "Ambiguous: whether the 25% applies to visits paid by EDC"),
      note("/payment/netDays/value", "Ambiguous: net days"),
    ];
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, anomalies, [], []);
    const pay = review.filter((i) => i.path === "/payment/visitPayment/value");
    expect(pay).toHaveLength(1);
    // marked, its message first (numbers blanked), and "not stated" isn't an answer to an unclear clause
    expect(pay[0]).toMatchObject({ id: "interpret:/payment/visitPayment/value", reason: "AMBIGUOUS_TERM", question: "Ambiguous: whether the •••% applies to visits paid by EDC. How are visits paid?" });
    expect(pay[0]!.options.map((o) => o.id)).toEqual(["auto_edc", "invoice", "mixed"]);
    expect(review.filter((i) => i.path === "/overhead/appliesTo/value").map((i) => i.reason)).toEqual(["AMBIGUOUS_TERM"]);
    expect(review.find((i) => i.id === "anomaly:AMBIGUOUS_TERM:/payment/netDays/value")).toMatchObject({ kind: "interpretation" });
  });

  it("what the holdback is taken from is typed, and compared with the read like a typed value", async () => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    rb.holdback = { pct: 5, appliesTo: "each visit payment", releaseConditions: ["database lock"], prov: rb.study.sponsor.prov };
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], [], []);
    const item = review.find((i) => i.id === "interpret:/holdback/appliesTo")!;
    expect(item).toMatchObject({ input: "text", options: [] });
    const d = { version: 1, byHand: false, rulebook: rb, review, evidence: [], editors: [] };
    expect(answerDraft(d, item.id, { value: "Each Visit Payment ", by: "Sam" }, isoDate)).toMatchObject({ outcome: "matched" });
    expect(answerDraft(d, item.id, { value: "every payment", by: "Ben" }, isoDate)).toMatchObject({ outcome: "differs" });
  });

  it("a cap's limit waits for its kind, and is asked again when the kind the person picks isn't the read's", async () => {
    // a scan: the limit isn't confirmed, so it's asked, but only once its kind is known (its question would name the kind)
    const { studyId } = await draft("scan", { scan: true });
    expect((await storedVersion(built, studyId, 1)).review.some((i) => i.path === "/screenFail/cap/n")).toBe(false);
    let v = (await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent("interpret:/screenFail/cap/kind")}`, { optionId: "blocks_with_reauth", by: "Sam" })).json<RulebookVersionDto>();
    expect(v.review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ id: "cap:/screenFail/cap/n", reason: "UNGROUNDED_VALUE", input: "number", outcome: null });
    expect(at(v.rulebook, "/screenFail/cap/n")).toBeNull();

    // a text PDF: the limit was confirmed as a count; an amount cap's limit is cents, so it's typed again
    const t = await draft("text");
    await answer(t.studyId, "interpret:/screenFail/cap/kind", { optionId: "amount" });
    v = (await post(`/studies/${t.studyId}/versions/1/review/${encodeURIComponent("interpret:/screenFail/cap/kind")}`, { optionId: "amount", note: "§5: “up to $7.00 in total”", by: "Sam" })).json<RulebookVersionDto>();
    expect(v.review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ reason: "CAP_KIND_CHANGED", input: "money" });
    expect(at(v.rulebook, "/screenFail/cap/n")).toBeNull();
    expect((await signOff(app, t.studyId, 1, { by: "Ben" })).json().message).toMatch(/questions? still need/);
    // the same kind as the read: a confirmed limit isn't asked
    const rb = (await storedVersion(built, t.studyId, 1)).rulebook!;
    const item = { id: "k", path: "/screenFail/cap/kind", outcome: "matched" } as ReviewItem;
    const evidence = [{ path: "/screenFail/cap/n", status: "confirmed" as const, where: [], printed: "7", note: null }];
    expect(capFollowUps({ rulebook: rb, review: [], evidence }, item, false, (p, id, r) => askAbout(rb, evidence, p, id, r))).toEqual([]);
  });
});

describe("a cap the person says has no limit", () => {
  it("drops its figures with its kind: nothing is billed by them, nothing is left to confirm, nothing more is asked", async () => {
    const { studyId } = await draft("scan", { scan: true });
    const id = "interpret:/screenFail/cap/kind";
    await answer(studyId, id, { optionId: "none" });
    const v = (await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(id)}`, { optionId: "none", note: "§5 sets no limit", by: "Sam" })).json<RulebookVersionDto>();
    expect(v.rulebook!.screenFail!.cap).toEqual({ kind: "none", n: null, ratio: null });
    expect(v.evidence.some((e) => e.path === "/screenFail/cap/n" || e.path === "/screenFail/cap/ratio")).toBe(false);
    expect(v.review.some((i) => i.path === "/screenFail/cap/n")).toBe(false);
    await settleRest(studyId);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("a correction to a cap's limit that didn't carry, while the cap's kind is asked, waits for it: never dropped", () => {
    const live = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    live.screenFail = { amountCents: 10000, basis: "fixed", cap: { kind: "count", n: 5, ratio: null }, paidVia: "invoice", requiredDocs: [], prov: live.study.sponsor.prov };
    const rb = structuredClone(live);
    rb.screenFail!.cap.n = 6;
    const carried = { from: 1, live, skipped: [{ path: "/screenFail/cap/n", before: 4, after: 5, by: "Asha", reason: "amendment_changed" }] };
    const out = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], [], [], { carried });
    expect(out.review.some((i) => i.path === "/screenFail/cap/n")).toBe(false); // its question would name the kind
    expect(out.evidence.find((e) => e.path === "/screenFail/cap/n")).toMatchObject({ status: "ungrounded" }); // so it's asked once the kind is
    const kind = out.review.find((i) => i.path === "/screenFail/cap/kind")!;
    const d = { version: 2, byHand: false, rulebook: rb, review: out.review, evidence: out.evidence, editors: [] };
    answerDraft(d, kind.id, { optionId: "count", by: "Sam" }, isoDate);
    expect(capFollowUps(d, kind, false, (p, id, r) => askAbout(rb, d.evidence, p, id, r))).toEqual([expect.objectContaining({ path: "/screenFail/cap/n", reason: "UNGROUNDED_VALUE" })]);
  });
});

describe("an amendment's start date (RETROACTIVE_NO_DATE, ADR-001 §6)", () => {
  const amended = (): Rulebook => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    rb.documents = [
      { id: "d1", kind: "work_order", title: "Work order", date: "2025-01-10" },
      { id: "d2", kind: "amendment", title: "Amendment 1", date: "2026-03-01" },
    ];
    rb.study.effectiveDate = { value: "2025-01-10", prov: rb.study.effectiveDate.prov };
    rb.appliesFrom = { value: null, prov: { source: { documentId: "d2", page: 1, quote: "The new rates shall apply retroactively." }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } };
    return rb;
  };

  it("no date: a blocker, typed or 'prospective only' (the amendment's own date, shown), never the contract's effective date", () => {
    const rb = amended();
    expect(appliesFromOf(rb)).toBe("2025-01-10"); // what billing would use unasked: retroactive to the base contract
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], [], { amendment: true });
    expect(review.filter((i) => i.path === "/appliesFrom/value")).toHaveLength(1); // the check's flag is this question
    const q = review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q).toMatchObject({ id: "interpret:/appliesFrom/value", kind: "contract_problem", reason: "RETROACTIVE_NO_DATE", blocking: true, input: "date", where: [{ documentId: "d2", page: 1, box: null }] });
    expect(q.question).toMatch(/^The amendment says its new prices apply retroactively, but gives no start date/);
    expect(q.options).toEqual([{ id: "prospective", label: "Prospective only: from the amendment's own date, March 1, 2026" }]);

    const pick = { version: 1, byHand: false, rulebook: structuredClone(rb), review: structuredClone(review), evidence: [], editors: [] };
    expect(answerDraft(pick, q.id, { optionId: "prospective", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen", set: { path: "/appliesFrom/value", before: null, after: "2026-03-01" } });
    expect(appliesFromOf(pick.rulebook)).toBe("2026-03-01");
    const typed = { version: 1, byHand: false, rulebook: structuredClone(rb), review: structuredClone(review), evidence: [], editors: [] };
    expect(answerDraft(typed, q.id, { value: "2025-11-01", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen", set: { after: "2025-11-01" } });
    expect(typed.review.find((i) => i.id === q.id)!.answer).toMatchObject({ value: "2025-11-01" });
    expect(() => answerDraft(typed, q.id, { by: "Ben" }, isoDate)).toThrow("Type a value, or say you can't tell.");
  });

  it("asked on any amendment that gives no date, retroactive or not; a stated date is an interpretation, checked like a typed one", () => {
    const rb = amended();
    rb.appliesFrom.prov.source!.quote = "This amendment amends the agreement.";
    let q = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], [], { amendment: true }).review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q).toMatchObject({ reason: "RETROACTIVE_NO_DATE", question: expect.stringMatching(/^The amendment doesn't say from what date its new terms apply/) });
    rb.appliesFrom.value = "2026-02-01";
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], [], { amendment: true });
    q = review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q).toMatchObject({ kind: "interpretation", reason: "INTERPRETATION", input: "date" });
    const d = { version: 1, byHand: false, rulebook: rb, review, evidence: [], editors: [] };
    expect(answerDraft(d, q.id, { optionId: "prospective", by: "Sam" }, isoDate)).toMatchObject({ outcome: "differs" }); // March 1 isn't the read's February 1
    expect(answerDraft(d, q.id, { value: "2026-02-01", note: "§1 says February 1", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen" });
    // a contract that isn't an amendment and gives no date asks nothing
    const base = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    expect(reviewDraft({ bindEvidence, reviewFromEvidence }, base, [], [], []).review.some((i) => i.path === "/appliesFrom/value")).toBe(false);
  });

  it("an amendment read asks it, and approval waits for it", async () => {
    const { studyId } = await liveStudy(built);
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    await extract(app, studyId, { documentIds: [amend!.id] });
    const v = await version(studyId, 2);
    expect(v.review.find((i) => i.path === "/appliesFrom/value")).toMatchObject({ kind: "interpretation", input: "date", outcome: null });
    expect(at(v.rulebook, "/appliesFrom/value")).toBeNull();
    // nor the date it's stored as for the version list
    expect(v.appliesFrom).toBeNull();
    expect((await get<{ versions: { version: number; appliesFrom: string | null }[] }>(`/studies/${studyId}`)).versions.find((x) => x.version === 2)!.appliesFrom).toBeNull();
    await settleRest(studyId, 2);
    expect((await signOff(app, studyId, 2, { by: "Ben" })).statusCode).toBe(200);
    expect((await version(studyId, 2)).appliesFrom).toBe("2026-01-01");
  });
});

describe("the blind sample of confirmed values (ADR-001 §6)", () => {
  const CELL = "/budgetGrids/0/procedures/0/cells/V1"; // sampled with the draw pinned; the page prints 55.00

  it("10 confirmed values, spread over the kinds of value, stored with the version and never drawn again", async () => {
    const { studyId } = await draft();
    const v = await version(studyId);
    const sample = v.review.filter((i) => i.reason === SAMPLE);
    expect(sample).toHaveLength(10);
    expect(new Set(sample.map((i) => i.path!.split("/")[1]))).toEqual(new Set(["budgetGrids", "invoiceables", "study", "siteFees"]));
    expect(sample.every((i) => i.kind === "confirm_value" && i.blocking && at(v.rulebook, i.path!) === null)).toBe(true);
    // stored: a reload reads the same questions; nothing draws again
    expect((await version(studyId)).review.filter((i) => i.reason === SAMPLE).map((i) => i.id)).toEqual(sample.map((i) => i.id));
    expect((await storedVersion(built, studyId, 1)).review.filter((i) => i.reason === SAMPLE)).toHaveLength(10);
  });

  it("not on a draft typed by hand, nor on a correction copied from the live version", async () => {
    const { studyId } = await liveStudy(built);
    const res = await post(`/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Sam" });
    expect(res.json<RulebookVersionDto>().review.map((i) => i.reason)).toEqual(["reported"]);
  });

  it("a miss: kept after looking again, it blocks approval until its kind of value is proofread, is logged as an incident and alerted", async () => {
    const { studyId } = await draft();
    const id = `sample:${CELL}`;
    // first "Look at the close-up again": the PDF's own text says otherwise; nothing has missed yet
    expect(await answer(studyId, id, { value: 5600 })).toMatchObject({ outcome: "differs", compare: { typed: 5600, read: 5500, printed: "55.00" } });
    expect((await auditOf(studyId)).map((e) => e.action)).not.toContain("sample.missed");
    // picking the PDF's text after looking again isn't a miss
    const other = `sample:/budgetGrids/0/procedures/0/cells/V2`;
    await answer(studyId, other, { value: 5700 });
    expect(await answer(studyId, other, { value: 5500 })).toMatchObject({ outcome: "chosen" });
    expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === other)!.missed).toBeUndefined();
    // kept: the sample missed
    expect(await answer(studyId, id, { value: 5600, note: "The page prints $56.00; the text layer is off" })).toMatchObject({ outcome: "chosen", missed: true });
    const incident = (await auditOf(studyId)).filter((e) => e.action === "sample.missed");
    expect(incident).toEqual([expect.objectContaining({ by: "Sam", detail: expect.objectContaining({ version: 1, itemId: id, path: CELL, values: "budget grid prices" }) })]);
    const alert = (await get<AlertPage>("/alerts?for=Ben&limit=50")).items.find((a) => a.kind === "sample_missed")!;
    expect(alert).toMatchObject({ studyId, version: 1, by: "Sam", read: false });

    await settleRest(studyId);
    // every grid price the PDF check confirmed and nobody typed: the other grid's three
    const left = ["/budgetGrids/1/procedures/0/cells/V1", "/budgetGrids/1/procedures/0/cells/V2", "/budgetGrids/1/procedures/0/unitCents"];
    const refused = await signOff(app, studyId, 1, { by: "Ben" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe("A random spot check found a wrong number among the budget grid prices, so each of them has to be proofread before approval: 3 of 6 still to check.");
    // changing the answer back doesn't undo it: the miss stands, and so does the check of its kind
    await answer(studyId, id, { value: 5500, by: "Avery" });
    expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === id)).toMatchObject({ outcome: "matched", missed: true });
    expect((await auditOf(studyId)).filter((e) => e.action === "sample.missed")).toHaveLength(1);
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: left.slice(0, 2), by: "Avery" });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).json().message).toMatch(/: 1 of 6 still to check\.$/);
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: left.slice(2), by: "Avery" });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("a re-typer who only re-typed the sample, as read, isn't an editor; one who changed a value is", async () => {
    const { studyId } = await draft();
    const sample = (await storedVersion(built, studyId, 1)).review.filter((i) => i.reason === SAMPLE);
    const rb = (await storedVersion(built, studyId, 1)).rulebook;
    for (const i of sample) await answer(studyId, i.id, { value: at(rb, i.path!), by: "Morgan" });
    expect((await version(studyId)).editors).not.toContain("Morgan");
    await answer(studyId, `sample:${CELL}`, { value: 5600, by: "Avery" });
    await answer(studyId, `sample:${CELL}`, { value: 5600, note: "page 2", by: "Avery" });
    expect((await version(studyId)).editors).toContain("Avery");
  });
});

describe("corrections an amendment's read couldn't carry over", () => {
  const FEE = "/siteFees/0/amountCents";

  it("each is said on the draft, and asked again blind where the value is now (a moved item found by its identity)", async () => {
    const { studyId } = await draft();
    // version 1: the admin fee (reported) and the unscheduled visit (re-typed in the sample) corrected, each kept over the
    // PDF's text with a reason
    const fee = (await post(`/studies/${studyId}/versions/1/report`, { path: FEE, note: "check", by: "Asha" })).json<RulebookVersionDto>().review.at(-1)!.id;
    for (const [id, value] of [[fee, 1250000], ["sample:/invoiceables/0/amountWithOverheadCents", 85000]] as const) {
      await answer(studyId, id, { value, by: "Asha" });
      await answer(studyId, id, { value, note: "the page prints it", by: "Asha" });
    }
    await settleRest(studyId);
    // the sample missed, so the last fee amount nobody typed is proofread first
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: ["/screenFail/amountCents"], by: "Asha" });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);

    // the amendment's read adds a fee in front (so the admin fee is /siteFees/1 now) and reads the unscheduled visit anew
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    await extract(app, studyId, { documentIds: [amend!.id] });
    const v2 = await version(studyId, 2);
    expect(v2.warnings).toEqual([
      "A correction from version 1 wasn't carried over: Site fee › Administrative fee › Amount, corrected by Asha. The amendment's reading has a different value there, so it's asked again in Needs you.",
      "A correction from version 1 wasn't carried over: Invoiceable › Unscheduled visit › Amount with overhead, corrected by Asha. The amendment's reading has a different value there, so it's asked again in Needs you.",
    ]);
    expect(v2.review.filter((i) => i.reason === "CORRECTION_NOT_CARRIED").map((i) => [i.id, i.question])).toEqual([
      ["carried:/siteFees/1/amountCents", "Asha corrected Site fee › Administrative fee › Amount on version 1, but the amendment's reading has a different value there, so the correction wasn't carried over. What does the contract print for it now?"],
    ]);
    // the other is asked already (the PDF's text says otherwise there): once
    expect(v2.review.filter((i) => i.path === "/invoiceables/0/amountWithOverheadCents").map((i) => i.reason)).toEqual(["VALUE_CONFLICT"]);
    expect([at(v2.rulebook, "/siteFees/1/amountCents"), at(v2.rulebook, "/invoiceables/0/amountWithOverheadCents")]).toEqual([null, null]);
    // the log's account of it holds no value while it's asked again
    const skipped = () => auditOf(studyId).then((l) => l.find((e) => e.action === "version.corrections_carried")!.detail.skipped as Record<string, unknown>[]);
    expect(await skipped()).toEqual([expect.objectContaining({ reason: "item_moved", askedAt: "/siteFees/1/amountCents" }), expect.objectContaining({ reason: "amendment_changed" })]);
    expect((await skipped()).some((k) => "after" in k)).toBe(false);
    await settleRest(studyId, 2);
    expect((await skipped())[0]).toMatchObject({ before: 1200000, after: 1250000 });
  });

  it("one the new read doesn't have at all is asked: still in the contract (bill it by hand), or removed", () => {
    const live = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    live.siteFees = [{ code: "PH", name: "Pharmacy fee", amountCents: 150000, trigger: "one_time", dueDays: null, prov: { source: { documentId: "d1", page: 7 }, confidence: 1, method: "manual", crossCheck: "not_checked" } }];
    live.documents = [{ id: "d1", kind: "work_order", title: "Work order", date: null }];
    const rb = structuredClone(live);
    rb.siteFees = [];
    const carried = { from: 1, live, skipped: [{ path: "/siteFees/0/amountCents", before: 140000, after: 150000, by: "Asha", items: ["PH"], reason: "path_missing" }, { path: "/study/protocol/value", before: "P1", after: "P-1", by: "Asha", reason: "amendment_changed" }] };
    const out = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], [], [], { carried });
    const lost = out.review.find((i) => i.reason === "CORRECTION_LOST")!;
    expect(lost).toMatchObject({ kind: "unaccounted", path: null, blocking: true, where: [{ documentId: "d1", page: 7, box: null }], options: [{ id: "removed" }, { id: "bill_by_hand" }] });
    // a name isn't a billing value: said, not asked
    expect(out.warnings).toEqual([
      "A correction from version 1 wasn't carried over: Site fee › Pharmacy fee › Amount, corrected by Asha. The amendment's reading doesn't have it any more, so Needs you asks whether it's still in the contract.",
      "A correction from version 1 wasn't carried over: Study › Protocol, corrected by Asha. Check it in the invoicing master.",
    ]);
    const d = { version: 2, byHand: false, rulebook: rb, review: out.review, evidence: out.evidence, editors: [] };
    expect(answerDraft(d, lost.id, { optionId: "bill_by_hand", note: "Pharmacy set-up $1,500 once", by: "Sam" }, isoDate)).toMatchObject({ outcome: "chosen", listed: { added: "Page 7 of “Work order”" } });
    expect(d.rulebook.unclassified).toMatchObject([{ page: 7, note: "Pharmacy set-up $1,500 once", itemId: lost.id }]);
  });
});
