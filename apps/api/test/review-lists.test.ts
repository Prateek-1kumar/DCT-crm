import { bindEvidence, lastSigned, reviewFromEvidence, runContractChecks, type TextPage } from "@dct/extraction";
import { type AlertPage, type AuditPage, capFollowUps, checkedByMachine, type ContractAnomaly, type DocumentDto, type ReviewItem, type Rulebook, RulebookVersionDto, suggest, type ValueEvidence } from "@dct/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appliesFromOf, manualRulebook } from "../src/domain.js";
import { fakeControls } from "../src/extraction/fake.js";
import { answer as answerDraft, askAbout, at, needsYouOf, reviewDraft } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload } from "./helpers.js";

// The review lists that aren't flags (ADR-001 §6): interpretations, an amendment's start date, and corrections an
// amendment's read couldn't carry over. Each question shows our reading (ADR-003).

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

describe("interpretations (ADR-001 §6)", () => {
  it("each field is a pick from its own values next to its quote, nothing preselected, and the read's value shown", async () => {
    const { studyId } = await draft();
    const raw = (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body;
    const v = RulebookVersionDto.parse(JSON.parse(raw));
    const pay = v.review.find((i) => i.id === "interpret:/payment/visitPayment/value")!;
    expect(pay).toMatchObject({ kind: "interpretation", reason: "INTERPRETATION", blocking: true, input: null, answer: null, outcome: null });
    expect(pay.options.map((o) => o.id)).toEqual(["auto_edc", "invoice", "mixed", "unspecified"]);
    // the fee's trigger is printed beside its confirmed amount ("…of study initiation"): not asked (ADR-003)
    expect(v.review.some((i) => i.id === "interpret:/siteFees/0/trigger")).toBe(false);
    // the read's values are shown while they're asked (ADR-003)
    expect(at(v.rulebook, "/payment/visitPayment/value")).toBe("auto_edc");
    // the cap's kind is asked, so its limit (cents or a count, by the kind) waits for it, and isn't asked on its own
    expect(v.review.some((i) => i.path === "/screenFail/cap/n")).toBe(false);
    // nor can "This looks wrong" ask it while its kind is asked
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: "/screenFail/cap/n", note: "check", by: "Sam" })).json().message).toBe("There's already an open question about this value.");
  });

  it("a pick that differs from the read shows both and is confirmed with a note; one that matches settles at once", async () => {
    const { studyId } = await draft();
    const id = "interpret:/payment/visitPayment/value";
    const differs = await answer(studyId, id, { optionId: "invoice" });
    expect(differs).toMatchObject({ outcome: "differs", compare: { typed: "invoice", read: "auto_edc", printed: null } });
    expect(at((await version(studyId)).rulebook, "/payment/visitPayment/value")).toBe("auto_edc"); // still open: the read's value stands
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(id)}`, { optionId: "invoice", by: "Sam" })).json().message).toMatch(/^Add a short note saying where the page prints this value/);
    expect(await answer(studyId, id, { optionId: "invoice", note: "§4.1: visits are invoiced monthly" })).toMatchObject({ outcome: "chosen", answer: { optionId: "invoice", noPdfText: true } });
    expect(at((await version(studyId)).rulebook, "/payment/visitPayment/value")).toBe("invoice");
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
    expect(pay[0]).toMatchObject({ id: "interpret:/payment/visitPayment/value", reason: "AMBIGUOUS_TERM", question: "Ambiguous: whether the 25% applies to visits paid by EDC. How are visits paid?" });
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
    expect(answerDraft(d, item.id, { value: "Each Visit Payment ", by: "Sam" })).toMatchObject({ outcome: "matched" });
    expect(answerDraft(d, item.id, { value: "every payment", by: "Ben" })).toMatchObject({ outcome: "differs" });
  });

  it("a cap's limit waits for its kind, and is asked again when the kind the person picks isn't the read's", async () => {
    // a scan: the limit isn't confirmed, so it's asked, but only once its kind is known (its question would name the kind)
    const { studyId } = await draft("scan", { scan: true });
    expect((await storedVersion(built, studyId, 1)).review.some((i) => i.path === "/screenFail/cap/n")).toBe(false);
    let v = (await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent("interpret:/screenFail/cap/kind")}`, { optionId: "blocks_with_reauth", by: "Sam" })).json<RulebookVersionDto>();
    expect(v.review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ id: "cap:/screenFail/cap/n", reason: "UNGROUNDED_VALUE", input: "number", outcome: null });

    // a text PDF: the limit was confirmed as a count; an amount cap's limit is cents, so it's typed again
    const t = await draft("text");
    await answer(t.studyId, "interpret:/screenFail/cap/kind", { optionId: "amount" });
    v = (await post(`/studies/${t.studyId}/versions/1/review/${encodeURIComponent("interpret:/screenFail/cap/kind")}`, { optionId: "amount", note: "§5: “up to $7.00 in total”", by: "Sam" })).json<RulebookVersionDto>();
    expect(v.review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ reason: "CAP_KIND_CHANGED", input: "money" });
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
    answerDraft(d, kind.id, { optionId: "count", by: "Sam" });
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

  it("no date: a blocker, typed or 'prospective only' (the amendment's own date, typed blind), never the contract's effective date", () => {
    const rb = amended();
    expect(appliesFromOf(rb)).toBe("2025-01-10"); // what billing would use unasked: retroactive to the base contract
    const { review } = reviewDraft({ bindEvidence, reviewFromEvidence }, rb, runContractChecks(rb), [], [], { amendment: true });
    expect(review.filter((i) => i.path === "/appliesFrom/value")).toHaveLength(1); // the check's flag is this question
    const q = review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q).toMatchObject({ id: "interpret:/appliesFrom/value", kind: "contract_problem", reason: "RETROACTIVE_NO_DATE", blocking: true, input: "date", where: [{ documentId: "d2", page: 1, box: null }] });
    expect(q.question).toMatch(/^The amendment says its new prices apply retroactively, but gives no start date/);
    // the read's date of the amendment isn't shown: nothing checked it, so the person types it from the amendment
    expect(q.options).toEqual([{ id: "prospective", label: "Prospective only: from the amendment's own date" }]);

    const pick = { version: 1, byHand: false, rulebook: structuredClone(rb), review: structuredClone(review), evidence: [], editors: [] };
    expect(answerDraft(pick, q.id, { optionId: "prospective", value: "2026-03-01", by: "Sam" })).toMatchObject({ outcome: "matched", set: { path: "/appliesFrom/value", before: null, after: "2026-03-01" } });
    expect(appliesFromOf(pick.rulebook)).toBe("2026-03-01");
    const typed = { version: 1, byHand: false, rulebook: structuredClone(rb), review: structuredClone(review), evidence: [], editors: [] };
    expect(answerDraft(typed, q.id, { value: "2025-11-01", by: "Sam" })).toMatchObject({ outcome: "chosen", set: { after: "2025-11-01" } });
    expect(typed.review.find((i) => i.id === q.id)!.answer).toMatchObject({ value: "2025-11-01" });
    expect(() => answerDraft(typed, q.id, { by: "Ben" })).toThrow("Type a value, or say you can't tell.");
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
    expect(answerDraft(d, q.id, { optionId: "prospective", value: "2026-03-01", by: "Sam" })).toMatchObject({ outcome: "differs" }); // March 1 isn't the read's February 1
    expect(answerDraft(d, q.id, { value: "2026-02-01", note: "§1 says February 1", by: "Sam" })).toMatchObject({ outcome: "chosen" });
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
    await settleRest(studyId, 2);
    expect((await signOff(app, studyId, 2, { by: "Ben" })).statusCode).toBe(200);
    expect((await version(studyId, 2)).appliesFrom).toBe("2026-01-01");
  });
});

