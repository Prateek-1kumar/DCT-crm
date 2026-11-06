import type { Grid } from "@dct/shared";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coverage, CoveragePage } from "@/lib/types";
import { mockApi, question, renderWithClient, rulebook, term, version } from "../version/fixtures";
import { ProofScreen } from "./ProofScreen";

const nav = vi.hoisted(() => {
  let search = "";
  const subs = new Set<() => void>();
  return {
    get: () => search,
    set: (s: string) => {
      search = s;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  };
});

vi.mock("next/navigation", () => {
  const go = (url: string) => nav.set(url.split("?")[1] ?? "");
  return {
    usePathname: () => "/versions/v1/proof",
    useRouter: () => ({ push: go, replace: go }),
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(nav.subscribe, nav.get)),
  };
});

vi.mock("@/components/PageView", () => ({
  PageView: ({ boxes = [], focus, alt }: { boxes?: { label: string; mark: string; selected?: boolean; onClick?: () => void }[]; focus?: number[]; alt: string }) => (
    <div role="group" aria-label={alt} data-focus={focus?.join(",")}>
      {boxes.map((b, i) => (
        <button key={i} type="button" aria-label={b.label} data-mark={b.mark} aria-pressed={!!b.selected} onClick={b.onClick} />
      ))}
    </div>
  ),
}));

vi.mock("@/components/rulebook", async (original) => ({
  ...(await original<object>()),
  GridTable: ({ grid, selected, onCellClick }: { grid: Grid; selected?: { row: number; col: number } | null; onCellClick?: (r: number, c: number) => void }) => (
    <div role="table" aria-label={`grid ${grid.name}`} data-selected={selected ? `${selected.row},${selected.col}` : ""}>
      <button type="button" onClick={() => onCellClick?.(0, 0)}>cell 0,0</button>
    </div>
  ),
}));

const grid: Grid = {
  id: "g1",
  name: "Visit budget",
  arm: null,
  doc: "Contract.pdf",
  pages: [2],
  visits: ["Screening", "Week 4"],
  overheadPct: null,
  rows: [{ name: "Blood draw", code: null, unitCostCents: null, cells: [2500, 3000], printedRowTotalCents: null }],
  subtotal: null,
  overhead: null,
  additions: [],
  total: null,
  grandTotalCents: null,
  cellsReadTwice: [],
};

const amount = (text: string, status: CoveragePage["amounts"][number]["status"], ref: CoveragePage["amounts"][number]["ref"], reason: string | null = null, y = 0.1): CoveragePage["amounts"][number] => ({
  box: [0.1, y, 0.3, y + 0.04],
  text,
  line: text,
  cents: 100,
  status,
  ref,
  reason,
  doubt: null,
});

const coverage = (over: Partial<Coverage> = {}): Coverage => ({
  pages: [
    {
      documentId: "d1",
      doc: "Contract.pdf",
      page: 1,
      kind: "text",
      amounts: [amount("$5,000.00", "captured", { target: "term", id: "t1" }), amount("$99.00", "missing", null, null, 0.2)],
      clauses: [{ termId: "t1", boxes: [[0.1, 0.5, 0.6, 0.55]] }],
    },
    {
      documentId: "d1",
      doc: "Contract.pdf",
      page: 2,
      kind: "text",
      amounts: [amount("$25.00", "captured", { target: "grid", id: "g1", row: 0, col: 0 }), amount("$30.00", "decided", { target: "term", id: "t2" }, null, 0.2), amount("$1,000.00", "set_aside", null, "Superseded budget", 0.3)],
      clauses: [],
    },
    { documentId: "d2", doc: "Amendment.pdf", page: 1, kind: "image", amounts: [], clauses: [] },
  ],
  totals: { amounts: 5, captured: 2, decided: 1, setAside: 1, missing: 1 },
  ...over,
});

const find = { boxes: [[0.1, 0.1, 0.5, 0.14]] };

function setup(cov: Coverage = coverage()) {
  mockApi({
    "GET /versions/v1": () =>
      version({
        documents: [
          { id: "d1", name: "Contract.pdf", pageCount: 2 },
          { id: "d2", name: "Amendment.pdf", pageCount: 1 },
        ],
        rulebook: rulebook({
          terms: [
            term("t1", { name: "Startup fee", category: "site_fee", amountCents: 500000, source: { doc: "Contract.pdf", page: 1, quote: "Startup fee $5,000" } }),
            term("t2", { name: "Holdback", category: "holdback", evidence: "person" }),
          ],
          grids: [grid],
          questions: [question("q1", { about: { target: "term", id: "t2" } })],
        }),
        answers: [{ questionId: "q1", option: 0, by: "Ana", at: "2026-11-02T10:00:00Z" }],
      }),
    "GET /versions/v1/coverage": () => cov,
    "GET /documents/d1/pages/1/find": () => find,
  });
  return renderWithClient(<ProofScreen versionId="v1" />);
}

