import type { ReviewItem } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { approveState, formatAnswer, needsYou, parseAnswer, pdfCheckLine, queueOrder, stepsFor, summaryStage, versionStage } from "./review";

const q = (id: string, blocking: boolean, outcome: ReviewItem["outcome"] = null): ReviewItem => ({
  id, kind: "confirm_value", reason: "spot_check", path: null, question: "", input: "money", options: [], where: [], blocking, answer: null, outcome, compare: null, sentBack: null,
});
const rulebook = {} as never;

describe("queue", () => {
  it("puts blocking questions first, otherwise keeps the order", () => {
    expect(queueOrder([q("a", false), q("b", true), q("c", false), q("d", true)]).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("counts what still needs a person", () => {
    const items = [q("1", true, "matched"), q("2", true, "differs"), q("3", true, "cant_tell"), q("4", false, "cant_tell"), q("5", false), q("6", true, "chosen")];
    expect(needsYou(items).map((i) => i.id)).toEqual(["2", "3", "5"]);
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
    expect(versionStage({ status: "draft" }, { byHand: false, review: [q("1", false, "cant_tell")] })).toEqual({ stage: "Approve" });
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
  const draft = { status: "draft" as const, rulebook, editors: ["Avery"], review: [q("1", true, "matched"), q("2", false, "cant_tell")] };

  it("allows a draft whose blocking questions are settled", () => {
    expect(approveState(draft, { makerChecker: false }, "Avery")).toEqual({ allowed: true, reasons: [] });
  });
  it("blocks while a blocking question is unsettled, and says how many", () => {
    const s = approveState({ ...draft, review: [q("1", true), q("2", true, "cant_tell"), q("3", false)] }, { makerChecker: false }, "Avery");
    expect(s.allowed).toBe(false);
    expect(s.reasons.join(" ")).toContain("2 questions need an answer first");
  });
  it("needs a person", () => {
    expect(approveState(draft, { makerChecker: false }, null).reasons.join(" ")).toMatch(/Choose your name/);
  });
  it("applies maker-checker only when on", () => {
    expect(approveState(draft, { makerChecker: true }, "Avery").reasons.join(" ")).toMatch(/someone else has to approve/);
    expect(approveState(draft, { makerChecker: true }, "Sam").allowed).toBe(true);
  });
  it("refuses non-drafts", () => {
    expect(approveState({ ...draft, status: "signed" }, { makerChecker: false }, "Sam").allowed).toBe(false);
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
