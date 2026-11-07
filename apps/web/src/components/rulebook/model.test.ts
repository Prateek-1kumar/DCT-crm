import { describe, expect, it } from "vitest";
import { version } from "@/components/version/fixtures";
import { doubtfulCells, gridProof, proofreaders, proofreadCells } from "./model";
import { bigGrid } from "./test-data";
import { EVIDENCE_LABEL, EVIDENCE_TITLE, EVIDENCE_TONE } from "./terms";

describe("proof badge mapping", () => {
  it("has a plain label, a tone and an explanation for every proof, and no codes", () => {
    for (const e of ["math", "quote", "two_reads", "house_rule", "person", "none"] as const) {
      expect(EVIDENCE_LABEL[e]).toBeTruthy();
      expect(EVIDENCE_TITLE[e].length).toBeGreaterThan(20);
      expect(EVIDENCE_TONE[e]).toBeTruthy();
      expect(EVIDENCE_LABEL[e]).not.toMatch(/_/);
    }
    expect(EVIDENCE_TONE.none).toBe("warn");
    expect(EVIDENCE_TONE.person).toBe("info");
  });
});

describe("proofreads", () => {
  const ver = version({ proofreads: [{ item: "t1", by: "Ana", at: "" }, { item: "t1", by: "Ana", at: "" }, { item: "t1", by: "Bo", at: "" }, { item: "grid:g1:0:1", by: "Ana", at: "" }] });
  it("lists each person once", () => expect(proofreaders(ver, "t1")).toEqual(["Ana", "Bo"]));
  it("gives the row:col of proofread grid cells", () => expect([...proofreadCells(ver, "g1")]).toEqual(["0:1"]));
});

describe("grid proof", () => {
  it("is math when totals are printed, person when accepted, none with a problem or no printed totals", () => {
    const ver = version();
    expect(gridProof(bigGrid(), ver)).toBe("math");
    expect(gridProof(bigGrid({ acceptedAsPrinted: true }), ver)).toBe("person");
    expect(gridProof(bigGrid({ total: null, subtotal: null }), ver)).toBe("none");
    expect(gridProof(bigGrid(), version({ problems: [{ check: "grid_math", id: "g1", message: "x" }] }))).toBe("none");
  });
});

describe("doubtful cells", () => {
  it("finds missed or doubtful amounts that belong to the grid", () => {
    const amount = (status: "captured" | "missing", doubt: "unsure" | null, id: string, row: number, col: number) => ({ box: [0, 0, 1, 1] as [number, number, number, number], text: "", cents: 1, status, ref: { target: "grid" as const, id, row, col }, reason: null, doubt, line: "" });
    const coverage = { pages: [{ documentId: "d", doc: "d", page: 1, kind: "text" as const, clauses: [], amounts: [amount("captured", "unsure", "g1", 0, 1), amount("missing", null, "g1", 1, 0), amount("captured", null, "g1", 1, 1), amount("missing", null, "g2", 0, 0)] }], totals: { amounts: 4, captured: 2, decided: 0, setAside: 0, missing: 2 } };
    expect([...doubtfulCells(coverage, "g1")].sort()).toEqual(["0:1", "1:0"]);
  });
});