const box = (name: RegExp) => screen.findByRole("button", { name });
const urlParam = (k: string) => new URLSearchParams(nav.get()).get(k);

beforeEach(() => {
  nav.set("");
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("proof screen: contract tab", () => {
  it("shows the totals, the missing warning and the scanned-page note", async () => {
    setup();
    expect(await screen.findByText("5 amounts in the contract")).toBeTruthy();
    for (const chip of ["2 captured", "1 decided by a person", "1 set aside", "1 missing"]) expect(screen.getByRole("button", { name: chip })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Not in the rulebook yet: this needs a look before approval");
    expect(screen.getByText(/1 page in this contract is scanned/)).toBeTruthy();
    expect(screen.getByText("Scanned page: amounts on it can't be checked")).toBeTruthy();
  });

  it("says a page read from the image is a scan, without warning about it", async () => {
    const base = coverage();
    setup({ ...base, pages: base.pages.map((p) => (p.documentId === "d2" ? { ...p, kind: "scan" as const } : p)) });
    expect(await screen.findByText("Scanned page, read from the image")).toBeTruthy();
    expect(screen.queryByText(/is scanned: amounts on it can't be checked/)).toBeNull();
  });

  it.each([
    ["unsure", "unsure"],
    ["handwritten", "handwritten"],
    ["struck_out", "struck out"],
    ["initialed", "initialed"],
  ] as const)("marks an amount read as %s with a pill", async (doubt, words) => {
    const base = coverage();
    setup({ ...base, pages: base.pages.map((p) => ({ ...p, amounts: p.amounts.map((a) => (a.text === "$5,000.00" ? { ...a, doubt } : a)) })) });
    fireEvent.click(await box(/\$5,000\.00 · captured/));
    expect(await screen.findByText(words)).toBeTruthy();
  });

  it("shows no doubt pill on an amount with no doubt", async () => {
    setup();
    fireEvent.click(await box(/\$5,000\.00 · captured/));
    await screen.findByText("Startup fee");
    expect(screen.queryByText("unsure")).toBeNull();
  });

  it("says nothing is missing when the count is zero", async () => {
    setup(coverage({ totals: { amounts: 5, captured: 3, decided: 1, setAside: 1, missing: 0 } }));
    expect(await screen.findByText(/Nothing missing/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "0 missing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Next missing" })).toBeNull();
  });

  it("colours each amount by what happened to it and draws rule wording in its own mark", async () => {
    setup();
    expect((await box(/^\$5,000\.00/)).dataset.mark).toBe("captured");
    expect(screen.getByRole("button", { name: /^\$30\.00/ }).dataset.mark).toBe("decided");
    expect(screen.getByRole("button", { name: /^\$1,000\.00.*Superseded budget/ }).dataset.mark).toBe("set_aside");
    expect(screen.getByRole("button", { name: /^\$99\.00/ }).dataset.mark).toBe("missing");
    expect(screen.getByRole("button", { name: /Rule wording behind "Startup fee"/ }).dataset.mark).toBe("clause");
  });

  it("filters pages and boxes by a count, and clears the filter on a second click", async () => {
    setup();
    await box(/^\$99\.00/);
    fireEvent.click(screen.getByRole("button", { name: "1 missing" }));
    expect(screen.queryByRole("button", { name: /^\$5,000\.00/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Contract.pdf, page 2" })).toBeNull();
    expect(screen.getByRole("button", { name: /^\$99\.00/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 missing" }));
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" })).toBeTruthy();
  });

  it("Next missing selects the missing amount and explains it", async () => {
    setup();
    await box(/^\$99\.00/);
    fireEvent.click(screen.getByRole("button", { name: "Next missing" }));
    expect(screen.getByRole("button", { name: /^\$99\.00/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("The contract prints $99.00 here"))).toBe(true);
    expect(urlParam("box")).toBe("1");
  });

  it("opens a term's detail with value, billing, quote, page and proof", async () => {
    setup();
    fireEvent.click(await box(/^\$5,000\.00/));
    const panel = screen.getByRole("heading", { name: "What this became" }).parentElement!;
    expect(within(panel).getByText("Startup fee")).toBeTruthy();
    expect(within(panel).getByText("Fees paid once")).toBeTruthy();
    expect(within(panel).getByText("Startup fee $5,000")).toBeTruthy();
    expect(within(panel).getByText("Contract.pdf, page 1")).toBeTruthy();
    expect(within(panel).getByText("Matches the contract", { selector: "dd" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Show in rulebook" })).toBeTruthy();
  });

  it("says who decided a term a person decided", async () => {
    setup();
    fireEvent.click(await box(/^\$30\.00/));
    expect(screen.getByText("Decided by Ana: q1 option A")).toBeTruthy();
  });

  it("opens a grid cell's detail with the item, the visit and the grid with that cell selected", async () => {
    setup();
    fireEvent.click(await box(/^\$25\.00/));
    expect(screen.getByText("Blood draw")).toBeTruthy();
    expect(screen.getByText("Screening")).toBeTruthy();
    expect(screen.getByRole("table", { name: "grid Visit budget" }).dataset.selected).toBe("0,0");
  });

  it("shows the reason for a set-aside amount and no rulebook button", async () => {
    setup();
    fireEvent.click(await box(/^\$1,000\.00/));
    expect(screen.getByText("Superseded budget", { selector: "p" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in rulebook" })).toBeNull();
  });

  it("turns rule wording and amounts off with the layer switches", async () => {
    setup();
    await box(/^\$5,000\.00/);
    fireEvent.click(screen.getByRole("button", { name: "Rule wording" }));
    expect(screen.queryByRole("button", { name: /Rule wording behind/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^\$5,000\.00/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Amounts" }));
    expect(screen.queryByRole("button", { name: /^\$5,000\.00/ })).toBeNull();
  });

  it("draws only the pages near the screen and the page a link points at", async () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    nav.set("doc=d1&page=2");
    setup();
    expect(await screen.findByRole("group", { name: "Contract.pdf, page 2" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Contract.pdf, page 1" })).toBeNull();
  });
});

describe("proof screen: rulebook tab and the URL", () => {
  it("keeps the selection when switching tabs both ways", async () => {
    setup();
    fireEvent.click(await box(/^\$5,000\.00/));
    fireEvent.click(screen.getByRole("button", { name: "Show in rulebook" }));
    expect(screen.getByRole("tab", { name: "Rulebook", selected: true })).toBeTruthy();
    expect(urlParam("tab")).toBe("rulebook");
    expect(urlParam("ref")).toBe("term:t1");
    expect(screen.getByRole("button", { name: /Startup fee/ }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("button", { name: "The words quoted in the rulebook" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contract.pdf, page 1" }).dataset.focus).toBe("0.1,0.1,0.5,0.14");

    fireEvent.click(screen.getByRole("button", { name: "Show on contract" }));
    expect(screen.getByRole("tab", { name: "Contract", selected: true })).toBeTruthy();
    expect((await box(/^\$5,000\.00/)).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens a grid cell from the link and shows the matching amount on the grid's page", async () => {
    nav.set("tab=rulebook&ref=grid:g1:0:0");
    setup();
    expect((await screen.findByRole("table", { name: "grid Visit budget" })).dataset.selected).toBe("0,0");
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" })).toBeTruthy();
    expect((await screen.findByRole("button", { name: "This amount in the contract" })).dataset.mark).toBe("highlight");
  });

  it("selects a cell by clicking it and writes it to the URL", async () => {
    nav.set("tab=rulebook");
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "cell 0,0" }));
    expect(urlParam("ref")).toBe("grid:g1:0:0");
    expect(screen.getByRole("table", { name: "grid Visit budget" }).dataset.selected).toBe("0,0");
  });

  it("groups terms by kind of payment with their proof badge", async () => {
    nav.set("tab=rulebook");
    setup();
    const fees = (await screen.findByRole("heading", { name: "Fees paid once" })).parentElement!;
    expect(within(fees).getByText("Startup fee")).toBeTruthy();
    expect(within(fees).getByText("Matches the contract")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Holdback" })).toBeTruthy();
  });

  it("opens the contract on the spot a link names", async () => {
    nav.set("tab=contract&doc=d1&page=2&box=2&ref=");
    setup();
    expect(await screen.findByText("Superseded budget", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" }).dataset.focus).toMatch(/^0\.1,0\.3,/);
  });
});
