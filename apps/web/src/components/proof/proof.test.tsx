import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { coverage as coverageData, sampleVersion } from "../contract/test-data";
import { mockApi, posts, renderWithClient, version } from "../version/fixtures";
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

vi.mock("@/components/PageView", async (original) => ({
  ...(await original<object>()),
  PageView: ({ boxes = [], focus, alt, zoom }: { boxes?: { label: string; mark: string; selected?: boolean; onClick?: () => void }[]; focus?: number[]; alt: string; zoom?: number }) => (
    <div role="group" aria-label={alt} data-focus={focus?.join(",")} data-zoom={zoom}>
      {boxes.map((b, i) => (
        <button key={i} type="button" aria-label={b.label} data-mark={b.mark} aria-pressed={!!b.selected} onClick={b.onClick} />
      ))}
    </div>
  ),
}));

const find = { boxes: [[0.1, 0.5, 0.6, 0.55]] };
const mark = (item: string, by: string) => ({ item, by, at: "2026-11-03T10:00:00Z" });

function setup(opts: { proofreads?: ReturnType<typeof mark>[]; coverage?: object } = {}) {
  let current = sampleVersion({ proofreads: opts.proofreads ?? [] });
  const fetch = mockApi({
    "GET /versions/v1": () => current,
    "GET /versions/v1/coverage": () => opts.coverage ?? coverageData(),
    "GET /documents/d1/pages/1/find": () => find,
    "POST /versions/v1/proofread": (body) => {
      const { by, items } = body as { by: string; items: string[] };
      current = { ...current, proofreads: [...current.proofreads, ...items.map((i) => mark(i, by))] };
      return current;
    },
    "DELETE /versions/v1/proofread": () => {
      current = { ...current, proofreads: [] };
      return current;
    },
  });
  renderWithClient(<ProofScreen versionId="v1" />);
  return fetch;
}

const urlParam = (k: string) => new URLSearchParams(nav.get()).get(k);
const line = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  nav.set("");
  setActingAs(null);
});
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

describe("proofread screen: overview of the work", () => {
  it("shows a skeleton while loading, then the progress and the coverage totals", async () => {
    setup({ proofreads: [mark("t1", "Ana")] });
    expect(screen.getByLabelText("Loading the proofread screen")).toBeTruthy();
    expect(await screen.findByText("1 of 4 checked by someone")).toBeTruthy();
    const totals = screen.getByRole("region", { name: "How the amounts were checked" });
    for (const label of ["Matched the PDF", "Confirmed by a person", "Set aside on purpose", "Missing from the rulebook"]) expect(within(totals).getByText(label)).toBeTruthy();
    expect(within(totals).getByRole("alert").textContent).toContain("1 amount printed in the contract isn't in the rulebook yet");
    expect(within(totals).getByText(/1 page in this contract is scanned/)).toBeTruthy();
  });

  it("lists every line under its group, with its proof and who proofread it", async () => {
    setup({ proofreads: [mark("t1", "Ana")] });
    await line("Startup fee");
    for (const g of ["Budget grids", "Holdback and overhead", "Site fees", "Recurring fees"]) expect(screen.getByRole("region", { name: g })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Site fees" })).getByText("Proofread by Ana")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Recurring fees" })).getByText("Not proofread yet")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Holdback and overhead" })).getByText("Open question")).toBeTruthy();
  });

  it("says when the contract has not been read yet", async () => {
    mockApi({ "GET /versions/v1": () => version({ rulebook: null }), "GET /versions/v1/coverage": () => ({ pages: [], totals: { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 } }) });
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByText("Nothing to proofread yet")).toBeTruthy();
  });

  it("says in plain words when it can't load", async () => {
    mockApi({});
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByRole("heading", { name: /We can't find the proofread screen/ })).toBeTruthy();
  });
});