describe("a date the contract ties to its last signature: the e-signature record's latest date is suggested, never written (issue B)", () => {
  /** A page of the PDF's own text, as words in reading order. */
  const text = (documentId: string, page: number, words: string, source: TextPage["source"] = "text"): TextPage => ({
    documentId, page, width: 600, height: 800, source, hidden: 0, largePicture: false,
    words: words.split(" ").map((t, i) => ({ text: t, rect: [0, i, 10, i + 1], dir: 0, block: 0, line: i, hidden: false })),
  });
  const RECORD = "Certificate Of Completion Signer Events Sent: 2024-03-01 Signed: 2024-03-04 Signed: 2024-03-05 Viewed: 2024-03-09";
  const signedOff = (documentId = "d1", page = 9) => [{ documentId, page, kind: "esign_certificate" }];
  const docs = [{ id: "d1", filename: "CTA.pdf" }, { id: "d2", filename: "Amendment 1.pdf" }];
  const port = { bindEvidence, reviewFromEvidence, lastSigned };
  const contract = (): Rulebook => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    rb.documents = [{ id: "d1", kind: "master_agreement", title: "CTA", date: null }];
    rb.study.effectiveDate = { value: null, prov: { source: { documentId: "d1", page: 1 }, confidence: 0.3, method: "ai", crossCheck: "not_checked" } };
    return rb;
  };
  const flag = (message: string): ContractAnomaly => ({ id: "AMBIGUOUS_TERM:/study/effectiveDate", code: "AMBIGUOUS_TERM", severity: "warning", message, path: "/study/effectiveDate", refs: [{ documentId: "d1", page: 1 }], detail: {}, resolution: null });
  const TIED = flag("Effective date: the agreement is effective on the last signature date, but the signature page is not among the provided pages");
  const dateQ = (out: ReturnType<typeof reviewDraft>, path = "/study/effectiveDate/value") => out.review.find((i) => i.path === path)!;

  it("names the record in our own words and suggests its latest date of signature; taking it is typing it, and nothing is written or confirmed until then", () => {
    const rb = contract();
    const out = reviewDraft(port, rb, [TIED], [text("d1", 1, "Effective on the date of last signature."), text("d1", 9, RECORD)], docs, { excluded: signedOff() });
    const q = dateQ(out);
    expect(q.question).toBe("The contract takes effect on the date it was last signed. Its e-signature record is page 9 of “CTA.pdf”. What date does it take effect?");
    expect(q.where).toEqual([{ documentId: "d1", page: 9, box: null }, { documentId: "d1", page: 1, box: null }]);
    // the latest signing, not a later "viewed"
    expect(q.signedOn).toEqual({ date: "2024-03-05", page: 9, printed: "2024-03-05" });
    expect(suggest(q, { rulebook: rb, evidence: out.evidence })).toMatchObject({ value: "2024-03-05" });
    // never auto-confirmed: the master holds no date and no evidence vouches for one
    expect(rb.study.effectiveDate.value).toBeNull();
    expect(out.evidence.filter((e) => e.path === "/study/effectiveDate/value" && (checkedByMachine(e.status) || e.status === "attested"))).toEqual([]);
    const d = { version: 1, byHand: false, rulebook: rb, review: out.review, evidence: out.evidence, editors: [] };
    expect(answerDraft(d, q.id, { value: "2024-03-05", by: "Sam" })).toMatchObject({ outcome: "chosen", set: { path: "/study/effectiveDate/value", after: "2024-03-05" } });
    expect(d.evidence.find((e) => e.path === "/study/effectiveDate/value")).toMatchObject({ status: "attested", note: "Typed by Sam" });
  });

  it("suggests nothing where the record gives no one date, is a scan, or isn't there; the question stays as it was without a record or a tie", () => {
    const rb = contract();
    const run = (pages: TextPage[], anomalies = [TIED], excluded = signedOff()) => dateQ(reviewDraft(port, rb, anomalies, pages, docs, { excluded }));
    // "3/4/2024" reads month first and day first alike, and nothing on the record says which
    const twoWays = run([text("d1", 9, "Signer Events Signed: 3/4/2024 1:17:04 PM")]);
    expect(twoWays).toMatchObject({ question: expect.stringMatching(/^The contract takes effect on the date it was last signed\. Its e-signature record is page 9/) });
    expect(twoWays.signedOn).toBeUndefined();
    expect(suggest(twoWays, { rulebook: rb, evidence: [] })).toBeNull();
    // a scanned record: our OCR's digits are no date to offer
    expect(run([text("d1", 9, RECORD, "ocr")]).signedOn).toBeUndefined();
    // no e-signature record (signed in ink): as it was
    const ink = run([text("d1", 9, "Signed: 2024-03-05")], [TIED], []);
    expect(ink).toMatchObject({ question: `${TIED.message}. What does the contract mean?`, where: [{ documentId: "d1", page: 1, box: null }] });
    expect(ink.signedOn).toBeUndefined();
    // not tied to signing ("regardless of the date of signature"), or flagged about something else: as it was
    for (const m of ["Effective date: two different dates are printed", "Effective as of January 1, regardless of the date of signature"]) expect(run([text("d1", 9, RECORD)], [flag(m)])).toMatchObject({ question: `${m}. What does the contract mean?` });
    // without the reader (an older port): as it was
    expect(dateQ(reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [TIED], [text("d1", 9, RECORD)], docs, { excluded: signedOff() })).signedOn).toBeUndefined();
  });

  it("an effective date the master holds that the record's last signature contradicts: one question showing both, suggesting neither; only a pick writes", () => {
    const DATE = "/study/effectiveDate/value";
    const held = (value: string, quote: string, status: ValueEvidence["status"] = "confirmed") => {
      const rb = contract();
      rb.study.effectiveDate = { value, prov: { source: { documentId: "d1", page: 1, quote }, confidence: 0.96, method: "ai", crossCheck: "agree" } };
      // the binder is stubbed: it says what it found for the date on page 1
      const evidence: ValueEvidence[] = [{ path: DATE, status, where: [{ documentId: "d1", page: 1, box: [0.1, 0.2, 0.3, 0.02] }], printed: value, note: null }];
      const stub = { bindEvidence: () => ({ evidence: structuredClone(evidence), unaccounted: [], tableChecks: [], blankChecks: [] }), reviewFromEvidence: () => [], lastSigned } as unknown as Parameters<typeof reviewDraft>[0];
      return { rb, run: (pages = [text("d1", 9, RECORD)], excluded = signedOff()) => reviewDraft(stub, rb, [], pages, docs, { excluded }) };
    };
    const TIED = "This Agreement is effective on the date of last signature by the parties.";
    const asked = (out: ReturnType<typeof reviewDraft>) => out.review.filter((i) => i.id === `signed:${DATE}`);
    // the record's last signature (March 5) is later than the date held, or earlier: asked both ways
    for (const value of ["2024-03-04", "2024-03-07"]) {
      const { rb, run } = held(value, TIED);
      const out = run();
      const [q] = asked(out);
      expect(asked(out)).toHaveLength(1);
      expect(q).toMatchObject({ kind: "contract_problem", reason: "SIGNED_DATE_DIFFERS", path: DATE, blocking: true, input: null, where: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 9, box: null }] });
      expect(q!.question).toMatch(/^The contract takes effect on the date it was last signed, but it gives two dates: March [47], 2024 on page 1, and March 5, 2024 for the last signature on its e-signature record \(page 9 of “CTA\.pdf”\)\. Which date does it take effect\?/);
      expect(q!.options.map((o) => o.id)).toEqual([value, "2024-03-05"]);
      // nothing suggested, nothing changed or downgraded by code
      expect(suggest(q!, { rulebook: rb, evidence: out.evidence })).toBeNull();
      expect(rb.study.effectiveDate.value).toBe(value);
      expect(out.evidence.find((e) => e.path === DATE)!.status).toBe("confirmed");
    }
    // a person's pick writes the date they pick, attested to them
    const { rb, run } = held("2024-03-04", TIED);
    const out = run();
    const d = { version: 1, byHand: false, rulebook: rb, review: out.review, evidence: out.evidence, editors: [] };
    expect(answerDraft(d, `signed:${DATE}`, { optionId: "2024-03-05", by: "Sam" })).toMatchObject({ outcome: "chosen", set: { path: DATE, before: "2024-03-04", after: "2024-03-05" } });
    expect(d.rulebook.study.effectiveDate.value).toBe("2024-03-05");
    expect(d.evidence.find((e) => e.path === DATE)).toMatchObject({ status: "attested" });
    // an open date is asked too, and left open
    const open = held("2024-03-04", TIED, "ungrounded").run();
    expect(asked(open)).toHaveLength(1);
    expect(open.evidence.find((e) => e.path === DATE)!.status).toBe("ungrounded");
  });

  it("no question when the dates agree, the record gives no one date or none is there, or page 1's date governs (the clause doesn't tie it to signing)", () => {
    const DATE = "/study/effectiveDate/value";
    const run = (value: string, quote: string, pages: TextPage[], excluded = signedOff()) => {
      const rb = contract();
      rb.study.effectiveDate = { value, prov: { source: { documentId: "d1", page: 1, quote }, confidence: 0.96, method: "ai", crossCheck: "agree" } };
      const stub = { bindEvidence: () => ({ evidence: [{ path: DATE, status: "confirmed", where: [{ documentId: "d1", page: 1, box: null }], printed: value, note: null }], unaccounted: [], tableChecks: [], blankChecks: [] }), reviewFromEvidence: () => [], lastSigned } as unknown as Parameters<typeof reviewDraft>[0];
      return reviewDraft(stub, rb, [], pages, docs, { excluded }).review.filter((i) => i.reason === "SIGNED_DATE_DIFFERS").length;
    };
    const TIED = "This Agreement is effective on the date of last signature by the parties.";
    expect(run("2024-03-05", TIED, [text("d1", 9, RECORD)])).toBe(0);
    expect(run("2024-03-04", TIED, [text("d1", 9, "Signer Events Signed: 3/4/2024")])).toBe(0); // reads two ways
    expect(run("2024-03-04", TIED, [text("d1", 9, RECORD, "ocr")])).toBe(0); // a scanned record
    expect(run("2024-03-04", TIED, [text("d1", 9, RECORD)], [])).toBe(0); // signed in ink: no record
    // a "dated as of" clause: page 1's date governs, whatever day the last party signed
    expect(run("2024-03-04", "This Agreement is entered into as of March 4, 2024 (the Effective Date).", [text("d1", 9, RECORD)])).toBe(0);
    expect(run("2024-03-04", TIED, [text("d1", 9, RECORD)])).toBe(1);
  });

  it("an amendment's start date: suggested when it starts on signature; never for a retroactive start, which is before any signature", () => {
    const amended = (quote: string) => {
      const rb = contract();
      rb.documents.push({ id: "d2", kind: "amendment", title: "Amendment 1", date: null });
      rb.appliesFrom = { value: null, prov: { source: { documentId: "d2", page: 1, quote }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } };
      return rb;
    };
    const pages = [text("d2", 1, "x"), text("d2", 8, RECORD)];
    let rb = amended("This Amendment is effective upon full execution by both parties.");
    let q = dateQ(reviewDraft(port, rb, runContractChecks(rb), pages, docs, { amendment: true, excluded: signedOff("d2", 8) }), "/appliesFrom/value");
    expect(q.question).toBe("The amendment takes effect on the date it was last signed. Its e-signature record is page 8 of “Amendment 1.pdf”. From what date do its terms apply? The contract says: “This Amendment is effective upon full execution by both parties.”");
    expect(q.signedOn).toMatchObject({ date: "2024-03-05", page: 8 });
    rb = amended("Upon execution of this Amendment, the revised budget will be retroactive.");
    q = dateQ(reviewDraft(port, rb, runContractChecks(rb), pages, docs, { amendment: true, excluded: signedOff("d2", 8) }), "/appliesFrom/value");
    expect(q.question).toMatch(/^The amendment says its new prices apply retroactively, but gives no start date/);
    expect(q.signedOn).toBeUndefined();
  });
});

