import { describe, expect, it } from "vitest";
import { grid, sampleVersion } from "../contract/test-data";
import { buildLines, defaultLine, filterLines, lineStatus, needsChecking, nextUnchecked, progress, sectionsOf, stepLine } from "./lines";

const at = "2026-11-03T10:00:00Z";
const mark = (item: string, by: string) => ({ item, by, at });
const flag = (item: string, by: string) => ({ item, by, note: "Wrong amount", at });
const keysOf = (ls: { key: string }[]) => ls.map((l) => l.key);

describe("buildLines", () => {
  it("lists budget grids first, then terms in the Overview's groups", () => {
    const lines = buildLines(sampleVersion());
    expect(keysOf(lines)).toEqual(["grid:g1", "term:t2", "term:t1", "term:t3"]);
    expect(sectionsOf(lines).map((s) => s.title)).toEqual(["Budget grids", "Holdback and overhead", "Site fees", "Recurring fees"]);
  });
  it("names a grid as a budget grid, with one item per amount cell, and marks an open question", () => {
    const lines = buildLines(sampleVersion());
    expect(lines[0]!.name).toBe("Budget grid: Visit budget");
    expect(lines[0]!.items).toEqual(["grid:g1:0:0", "grid:g1:0:1"]);
    expect(lines.find((l) => l.key === "term:t2")!.openQuestion).toBe(true);
  });
});

describe("filters and counts", () => {
  const all = (v = sampleVersion()) => buildLines(v);
  it("Needs checking: every line without a mark from anyone, however well proven", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t3", "Ana")] });
    expect(keysOf(filterLines(all(v), v, null, "needs"))).toEqual(["grid:g1", "term:t2"]);
  });
  it("a grid is checked only once every cell has a mark", () => {
    const half = sampleVersion({ proofreads: [mark("grid:g1:0:0", "Ana")] });
    expect(needsChecking(buildLines(half)[0]!, half)).toBe(true);
    const full = sampleVersion({ proofreads: [mark("grid:g1:0:0", "Ana"), mark("grid:g1:0:1", "Ben")] });
    expect(needsChecking(buildLines(full)[0]!, full)).toBe(false);
  });
  it("a grid with no amounts has nothing to check", () => {
    const v = sampleVersion();
    v.rulebook!.grids = [{ ...grid, rows: [{ ...grid.rows[0]!, cells: [null, null] }] }];
    expect(needsChecking(buildLines(v)[0]!, v)).toBe(false);
  });
  it("Flagged: lines with a flag on any of their items", () => {
    const v = sampleVersion({ flags: [flag("grid:g1:0:1", "Ben"), flag("t3", "Ana")] });
    expect(keysOf(filterLines(all(v), v, null, "flagged"))).toEqual(["grid:g1", "term:t3"]);
  });
  it("Checked by me: only lines the person marked, none before they have a name", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t3", "Ben"), mark("grid:g1:0:1", "Ana")] });
    expect(keysOf(filterLines(all(v), v, "Ana", "mine"))).toEqual(["grid:g1", "term:t1"]);
    expect(filterLines(all(v), v, null, "mine")).toEqual([]);
  });
  it("All shows everything", () => expect(filterLines(all(), sampleVersion(), null, "all")).toHaveLength(4));
});

describe("lineStatus", () => {
  it("reads flagged, checked, needs a look (open question or nothing proves it) or not checked", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana")], flags: [flag("grid:g1:0:0", "Ben")] });
    const by = Object.fromEntries(buildLines(v).map((l) => [l.key, lineStatus(l, v)]));
    expect(by).toEqual({ "grid:g1": "flagged", "term:t1": "checked", "term:t2": "look", "term:t3": "look" });
    const plain = sampleVersion();
    plain.rulebook!.terms[0]!.evidence = "quote";
    expect(lineStatus(buildLines(plain).find((l) => l.key === "term:t1")!, plain)).toBe("unchecked");
  });
  it("a checked line stays checked even when nothing else proves it", () => {
    const v = sampleVersion({ proofreads: [mark("t3", "Ana")] });
    expect(lineStatus(buildLines(v).find((l) => l.key === "term:t3")!, v)).toBe("checked");
  });
});

describe("progress", () => {
  it("counts lines checked by anyone out of the lines there are to check", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t1", "Ben"), mark("grid:g1:0:0", "Ana")] });
    expect(progress(buildLines(v), v)).toEqual({ done: 1, total: 4 });
  });
  it("leaves out a grid with no amounts, which has nothing to mark", () => {
    const v = sampleVersion();
    v.rulebook!.grids = [{ ...grid, rows: [{ ...grid.rows[0]!, cells: [null, null] }] }];
    expect(progress(buildLines(v), v)).toEqual({ done: 0, total: 3 });
  });
});

describe("next unchecked", () => {
  const v = sampleVersion({ proofreads: [mark("t2", "Ana")] });
  const lines = buildLines(v);
  it("is the next line after this one that nobody has checked", () => {
    expect(nextUnchecked(lines, v, "grid:g1")?.key).toBe("term:t1");
    expect(nextUnchecked(lines, v, "term:t1")?.key).toBe("term:t3");
  });
  it("wraps round, and never answers with the line itself", () => {
    expect(nextUnchecked(lines, v, "term:t3")?.key).toBe("grid:g1");
    const done = sampleVersion({ proofreads: [mark("t1", "A"), mark("t2", "A"), mark("t3", "A"), mark("grid:g1:0:0", "A"), mark("grid:g1:0:1", "A")] });
    expect(nextUnchecked(buildLines(done), done, "term:t1")).toBeUndefined();
    const onlyMe = sampleVersion({ proofreads: [mark("t1", "A"), mark("t2", "A"), mark("t3", "A")] });
    expect(nextUnchecked(buildLines(onlyMe), onlyMe, "grid:g1")).toBeUndefined();
  });
  it("opens on the first line that needs checking, else the first line", () => {
    expect(defaultLine(lines, v)?.key).toBe("grid:g1");
    expect(defaultLine(lines, sampleVersion({ proofreads: [mark("grid:g1:0:0", "A"), mark("grid:g1:0:1", "A"), mark("t1", "A"), mark("t2", "A"), mark("t3", "A")] }))?.key).toBe("grid:g1");
  });
});

describe("stepLine", () => {
  const lines = buildLines(sampleVersion());
  it("moves one line at a time and stops at the ends", () => {
    expect(stepLine(lines, "term:t2", 1)?.key).toBe("term:t1");
    expect(stepLine(lines, "term:t2", -1)?.key).toBe("grid:g1");
    expect(stepLine(lines, "term:t3", 1)?.key).toBe("term:t3");
    expect(stepLine(lines, "grid:g1", -1)?.key).toBe("grid:g1");
  });
  it("starts from an end when the current line isn't listed", () => {
    expect(stepLine(lines, null, 1)?.key).toBe("grid:g1");
    expect(stepLine(lines, "nope", -1)?.key).toBe("term:t3");
    expect(stepLine([], null, 1)).toBeUndefined();
  });
});
