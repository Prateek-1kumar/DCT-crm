import { describe, expect, it } from "vitest";
import { inTab, matchesQuery, stepInfo, stepperStates, tabCounts } from "./steps";
import type { StudyRow, VersionStatus } from "./types";

const row = (over: Partial<StudyRow> = {}): StudyRow => ({
  id: "s1",
  protocol: "NWP-418-02",
  sponsorId: "p1",
  payerId: "p2",
  siteId: "p3",
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "Avery Chen",
  sponsor: "Northwind Pharma",
  payer: "Fieldstone CRO",
  site: "Discovery Clinical Trials",
  firstDocument: "Master CTA.pdf",
  latestVersion: null,
  pi: "Dr. Priya Raman",
  updatedAt: "2026-11-01T10:00:00Z",
  liveVersion: null,
  openDecisions: 0,
  newVersionInProgress: false,
  answeredBy: [],
  ...over,
});
const at = (status: VersionStatus, over: Partial<StudyRow> = {}) => row({ latestVersion: { id: "v2", number: 2, status }, ...over });

describe("stepInfo", () => {
  it("step 1: no files yet, the button adds files", () => {
    const i = stepInfo(row({ firstDocument: null }), null);
    expect(i).toMatchObject({ phase: "add", step: 1, status: "No files yet", tab: "all" });
    expect(i.next).toMatchObject({ label: "Add files", href: "/studies/s1?tab=documents", disabled: false });
  });

  it("files but no version: ready to read, under All only", () => {
    const i = stepInfo(row(), null);
    expect(i).toMatchObject({ phase: "ready", step: 2, status: "Ready to read", tab: "all" });
    expect(i.next.label).toBe("Start reading");
  });

  it("reading: step 2, under All only", () => {
    expect(stepInfo(at("reading"), null)).toMatchObject({ phase: "reading", step: 2, tab: "all", failed: false });
  });

  it("a failed read is Couldn't read, on step 3", () => {
    const i = stepInfo(at("failed"), null);
    expect(i).toMatchObject({ phase: "failed", step: 3, status: "Couldn't read", tab: "failed", failed: true });
    expect(i.next.label).toBe("Start again");
  });

  it("a draft with open decisions needs you, and says how many", () => {
    const one = stepInfo(at("draft", { openDecisions: 1 }), null);
    expect(one).toMatchObject({ phase: "decisions", step: 3, tab: "needs-you", status: "1 decision to make" });
    expect(one.next).toMatchObject({ label: "Answer 1 decision", href: "/versions/v2/questions" });
    expect(stepInfo(at("draft", { openDecisions: 4 }), null).next.label).toBe("Answer 4 decisions");
  });

  it("a draft with nothing blocking is waiting for approval", () => {
    const i = stepInfo(at("draft"), "Sam Lee");
    expect(i).toMatchObject({ phase: "approve", step: 4, tab: "waiting" });
    expect(i.next).toMatchObject({ label: "Review and approve", href: "/versions/v2/approve", disabled: false, reason: null });
  });

  it("maker-checker: the person who answered can't approve, and the button names who did", () => {
    const r = at("draft", { answeredBy: ["Avery Chen", "Sam Lee"] });
    const i = stepInfo(r, "avery chen ");
    expect(i.next).toMatchObject({ label: "Waiting for a colleague", disabled: true });
    expect(i.next.reason).toContain("Avery Chen, Sam Lee");
    expect(stepInfo(r, "Jo Park").next.disabled).toBe(false);
    expect(stepInfo(r, null).next.disabled).toBe(false);
  });

  it("an approved version is live, step 5", () => {
    const i = stepInfo(at("approved", { liveVersion: 2 }), null);
    expect(i).toMatchObject({ phase: "live", step: 5, status: "Live · version 2", tab: "live", newVersion: false });
    expect(i.next).toMatchObject({ label: "Open rulebook", href: "/versions/v2" });
  });

  it("a live contract keeps its tag and stays under Live while the new version is read, or fails", () => {
    const keep = { liveVersion: 1, newVersionInProgress: true };
    expect(stepInfo(at("reading", keep), null)).toMatchObject({ newVersion: true, tab: "live", step: 2 });
    expect(stepInfo(at("failed", keep), null)).toMatchObject({ newVersion: true, tab: "live", failed: true });
  });

  it("a live contract whose new draft needs a person moves to the tab that needs them", () => {
    const keep = { liveVersion: 1, newVersionInProgress: true };
    expect(stepInfo(at("draft", { ...keep, openDecisions: 2 }), null).tab).toBe("needs-you");
    expect(stepInfo(at("draft", keep), null).tab).toBe("waiting");
  });
});

describe("list tabs", () => {
  const rows = [
    row({ id: "a", firstDocument: null }),
    row({ id: "b" }),
    at("reading", { id: "c" }),
    at("failed", { id: "d" }),
    at("draft", { id: "e", openDecisions: 2 }),
    at("draft", { id: "f" }),
    at("approved", { id: "g", liveVersion: 2 }),
  ];
  it("counts each tab; All is every contract", () => {
    expect(tabCounts(rows, null)).toEqual({ all: 7, "needs-you": 1, waiting: 1, live: 1, failed: 1 });
  });
  it("inTab filters by the tab, All keeps everything", () => {
    const ids = (tab: Parameters<typeof inTab>[1]) => rows.filter((r) => inTab(stepInfo(r, null), tab)).map((r) => r.id);
    expect(ids("needs-you")).toEqual(["e"]);
    expect(ids("all")).toHaveLength(7);
  });
});

describe("matchesQuery", () => {
  it("looks at protocol, sponsor, site, doctor and file name; every word must match", () => {
    const r = row();
    for (const q of ["nwp", "northwind", "fieldstone", "discovery", "raman", "master cta", "NORTHWIND raman", ""]) expect(matchesQuery(r, q)).toBe(true);
    expect(matchesQuery(r, "northwind zzz")).toBe(false);
    expect(matchesQuery(row({ pi: null }), "raman")).toBe(false);
  });
});

describe("stepperStates", () => {
  it("marks earlier steps done, the current one with its status, later ones to do", () => {
    const s = stepperStates(stepInfo(at("draft", { openDecisions: 2 }), null));
    expect(s.map((x) => x.state)).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(s[2]!.note).toBe("2 decisions to make");
  });
  it("a failed read shows on step 3 as failed; a live contract is all done", () => {
    expect(stepperStates(stepInfo(at("failed"), null))[2]!.state).toBe("failed");
    expect(stepperStates(stepInfo(at("approved", { liveVersion: 2 }), null)).map((x) => x.state)).toEqual(["done", "done", "done", "done", "done"]);
  });
});