describe("rounding the contract never mentions is a notice (owner, 2026-11-02)", () => {
  const page = (words: string, source: TextPage["source"] = "text", n = 1): TextPage => ({
    documentId: "d1", page: n, width: 600, height: 800, source, hidden: 0, largePicture: false,
    words: words.split(" ").map((t, i) => ({ text: t, rect: [0, i, 10, i + 1], dir: 0, block: 0, line: i, hidden: false })),
  });
  const asked = (pages: TextPage[], excluded: { documentId: string; page: number; kind: string }[] = []) => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    return reviewDraft({ bindEvidence, reviewFromEvidence }, rb, [], pages, [{ id: "d1", filename: "c.pdf" }], { excluded }).review.some((i) => i.path === "/rounding/value");
  };
  it("asked only where the contract's text says something about rounding, or a page nothing searched could", () => {
    expect(asked([page("Payment is due within 45 days of invoice.")])).toBe(false);
    expect(asked([page("Round-trip airfare is reimbursed at cost.")])).toBe(false);
    expect(asked([page("Visit payments are rounded to the nearest whole dollar.")])).toBe(true);
    expect(asked([page("Amounts are paid to the nearest cent.")])).toBe(true);
    expect(asked([page("Payment is due within 45 days."), page("", "image_only", 2)])).toBe(true);
    // a page the read excluded (an e-signature record) holds no terms
    expect(asked([page("Payment is due within 45 days."), page("", "image_only", 2)], [{ documentId: "d1", page: 2, kind: "esign_certificate" }])).toBe(false);
  });
});

