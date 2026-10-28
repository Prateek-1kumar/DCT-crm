import { RulebookVersionDto } from "@dct/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { mockRequest, mockReset } from "./mock/server";
import { proofUnits, unitStatus } from "./proofread";

const version = async () => RulebookVersionDto.parse((await mockRequest("GET", "/studies/st-northwind/versions/1", undefined)).json);

describe("proofread units", () => {
  beforeEach(() => mockReset());

  it("groups confirmed values into terms, visit totals and grid rows, biggest money first", async () => {
    const v = await version();
    const units = proofUnits(v);
    const order = units.map((u) => u.section);
    expect(order.indexOf("totals")).toBeGreaterThan(order.lastIndexOf("terms"));
    expect(order.indexOf("rows")).toBeGreaterThan(order.lastIndexOf("totals"));

    // Every confirmed value with a place on a page is in exactly one unit; values with an open question are not.
    const confirmed = v.evidence.filter((e) => e.status === "confirmed" && e.where[0]).map((e) => e.path);
    expect(units.flatMap((u) => u.cells.map((c) => c.path)).sort()).toEqual([...confirmed].sort());

    const rows = units.filter((u) => u.section === "rows");
    expect(rows[0]!.cells[0]!.label).toBe("Unit");
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.money).toBeGreaterThanOrEqual(rows[i]!.money);
    // Non-amount terms (percentages, days) lead: they apply to everything.
    expect(units[0]!.cells[0]!.path).not.toMatch(/Cents$/);
  });

  it("a unit is done when all its values are marked, reported when any was sent to Needs you", async () => {
    const u = proofUnits(await version()).find((x) => x.section === "rows")!;
    const marks = new Map(u.cells.map((c) => [c.path, { path: c.path, by: "Avery Chen", at: "2026-10-28T10:00:00Z" }]));
    expect(unitStatus(u, new Map(), new Set())).toBe("todo");
    expect(unitStatus(u, marks, new Set())).toBe("done");
    expect(unitStatus(u, marks, new Set([u.cells[1]!.path]))).toBe("reported");
  });

  it("marks survive on a live version without changing its numbers", async () => {
    const before = RulebookVersionDto.parse((await mockRequest("GET", "/studies/st-meridian/versions/1", undefined)).json);
    const u = proofUnits(before)[0]!;
    const res = await mockRequest("POST", "/studies/st-meridian/versions/1/proofread", { paths: u.cells.map((c) => c.path), by: "Avery Chen" });
    const after = RulebookVersionDto.parse(res.json);
    expect(after.proofread.map((m) => m.path).sort()).toEqual(u.cells.map((c) => c.path).sort());
    expect(after.rulebook).toEqual(before.rulebook);
  });
});
