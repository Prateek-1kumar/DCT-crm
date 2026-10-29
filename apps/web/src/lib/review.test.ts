import type { ReviewItem } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { approveState, formatAnswer, needsYou, parseAnswer, pdfCheckLine, queueOrder, stepsFor, summaryStage, versionStage } from "./review";

const q = (id: string, blocking: boolean, outcome: ReviewItem["outcome"] = null): ReviewItem => ({
  id, kind: "confirm_value", reason: "spot_check", path: null, question: "", input: "money", options: [], where: [], blocking, answer: null, outcome, compare: null, sentBack: null,
});
const rulebook = { budgetGrids: [], governingGridId: null, governingGridIds: [] } as never;

describe("queue", () => {
  it("puts blocking questions first, otherwise keeps the order", () => {
    expect(queueOrder([q("a", false), q("b", true), q("c", false), q("d", true)]).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("counts what still needs a person", () => {
    const items = [q("1", true, "matched"), q("2", true, "differs"), q("3", true, "cant_tell"), q("4", false, "cant_tell"), q("5", false), q("6", true, "chosen")];
    // a "can't tell" on a question not needed to approve too: approval waits for it (openItems)
    expect(needsYou(items).map((i) => i.id)).toEqual(["2", "3", "4", "5"]);
  });
});

describe("stages", () => {
  it("from the list summary", () => {
    expect(summaryStage({ status: "setting_up", needsYou: 0 })).toEqual({ stage: "Upload" });
    expect(summaryStage({ status: "extraction_failed", needsYou: 0 })).toEqual({ stage: "Reading", failed: true });
    expect(summaryStage({ status: "needs_review", needsYou: 3 })).toEqual({ stage: "Needs you", needs: 3 });
    expect(summaryStage({ status: "amendment_in_review", needsYou: 0 })).toEqual({ stage: "Approve" });
    expect(summaryStage({ status: "live", needsYou: 0 })).toEqual({ stage: "Live" });
  });
  it("from the newest version", () => {
    expect(versionStage(undefined, undefined).stage).toBe("Upload");
    expect(versionStage({ status: "extracting" }, undefined).stage).toBe("Reading");
    expect(versionStage({ status: "draft" }, { byHand: false, review: [q("1", true), q("2", false, "matched")] })).toEqual({ stage: "Needs you", needs: 1 });
    expect(versionStage({ status: "draft" }, { byHand: false, review: [q("1", false, "cant_tell")] })).toEqual({ stage: "Needs you", needs: 1 });
    expect(versionStage({ status: "draft" }, { byHand: false, review: [q("1", false, "chosen")] })).toEqual({ stage: "Approve" });
    // Typed by hand: still typing, then the blind re-type questions.
    expect(versionStage({ status: "draft" }, { byHand: true, review: [] })).toEqual({ stage: "Reading", byHand: true });
    expect(versionStage({ status: "draft" }, { byHand: true, review: [q("1", true)] })).toEqual({ stage: "Needs you", needs: 1, byHand: true });
    expect(stepsFor({ stage: "Reading", byHand: true }).map((x) => x.label)).toEqual(["Upload", "Typed by hand", "Needs you", "Approve", "Live"]);
    expect(versionStage({ status: "signed" }, undefined).stage).toBe("Live");
  });
  it("says what the PDF check found, or that it's a scan", () => {
    expect(pdfCheckLine({ values: 1219, matched: 1212 })).toBe("1,212 of 1,219 numbers match the contract PDF");
    expect(pdfCheckLine(null)).toMatch(/^This PDF is a scan/);
  });
});

describe("approveState", () => {
  const draft = { version: 1, status: "draft" as const, rulebook, editors: ["Avery"], byHand: false, evidence: [], review: [q("1", true, "matched"), q("2", false, "chosen")], proofread: [], updatedAt: "2026-10-29T09:00:00.000Z" };

  it("allows a draft whose questions are all settled", () => {
    expect(approveState(draft, { makerChecker: false }, "Avery")).toEqual({ allowed: true, reasons: [] });
  });
  it("blocks while any question is unsettled, one not needed to approve too, and says how many", () => {
    const s = approveState({ ...draft, review: [q("1", true), q("2", true, "cant_tell"), q("3", false), q("4", false, "cant_tell")] }, { makerChecker: false }, "Avery");
    expect(s.allowed).toBe(false);
    expect(s.reasons).toEqual(["4 questions still need an answer before this can be approved."]); // the API's words
  });
  it("as the API: typing by hand marked done, and every number backed", () => {
    expect(approveState({ ...draft, byHand: true, review: [] }, { makerChecker: false }, "Avery").reasons.join(" ")).toMatch(/Typing isn't marked done yet/);
    const unbacked = { ...draft, evidence: [{ path: "/x", status: "conflict" as const, where: [], printed: null, note: null }] };
    expect(approveState(unbacked, { makerChecker: false }, "Avery").reasons.join(" ")).toMatch(/1 number isn't confirmed/);
  });
  it("as the API: after a random spot check missed, every value of its kind proofread or typed by a person first", () => {
    const cell = (path: string, status: "confirmed" | "attested" = "confirmed") => ({ path, status, where: [], printed: null, note: null });
    const missed = { ...q("s", true, "chosen"), reason: "SAMPLE", path: "/budgetGrids/0/procedures/0/cells/V1", missed: true };
    const v = { ...draft, review: [missed], evidence: [cell(missed.path, "attested"), cell("/budgetGrids/0/procedures/1/cells/V1"), cell("/budgetGrids/0/procedures/2/unitCents"), cell("/siteFees/0/amountCents")] };
    expect(approveState(v, { makerChecker: false }, "Avery").reasons).toEqual(["A random spot check found a wrong number among the budget grid prices, so each of them has to be proofread before approval: 2 of 3 still to check."]);
    const marks = ["/budgetGrids/0/procedures/1/cells/V1", "/budgetGrids/0/procedures/2/unitCents"].map((path) => ({ path, by: "Sam", at: "" }));
    expect(approveState({ ...v, proofread: marks }, { makerChecker: false }, "Avery").allowed).toBe(true);
  });
  it("needs a person", () => {
    expect(approveState(draft, { makerChecker: false }, null).reasons.join(" ")).toMatch(/Choose your name/);
  });
  it("applies maker-checker only when on (on unless the settings say otherwise), to the person however the name is typed", () => {
    for (const by of ["Avery", " avery "]) expect(approveState(draft, { makerChecker: true }, by).reasons.join(" ")).toMatch(/someone else has to approve/);
    expect(approveState(draft, undefined, "Avery").allowed).toBe(false);
    expect(approveState(draft, { makerChecker: true }, "Sam").allowed).toBe(true);
  });
  it("refuses non-drafts", () => {
    expect(approveState({ ...draft, status: "signed" }, { makerChecker: false }, "Sam").reasons).toEqual(["Version 1 is signed and immutable; changes need a new version (amendment)"]);
  });
});

describe("parseAnswer / formatAnswer", () => {
  it("parses by input kind", () => {
    expect(parseAnswer("money", "4,295")).toEqual({ value: 429500 });
    expect(parseAnswer("money", "$98.5")).toEqual({ value: 9850 });
    expect(parseAnswer("money", "12.345")).toHaveProperty("error");
    expect(parseAnswer("percent", "25%")).toEqual({ value: 25 });
    expect(parseAnswer("number", "1,000")).toEqual({ value: 1000 });
    expect(parseAnswer("number", "abc")).toHaveProperty("error");
    expect(parseAnswer("date", "2026-09-01")).toEqual({ value: "2026-09-01" });
    expect(parseAnswer("text", "  ")).toHaveProperty("error");
  });
  it("formats for the side-by-side comparison", () => {
    expect(formatAnswer("money", 424500)).toBe("$4,245.00");
    expect(formatAnswer("percent", 25)).toBe("25%");
    expect(formatAnswer("number", null)).toBe("nothing");
  });
});