describe("needs you counts cards: questions on one quote are one", () => {
  it("one card for the questions citing the same quote on the same page, while any of them is open", () => {
    const q = (id: string, quote: string | null, outcome: ReviewItem["outcome"] = null): ReviewItem => ({
      id, kind: "interpretation", reason: "INTERPRETATION", path: `/${id}`, question: id, input: null, options: [], where: [], blocking: true, answer: null, outcome, compare: null, sentBack: null,
      ...(quote ? { cites: { documentId: "d1", page: 3, quote } } : {}),
    });
    const v = (review: ReviewItem[]) => needsYouOf({ status: "draft", byHand: false, typingDoneAt: null, review });
    expect(v([q("a", "Screen failures are paid $500."), q("b", "Screen failures are paid $500."), q("c", "Screen failures are paid $50."), q("d", null)])).toBe(3);
    expect(v([q("a", "Screen failures are paid $500.", "matched"), q("b", "Screen failures are paid $500.")])).toBe(1);
  });
});

describe("a clause that states its figure outright isn't asked (ADR-002 §4)", () => {
  // the binder is stubbed: it says what it confirmed, so this shows what reviewDraft does with that
  const stated = (status: "confirmed" | "conflict") => {
    const rb = manualRulebook({ sponsor: "Acme", protocol: "P-1", siteName: "Site A", investigator: "Dr. A" } as Parameters<typeof manualRulebook>[0], []);
    const prov = { source: { documentId: "d1", page: 1, quote: "billed up to $777.00 in total" }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
    rb.invoiceables = [{ code: null, name: "Mileage", amountCents: 67, amountWithOverheadCents: null, basis: "per_mile", frequency: "per mile", cap: { kind: "amount", n: 77700, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov }];
    const evidence = [{ path: "/invoiceables/0/cap/n", status, where: [{ documentId: "d1", page: 1, box: null }], printed: "$777.00", note: null }];
    const port = { bindEvidence: () => ({ evidence, unaccounted: [], tableChecks: [], blankChecks: [] }), reviewFromEvidence: () => [] } as unknown as Parameters<typeof reviewDraft>[0];
    return reviewDraft(port, rb, [], [], []).review;
  };

  it("the amount limit's kind is not a question when its figure is confirmed from its quote, and nothing is asked about its figure", () => {
    const review = stated("confirmed");
    expect(review.filter((i) => i.path?.startsWith("/invoiceables/0/cap/"))).toEqual([]);
  });

  it("is asked, with its figure withheld, when the figure isn't confirmed", () => {
    const review = stated("conflict");
    expect(review.find((i) => i.path === "/invoiceables/0/cap/kind")).toMatchObject({ reason: "INTERPRETATION", blocking: true });
  });
});

describe("no blind sample (ADR-003)", () => {
  it("a read asks nothing about a value its page confirms", async () => {
    const { studyId } = await draft();
    const v = await version(studyId);
    const confirmed = new Set(v.evidence.filter((e) => e.status === "confirmed").map((e) => e.path));
    expect(confirmed.size).toBeGreaterThan(0);
    expect(v.review.filter((i) => i.kind === "confirm_value" && i.path && confirmed.has(i.path))).toEqual([]);
  });
});

describe("corrections an amendment's read couldn't carry over", () => {
  const FEE = "/siteFees/0/amountCents";

  it("each is said on the draft, and asked again where the value is now (a moved item found by its identity)", async () => {
    const { studyId } = await draft();
    // version 1: the admin fee and the unscheduled visit reported and corrected, each kept over the PDF's text with a reason
    const fee = (await post(`/studies/${studyId}/versions/1/report`, { path: FEE, note: "check", by: "Asha" })).json<RulebookVersionDto>().review.at(-1)!.id;
    const visit = (await post(`/studies/${studyId}/versions/1/report`, { path: "/invoiceables/0/amountWithOverheadCents", note: "check", by: "Asha" })).json<RulebookVersionDto>().review.at(-1)!.id;
    for (const [id, value] of [[fee, 1250000], [visit, 85000]] as const) {
      await answer(studyId, id, { value, by: "Asha" });
      await answer(studyId, id, { value, note: "the page prints it", by: "Asha" });
    }
    await settleRest(studyId);
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
    // the log's account of it: what was corrected, and where it's asked again
    const skipped = () => auditOf(studyId).then((l) => l.find((e) => e.action === "version.corrections_carried")!.detail.skipped as Record<string, unknown>[]);
    expect(await skipped()).toEqual([expect.objectContaining({ reason: "item_moved", askedAt: "/siteFees/1/amountCents" }), expect.objectContaining({ reason: "amendment_changed" })]);
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
    expect(answerDraft(d, lost.id, { optionId: "bill_by_hand", note: "Pharmacy set-up $1,500 once", by: "Sam" })).toMatchObject({ outcome: "chosen", listed: { added: "Page 7 of “Work order”" } });
    expect(d.rulebook.unclassified).toMatchObject([{ page: 7, note: "Pharmacy set-up $1,500 once", itemId: lost.id }]);
  });
});
