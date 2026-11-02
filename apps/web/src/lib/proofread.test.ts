import { interpretations, openPaths, type RulebookVersionDto } from "@dct/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmed, rulebook, version as fixture } from "../test/fixtures";
import { EVIDENCE } from "../components/review-context";
import { proofUnits, reportWrong, unitStatus } from "./proofread";

/** A draft read from a text PDF: every number confirmed, one visit total by the contract's own sums, the interpretations asked. */
function version() {
  const rb = rulebook();
  const evidence = confirmed(rb);
  Object.assign(evidence.find((e) => e.path === "/budgetGrids/0/visits/0/totalCents")!, { status: "confirmed_by_math" });
  return fixture(rb, { evidence, review: interpretations(rb, { amendment: false }) });
}

describe("proofread units", () => {
  it("proofreads a value the contract's own totals confirm, and says so in plain words", () => {
    const v = version();
    const [math] = v.evidence.filter((e) => e.status === "confirmed_by_math");
    const unit = proofUnits(v).find((u) => u.cells.some((c) => c.path === math!.path));
    expect(unit?.byMath).toBe(true);
    expect(EVIDENCE.confirmed_by_math.label).toBe("Confirmed by the contract's own totals");
    expect(EVIDENCE.confirmed_by_math.label).not.toBe(EVIDENCE.confirmed.label);
  });

  it("groups confirmed values into terms, visit totals and grid rows, biggest money first", () => {
    const v = version();
    const units = proofUnits(v);
    const order = units.map((u) => u.section);
    expect(order.indexOf("totals")).toBeGreaterThan(order.lastIndexOf("terms"));
    expect(order.indexOf("rows")).toBeGreaterThan(order.lastIndexOf("totals"));

    // Every confirmed value with a place on a page is in exactly one unit; values with an open question are not, nor a
    // cap's figures while its kind is asked
    const open = new Set(openPaths(v));
    expect(open.has("/screenFail/cap/ratio")).toBe(true);
    const confirmedPaths = v.evidence.filter((e) => (e.status === "confirmed" || e.status === "confirmed_by_math") && e.where[0] && !open.has(e.path)).map((e) => e.path);
    expect(units.flatMap((u) => u.cells.map((c) => c.path)).sort()).toEqual([...confirmedPaths].sort());

    const rows = units.filter((u) => u.section === "rows");
    expect(rows[0]!.cells[0]!.label).toBe("Unit");
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.money).toBeGreaterThanOrEqual(rows[i]!.money);
    // Non-amount terms (percentages, days) lead: they apply to everything.
    expect(units[0]!.cells[0]!.path).not.toMatch(/Cents$/);
  });

  it("a unit is done when all its values are marked, reported when any was sent to Needs you", () => {
    const u = proofUnits(version()).find((x) => x.section === "rows")!;
    const marks = new Map(u.cells.map((c) => [c.path, { path: c.path, by: "Avery Chen", at: "2026-10-28T10:00:00Z" }]));
    expect(unitStatus(u, new Map(), new Set())).toBe("todo");
    expect(unitStatus(u, marks, new Set())).toBe("done");
    expect(unitStatus(u, marks, new Set([u.cells[1]!.path]))).toBe("reported");
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