describe("proofread screen: opens on a line", () => {
  it("with no link, selects the first line that needs checking and shows its page, without touching the URL", async () => {
    setup({ proofreads: [] });
    // the budget grid comes first and has no marks
    expect(await screen.findByRole("heading", { name: "Visit budget" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Visit budget/, current: true })).toBeTruthy();
    expect(nav.get()).toBe("");
    expect(screen.queryByText(/Pick a line/)).toBeNull();
  });

  it("skips lines that are already checked and proven", async () => {
    const v = sampleVersion({ proofreads: [mark("grid:g1:0:0", "Ana"), mark("grid:g1:0:1", "Ana"), mark("t1", "Ana")] });
    v.rulebook!.grids = [{ ...v.rulebook!.grids[0]!, total: [2500, 3000] }]; // a printed total proves the grid
    mockApi({ "GET /versions/v1": () => v, "GET /versions/v1/coverage": () => coverageData(), "GET /documents/d1/pages/1/find": () => find });
    renderWithClient(<ProofScreen versionId="v1" />);
    // the grid and Startup fee are done; Holdback has an open question
    expect(await screen.findByRole("heading", { name: "Holdback" })).toBeTruthy();
  });

  it("falls back to the first line when everything is checked", async () => {
    const v = sampleVersion();
    v.rulebook!.terms = [v.rulebook!.terms[0]!];
    v.rulebook!.grids = [];
    v.rulebook!.questions = [];
    mockApi({ "GET /versions/v1": () => ({ ...v, proofreads: [mark("t1", "Ana")] }), "GET /versions/v1/coverage": () => coverageData(), "GET /documents/d1/pages/1/find": () => find });
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByRole("heading", { name: "Startup fee" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contract.pdf, page 1" })).toBeTruthy();
  });

  it("keeps the 'Pick a line' text for a rulebook with no lines", async () => {
    const v = sampleVersion();
    v.rulebook!.terms = [];
    v.rulebook!.grids = [];
    mockApi({ "GET /versions/v1": () => v, "GET /versions/v1/coverage": () => coverageData() });
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByText(/Pick a line/)).toBeTruthy();
  });
});

describe("proofread screen: lines and the page select each other", () => {
  it("selecting a term shows its words, its page and the quote highlighted", async () => {
    setup();
    fireEvent.click(await line("Startup fee"));
    expect(urlParam("ref")).toBe("term:t1");
    expect(await screen.findByText("Startup fee $5,000")).toBeTruthy();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    const quote = await screen.findByRole("button", { name: "The words quoted in the rulebook" });
    expect(quote.dataset.mark).toBe("highlight");
    // the term's own $5,000 amount is on the page too and is a strong highlight; the problem ($99) is light
    expect((screen.getByRole("button", { name: /^\$5,000\.00/ })).dataset.mark).toBe("highlight");
    expect((screen.getByRole("button", { name: /^\$99\.00/ })).dataset.mark).toBe("missing");
    expect(screen.getByRole("button", { name: /Startup fee/, current: true })).toBeTruthy();
  });

  it("clicking a highlighted amount selects the line it became", async () => {
    nav.set("doc=d1&page=1");
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /^\$99\.00/ }));
    expect(urlParam("box")).toBe("1");
    expect(urlParam("ref")).toBeNull();
    expect((await screen.findAllByText(/Not in the rulebook yet: this needs a look before approval/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    fireEvent.click(screen.getByRole("button", { name: /^\$5,000\.00/ }));
    expect(urlParam("ref")).toBe("term:t1");
    expect(screen.getByRole("button", { name: /Startup fee/, current: true })).toBeTruthy();
  });

  it("opens a grid line on its first page and a grid cell link on that cell", async () => {
    nav.set("ref=grid:g1:0:1");
    setup();
    expect(await screen.findByRole("heading", { name: "Blood draw, Week 4" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect((await screen.findByRole("button", { name: /^\$31\.00/ })).dataset.mark).toBe("highlight");
    expect(screen.getByRole("button", { name: /Visit budget/, current: true })).toBeTruthy();
  });

  it("opens the page a link names, with the amount selected and explained", async () => {
    nav.set("doc=d1&page=2&box=2");
    setup();
    expect(await screen.findByText("Superseded budget", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" }).dataset.focus).toMatch(/^0\.1,0\.3,/);
  });

  it("still opens from an old link that names a tab", async () => {
    nav.set("tab=contract&ref=term:t1");
    setup();
    expect(await screen.findByText("Startup fee $5,000")).toBeTruthy();
  });

  it("moves between pages and zooms", async () => {
    nav.set("doc=d1&page=1");
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(urlParam("page")).toBe("2");
    expect(await screen.findByText("Page 2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("group", { name: "Contract.pdf, page 2" }).dataset.zoom).toBe("1.5");
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("draws problems only until every amount is asked for, with a second cue besides colour", async () => {
    nav.set("doc=d1&page=2");
    setup();
    await screen.findByRole("button", { name: /^\$31\.00/ });
    expect(screen.queryByRole("button", { name: /^\$25\.00/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^\$31\.00.*read with a doubt: handwritten/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    expect(screen.getByRole("button", { name: /^\$25\.00 · captured/ }).dataset.mark).toBe("captured");
    expect(screen.getByRole("button", { name: /^\$30\.00 · decided by a person/ }).dataset.mark).toBe("decided");
    expect(screen.getByRole("button", { name: /^\$1,000\.00 · set aside/ }).dataset.mark).toBe("set_aside");
    expect(screen.getByRole("list", { name: "What the outlines mean" })).toBeTruthy();
  });

  it("Next missing jumps to the missing amount", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Next missing" }));
    expect(urlParam("box")).toBe("1");
    expect(urlParam("page")).toBe("1");
  });

  it("explains a scanned page that can't be searched", async () => {
    nav.set("doc=d2&page=1");
    setup();
    expect(await screen.findByText(/Scanned page: the words on it can't be searched or checked/)).toBeTruthy();
  });
});

describe("proofread screen: filters and marks", () => {
  it("filters to what needs checking and to what I proofread", async () => {
    setActingAs("Ana");
    setup({ proofreads: [mark("t1", "Ana"), mark("t3", "Ben")] });
    await line("Startup fee");
    expect(screen.getByRole("button", { name: "All 4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Needs checking 3" }));
    expect(screen.queryByRole("button", { name: /^Startup fee/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Archive fee/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Proofread by me 1" }));
    expect(screen.getByRole("button", { name: /^Startup fee/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Archive fee/ })).toBeNull();
  });

  it("marks a line proofread as me and the progress moves", async () => {
    setActingAs("Ana");
    const fetch = setup();
    await line("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: "Mark as proofread: Startup fee" }));
    await waitFor(() => expect(screen.getByText("1 of 4 checked by someone")).toBeTruthy());
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["t1"] });
    expect(screen.getByRole("button", { name: "Remove my proofread mark from Startup fee" })).toBeTruthy();
  });

  it("takes my mark back off", async () => {
    setActingAs("Ana");
    const fetch = setup({ proofreads: [mark("t1", "Ana")] });
    fireEvent.click(await screen.findByRole("button", { name: "Remove my proofread mark from Startup fee" }));
    await waitFor(() => expect(screen.getByText("0 of 4 checked by someone")).toBeTruthy());
    expect(fetch.mock.calls.some(([u, i]) => i?.method === "DELETE" && String(u).includes("by=Ana") && String(u).includes("item=t1"))).toBe(true);
  });

  it("marks every visible line, one mark per grid cell", async () => {
    setActingAs("Ana");
    const fetch = setup({ proofreads: [mark("t1", "Ana")] });
    await line("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: "Mark all visible as proofread" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    const { items } = JSON.parse(posts(fetch)[0]![1]!.body as string) as { items: string[] };
    expect(items.sort()).toEqual(["grid:g1:0:0", "grid:g1:0:1", "t2", "t3"]);
    await waitFor(() => expect(screen.getByText("4 of 4 checked by someone")).toBeTruthy());
  });

  it("asks for a name instead of sending when nobody has chosen one", async () => {
    const fetch = setup();
    await line("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: "Mark as proofread: Startup fee" }));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("shows a plain-English error when the mark didn't go through", async () => {
    setActingAs("Ana");
    mockApi({
      "GET /versions/v1": () => sampleVersion(),
      "GET /versions/v1/coverage": () => coverageData(),
      "POST /versions/v1/proofread": () => new Response(JSON.stringify({ message: "This version has been replaced by a newer live one, so it can't be proofread." }), { status: 409 }),
    });
    renderWithClient(<ProofScreen versionId="v1" />);
    await line("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: "Mark as proofread: Startup fee" }));
    expect((await screen.findByText(/replaced by a newer live one/)).getAttribute("role")).toBe("alert");
  });
});
