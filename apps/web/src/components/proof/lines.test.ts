import { describe, expect, it } from "vitest";
import { grid, sampleVersion } from "../contract/test-data";
import { buildLines, filterLines, needsChecking, progress, sectionsOf } from "./lines";

const mark = (item: string, by: string) => ({ item, by, at: "2026-11-03T10:00:00Z" });
const keysOf = (ls: { key: string }[]) => ls.map((l) => l.key);

describe("buildLines", () => {
  it("lists budget grids first, then terms in the Overview's groups", () => {
    const lines = buildLines(sampleVersion());
    expect(keysOf(lines)).toEqual(["grid:g1", "term:t2", "term:t1", "term:t3"]);
    expect(sectionsOf(lines).map((s) => s.title)).toEqual(["Budget grids", "Holdback and overhead", "Site fees", "Recurring fees"]);
  });
  it("gives a grid one item per amount cell and flags an open question", () => {
    const lines = buildLines(sampleVersion());
    expect(lines[0]!.items).toEqual(["grid:g1:0:0", "grid:g1:0:1"]);
    expect(lines.find((l) => l.key === "term:t2")!.openQuestion).toBe(true);
  });
});

describe("filters", () => {
  const all = (v = sampleVersion()) => buildLines(v);
  it("Needs checking: not proofread, no evidence, or an open question", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t3", "Ana"), mark("t2", "Ana")] });
    // t1 is checked and proven; t3 is checked but nothing proves it; t2 is checked but a question is open; the grid has no marks
    expect(keysOf(filterLines(all(v), v, null, "needs"))).toEqual(["grid:g1", "term:t2", "term:t3"]);
  });
  it("a grid is checked only once every cell has a mark", () => {
    const withTotals = (proofreads: ReturnType<typeof mark>[]) => {
      const v = sampleVersion({ proofreads });
      v.rulebook!.grids = [{ ...grid, total: [2500, 3000] }]; // a printed total is what proves a grid
      return v;
    };
    const half = withTotals([mark("grid:g1:0:0", "Ana")]);
    expect(needsChecking(buildLines(half)[0]!, half)).toBe(true);
    const full = withTotals([mark("grid:g1:0:0", "Ana"), mark("grid:g1:0:1", "Ben")]);
    expect(needsChecking(buildLines(full)[0]!, full)).toBe(false);
  });
  it("Proofread by me: only lines the person marked, none before they have a name", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t3", "Ben"), mark("grid:g1:0:1", "Ana")] });
    expect(keysOf(filterLines(all(v), v, "Ana", "mine"))).toEqual(["grid:g1", "term:t1"]);
    expect(filterLines(all(v), v, null, "mine")).toEqual([]);
  });
  it("All shows everything", () => expect(filterLines(all(), sampleVersion(), null, "all")).toHaveLength(4));
});

describe("progress", () => {
  it("counts lines checked by anyone out of the lines there are to check", () => {
    const v = sampleVersion({ proofreads: [mark("t1", "Ana"), mark("t1", "Ben"), mark("grid:g1:0:0", "Ana")] });
    expect(progress(buildLines(v), v)).toEqual({ done: 1, total: 4 });
  });
  it("leaves out a grid with no amounts, which has nothing to mark", () => {
    const empty = { ...grid, rows: [{ ...grid.rows[0]!, cells: [null, null] }] };
    const v = sampleVersion();
    v.rulebook!.grids = [empty];
    expect(progress(buildLines(v), v)).toEqual({ done: 0, total: 3 });
  });
});
