import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Region } from "@dct/shared";
import { mockApi, posts } from "../version/fixtures";
import type { ShowRef } from "../rulebook";
import { ContractSidePanel } from "./ContractSidePanel";
import { coverage, sampleVersion } from "./test-data";

// jsdom can't lay a page out, so the viewer is a stand-in that shows what it was given.
vi.mock("../viewer", async (original) => ({
  ...(await original<object>()),
  ContractViewer: (p: { documentId: string; page: number; boxes: { id: string; tone: string; label: string; box: Region }[]; focus: Region | null; startIn?: string; toolbarExtra?: ReactNode; ariaLabel: string; onPageChange: (n: number) => void }) => (
    <div role="group" aria-label={p.ariaLabel} data-doc={p.documentId} data-page={p.page} data-focus={JSON.stringify(p.focus)} data-start={p.startIn}>
      {p.toolbarExtra}
      <button type="button" onClick={() => p.onPageChange(p.page + 1)}>
        Next page
      </button>
      {p.boxes.map((b) => (
        <span key={b.id} data-testid="box" data-tone={b.tone} aria-label={b.label} />
      ))}
    </div>
  ),
}));

// The panel is handed a version by its parent; this host re-reads it from the cache like the workspace does.
function Host({ target, onClose = () => {}, onOpenFull = () => {} }: { target: ShowRef | null; onClose?: () => void; onOpenFull?: () => void }) {
  const v = useQuery({ queryKey: keys.version("v1"), queryFn: () => api.version("v1") });
  return v.data ? <ContractSidePanel version={v.data} target={target} onClose={onClose} onOpenFull={onOpenFull} /> : null;
}

type Over = { find?: object; version?: Parameters<typeof sampleVersion>[0]; coverage?: () => unknown; onClose?: () => void; onOpenFull?: () => void };

function setup(target: ShowRef | null, over: Over = {}) {
  const current = sampleVersion(over.version);
  const fetch = mockApi({
    "GET /versions/v1": () => current,
    "GET /versions/v1/coverage": over.coverage ?? coverage,
    "GET /documents/d1/pages/1/find": () => over.find ?? { boxes: [[0.1, 0.5, 0.6, 0.55]] },
    "POST /versions/v1/proofread": () => current,
  });
  // One client for the whole test, so a re-render keeps the cache (the panel opens and closes on the same page).
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" }, mutations: { networkMode: "always" } } });
  const ui = (t: ShowRef | null) => (
    <QueryClientProvider client={client}>
      <Host target={t} onClose={over.onClose} onOpenFull={over.onOpenFull} />
    </QueryClientProvider>
  );
  const view = render(ui(target));
  return { fetch, view, ui };
}

const boxes = () => screen.queryAllByTestId("box");
const tones = () => boxes().map((b) => b.dataset.tone);

beforeEach(() => setActingAs(null));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

