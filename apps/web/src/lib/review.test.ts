import type { ContractAnomaly } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { groupBySeverity, settleProgress, signOffState } from "./review";

const a = (id: string, severity: ContractAnomaly["severity"], settled = false): ContractAnomaly => ({
  id, code: "AI_DISAGREEMENT", severity, message: "", path: null, refs: [], detail: {},
  resolution: settled ? { kind: "accepted_with_note", note: "ok", by: "Sam", at: "2026-01-01T00:00:00Z" } : null,
});
const rulebook = {} as never;

describe("settleProgress", () => {
  it("counts settled anomalies", () => {
    expect(settleProgress([a("1", "blocker", true), a("2", "info"), a("3", "warning", true)])).toEqual({ settled: 2, total: 3, open: 1 });
    expect(settleProgress([])).toEqual({ settled: 0, total: 0, open: 0 });
  });
  it("groups by severity, open first", () => {
    const g = groupBySeverity([a("i", "info"), a("b1", "blocker", true), a("b2", "blocker")]);
    expect(g.map((x) => x.severity)).toEqual(["blocker", "info"]);
    expect(g[0]!.items.map((x) => x.id)).toEqual(["b2", "b1"]);
  });
});

describe("signOffState", () => {
  const draft = { status: "draft" as const, rulebook, editors: ["Avery"], anomalies: [a("1", "blocker", true)] };

  it("allows a draft with everything settled", () => {
    expect(signOffState(draft, { makerChecker: false }, "Avery")).toEqual({ allowed: true, reasons: [] });
  });
  it("blocks while anomalies are open and says how many", () => {
    const s = signOffState({ ...draft, anomalies: [a("1", "blocker"), a("2", "info")] }, { makerChecker: false }, "Avery");
    expect(s.allowed).toBe(false);
    expect(s.reasons.join(" ")).toContain("2 anomalies are not settled");
  });
  it("needs a person", () => {
    expect(signOffState(draft, { makerChecker: false }, null).reasons.join(" ")).toMatch(/acting as/);
  });
  it("applies maker-checker only when on", () => {
    expect(signOffState(draft, { makerChecker: true }, "Avery").allowed).toBe(false);
    expect(signOffState(draft, { makerChecker: true }, "Sam").allowed).toBe(true);
  });
  it("refuses non-drafts", () => {
    expect(signOffState({ ...draft, status: "signed" }, { makerChecker: false }, "Sam").allowed).toBe(false);
  });
});
