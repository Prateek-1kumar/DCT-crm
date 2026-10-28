import { RulebookVersionDto } from "@dct/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRequest, mockReset } from "./mock/server";
import { proofUnits, reportWrong, unitStatus } from "./proofread";

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

describe("reporting wrong numbers while proofreading", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type V = { version: number; status: string; review: { id: string; path: string; outcome: null }[] };
  /** The API's report rules: the live version opens a draft once, a draft asks about a value once. `lose`: requests to lose for a path. */
  function server(lose: Record<string, { n: number; applied: boolean }>) {
    const versions = new Map<number, V>([[1, { version: 1, status: "signed", review: [] }]]);
    const posts: string[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const [, v, report] = /\/versions\/(\d+)(\/report)?$/.exec(url)!;
        if (!report) return json(200, versions.get(Number(v)));
        const { path } = JSON.parse(String(init!.body)) as { path: string };
        posts.push(`v${v} ${path}`);
        const lost = lose[path];
        const drop = !!lost && lost.n-- > 0;
        if (drop && !lost.applied) throw new TypeError("network");
        if (lost) lost.applied = false; // went through once: the rest of its tries are lost before they arrive
        let d = versions.get(Number(v))!;
        if (d.status === "signed") {
          const newest = Math.max(...versions.keys());
          if (newest !== d.version) return json(409, { message: `Version ${newest} is already in progress.` });
          versions.set(d.version + 1, (d = { version: d.version + 1, status: "draft", review: [] }));
        }
        if (d.review.some((i) => i.path === path)) return json(409, { message: "There's already an open question about this value." });
        d.review.push({ id: `reported:${d.review.length + 1}`, path, outcome: null });
        if (drop) throw new TypeError("network");
        return json(200, d);
      }),
    );
    return { posts, versions };
  }
  const live = { version: 1, status: "signed", review: [] } as unknown as RulebookVersionDto;
  const lost = async <T,>(p: Promise<T>) => {
    const out = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync(); // the client's own retries
    return out;
  };

  it("carries on in the draft the first report opened after the second one is lost", async () => {
    vi.useFakeTimers();
    const { posts, versions } = server({ "/b": { n: 3, applied: false } });
    const opened = { current: null as RulebookVersionDto | null };
    expect(await lost(reportWrong("s", live, ["/a", "/b"], "Ben", opened))).toMatchObject({ status: 0 });
    expect(opened.current?.version).toBe(2);
    // Try again: straight to version 2, and /a isn't asked twice.
    posts.length = 0;
    expect(await reportWrong("s", live, ["/a", "/b"], "Ben", opened)).toBe(2);
    expect(posts).toEqual(["v2 /b"]);
    expect(versions.get(2)!.review.map((i) => i.path)).toEqual(["/a", "/b"]);
  });

  it("takes a report that went through, though its answer was lost, as sent", async () => {
    vi.useFakeTimers();
    const { versions } = server({ "/b": { n: 3, applied: true } });
    const opened = { current: null as RulebookVersionDto | null };
    expect(await lost(reportWrong("s", live, ["/a", "/b"], "Ben", opened))).toMatchObject({ status: 0 });
    expect(await reportWrong("s", live, ["/a", "/b"], "Ben", opened)).toBe(2);
    expect(versions.get(2)!.review.map((i) => i.path)).toEqual(["/a", "/b"]);
    expect(opened.current!.review).toHaveLength(2);
  });
});