describe("ContractSidePanel", () => {
  it("shows nothing without a target", () => {
    setup(null);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("has a compact header: name, value, proof, page and file, the quote, and the review buttons", async () => {
    setup({ target: "term", id: "t1" });
    expect(await screen.findByRole("heading", { name: "Startup fee" })).toBeTruthy();
    expect(screen.getByText("$5,000.00")).toBeTruthy();
    expect(screen.getByText("Matches the contract", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Page 1 · Contract.pdf")).toBeTruthy();
    expect(screen.getByText("Startup fee $5,000").closest("p")!.className).toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Matches the contract" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Something looks wrong" })).toBeTruthy();
    // a short quote needs no "Show full quote"
    expect(screen.queryByRole("button", { name: "Show full quote" })).toBeNull();
  });

  it("clamps a long quote and shows all of it on request", async () => {
    const long = "The Sponsor shall pay the Institution a one-time startup fee, due within thirty days of receipt of the invoice, which is not refundable once the study has opened. ".repeat(2);
    setup({ target: "term", id: "t1" }, { version: { rulebook: { ...sampleVersion().rulebook!, terms: [{ ...sampleVersion().rulebook!.terms[0]!, source: { doc: "Contract.pdf", page: 1, quote: long } }] } } });
    const more = await screen.findByRole("button", { name: "Show full quote" });
    expect(screen.getByText(long.trim()).closest("p")!.className).toContain("line-clamp-2");
    fireEvent.click(more);
    expect(screen.getByText(long.trim()).closest("p")!.className).not.toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("keeps conditions, how it is paid, cap, deadline and notes behind a closed Details button", async () => {
    const t = { ...sampleVersion().rulebook!.terms[0]!, trigger: "On IRB approval", conditions: "Non-refundable", cap: { kind: "count" as const, value: 3, period: "year", text: "" }, deadline: "30 days", notes: "Per the cover letter" };
    setup({ target: "term", id: "t1" }, { version: { rulebook: { ...sampleVersion().rulebook!, terms: [t] } } });
    const details = await screen.findByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Non-refundable")).toBeNull();
    fireEvent.click(details);
    expect(screen.getByText("On IRB approval · Non-refundable")).toBeTruthy();
    expect(screen.getByText("capped at 3 per year")).toBeTruthy();
    expect(screen.getByText("30 days")).toBeTruthy();
    expect(screen.getByText("Per the cover letter")).toBeTruthy();
    expect(screen.getByText("You invoice for it")).toBeTruthy();
  });

  it("opens the viewer on the passage: zoomed on the quote, with only the page's problems drawn until asked", async () => {
    setup({ target: "term", id: "t1" });
    const viewer = await screen.findByRole("group", { name: "Contract.pdf" });
    expect(viewer.dataset.start).toBe("passage");
    expect(viewer.dataset.page).toBe("1");
    expect(JSON.parse(viewer.dataset.focus!)).toEqual([0.1, 0.5, 0.6, 0.55]);
    // the quote, the line's own amount ($5,000, always shown) and the missing $99
    expect(tones().sort()).toEqual(["focus", "focus", "problem"]);
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    expect(screen.getByRole("button", { name: "Show every amount" }).getAttribute("aria-pressed")).toBe("true");
    expect(tones()).toHaveLength(3); // page 1 has no other amounts
  });

  describe("a passage that could not be pinned to the exact spot", () => {
    const NOTE = "We couldn't pin down the exact spot on this scanned page, so the highlighted area is approximate. What you're looking for is inside it.";

    it("says nothing and marks nothing approximate when every box is exact", async () => {
      setup({ target: "term", id: "t1" });
      await screen.findByRole("group", { name: "Contract.pdf" });
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(boxes().every((b) => !b.getAttribute("aria-label")!.includes("area"))).toBe(true);
    });

    it("an approximate search result is worded as an area and explained", async () => {
      setup({ target: "term", id: "t1" }, { find: { boxes: [[0.05, 0.3, 0.95, 0.7]], approx: true } });
      expect(await screen.findByText(NOTE)).toBeTruthy();
      expect(screen.getByLabelText("Approximate area · The words quoted in the rulebook")).toBeTruthy();
    });

    it("saved clause boxes flagged approximate are used when the search finds nothing", async () => {
      const cov = () => {
        const c = coverage();
        Object.assign(c.pages[0]!.clauses[0]!, { approx: true });
        return c;
      };
      setup({ target: "term", id: "t1" }, { find: { boxes: [] }, coverage: cov });
      expect(await screen.findByText(NOTE)).toBeTruthy();
      expect(screen.getByLabelText("Approximate area · The words quoted in the rulebook")).toBeTruthy();
    });

    it("an approximate amount says it is somewhere in the area", async () => {
      const cov = () => {
        const c = coverage();
        Object.assign(c.pages[0]!.amounts[0]!, { approx: true });
        return c;
      };
      setup({ target: "term", id: "t1" }, { coverage: cov });
      expect(await screen.findByLabelText(/^\$5,000\.00 is somewhere in this area · /)).toBeTruthy();
      expect(screen.getByText(NOTE)).toBeTruthy();
    });
  });

  it("draws every amount of a busier page only when asked", async () => {
    setup({ target: "grid", id: "g1", row: 0, col: 0 });
    const viewer = await screen.findByRole("group", { name: "Contract.pdf" });
    expect(viewer.dataset.page).toBe("2");
    expect(JSON.parse(viewer.dataset.focus!)).toEqual([0.1, 0.1, 0.3, 0.14]);
    expect(tones().sort()).toEqual(["doubt", "focus"]); // the cell, and the doubtful $31
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    expect(tones().sort()).toEqual(["decided", "doubt", "focus", "set_aside"]);
  });

  it("opens a whole grid on its page and lets the person turn the page", async () => {
    setup({ target: "grid", id: "g1", row: -1, col: 0 });
    expect(await screen.findByRole("heading", { name: "Visit budget" })).toBeTruthy();
    const viewer = await screen.findByRole("group", { name: "Contract.pdf" });
    expect(viewer.dataset.page).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("group", { name: "Contract.pdf" }).dataset.page).toBe("3");
    expect(screen.getByRole("group", { name: "Contract.pdf" }).dataset.focus).toBe("null");
  });

  it("Expand and Close call back; Escape closes too, but not from the note box", async () => {
    const onOpenFull = vi.fn();
    const onClose = vi.fn();
    setActingAs("Ana"); // a name is needed before the note box opens
    setup({ target: "term", id: "t1" }, { onOpenFull, onClose });
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    expect(onOpenFull).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close the contract panel" }));
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Something looks wrong" }));
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the panel and gives it back to the card that opened it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { view, ui } = setup(null);
    view.rerender(ui({ target: "term", id: "t1" }));
    const heading = await screen.findByRole("heading", { name: "Startup fee" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    view.rerender(ui(null));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("says the spot isn't on the pages we have when the line has no page", async () => {
    setup({ target: "grid", id: "gone", row: 0, col: 0 });
    expect(await screen.findByText("This line is no longer in the rulebook.")).toBeTruthy();
    expect(await screen.findByText("This spot isn't on the pages we have")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Contract.pdf" })).toBeNull();
  });

  it("shows a skeleton while the pages load, then a plain error with a retry when they can't", async () => {
    setup({ target: "term", id: "t1" }, { coverage: () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }) });
    expect(await screen.findByLabelText("Loading the contract page")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Something went wrong on the server/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("marks the item as matching the contract through the review buttons", async () => {
    setActingAs("Ana");
    const { fetch } = setup({ target: "term", id: "t1" });
    fireEvent.click(await screen.findByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["t1"] });
  });
});
