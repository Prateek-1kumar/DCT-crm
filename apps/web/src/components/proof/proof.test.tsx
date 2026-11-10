import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
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

// The viewer has its own tests; here it is a stand-in that shows what the screen told it.
vi.mock("../viewer", async (original) => ({
  ...(await original<object>()),
  ContractViewer: (p: {
    documentId: string;
    page: number;
    pageCount: number;
    onPageChange: (n: number) => void;
    boxes: { id: string; tone: string; label: string }[];
    focus: number[] | null;
    startIn?: string;
    onBoxClick?: (id: string) => void;
    toolbarExtra?: ReactNode;
    ariaLabel: string;
  }) => (
    <div role="group" aria-label={p.ariaLabel} data-doc={p.documentId} data-page={p.page} data-focus={p.focus?.join(",")} data-start={p.startIn}>
      <span>
        Page {p.page} of {p.pageCount}
      </span>
      <button type="button" aria-label="Next page" onClick={() => p.onPageChange(p.page + 1)} />
      {p.toolbarExtra}
      {p.boxes.map((b) => (
        <button key={b.id} type="button" aria-label={b.label} data-tone={b.tone} onClick={() => p.onBoxClick?.(b.id)} />
      ))}
    </div>
  ),
}));

const find = { boxes: [[0.1, 0.5, 0.6, 0.55]] };
const at = "2026-11-03T10:00:00Z";
const mark = (item: string, by: string) => ({ item, by, at });
type Marks = ReturnType<typeof mark>[];

function setup(opts: { proofreads?: Marks; flags?: { item: string; by: string; note: string; at: string }[]; edit?: (v: ReturnType<typeof sampleVersion>) => void; coverage?: (c: ReturnType<typeof coverageData>) => void; find?: object } = {}) {
  let current = sampleVersion({ proofreads: opts.proofreads ?? [], flags: opts.flags ?? [] });
  opts.edit?.(current);
  const fetch = mockApi({
    "GET /versions/v1": () => current,
    "GET /versions/v1/coverage": () => {
      const c = coverageData();
      opts.coverage?.(c);
      return c;
    },
    "GET /documents/d1/pages/1/find": () => opts.find ?? find,
    "POST /versions/v1/proofread": (body) => {
      const { by, items } = body as { by: string; items: string[] };
      current = { ...current, proofreads: [...current.proofreads, ...items.map((i) => mark(i, by))] };
      return current;
    },
    "DELETE /versions/v1/proofread": () => ((current = { ...current, proofreads: [] }), current),
  });
  renderWithClient(<ProofScreen versionId="v1" />);
  return fetch;
}

const urlParam = (k: string) => new URLSearchParams(nav.get()).get(k);
const viewer = () => screen.findByRole("group", { name: "Contract.pdf" });
const row = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });
const press = async (key: string) => fireEvent.keyDown(await viewer(), { key });
const resize = (w: number) => act(() => void ((window.innerWidth = w), window.dispatchEvent(new Event("resize"))));

beforeEach(() => {
  nav.set("");
  // where the last test left off is remembered per version, as it is for a person
  localStorage.clear();
  setActingAs(null);
  window.innerWidth = 1400;
});
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
  window.innerWidth = 1024;
});

describe("the screen's bar and rail", () => {
  it("shows a skeleton, then the progress, the filter counts and the way back", async () => {
    setup({ proofreads: [mark("t1", "Ana")] });
    expect(screen.getByLabelText("Loading the proofread screen")).toBeTruthy();
    expect(await screen.findByText("1 of 4 checked by someone")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Proofread$/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Back to contract" }).getAttribute("href")).toBe("/studies/s1");
    for (const [name, n] of [["All", 4], ["Needs checking", 3], ["Flagged", 0], ["Checked by me", 0]] as const) expect(screen.getByRole("button", { name: `${name} ${n}` })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Items checked by someone" }).getAttribute("aria-valuenow")).toBe("25");
  });

  it("groups the items under the Overview's headings, all open, with a count each", async () => {
    setup();
    await row("Startup fee");
    for (const [g, n] of [["Budget grids", "1"], ["Holdback and overhead", "1"], ["Site fees", "1"], ["Recurring fees", "1"]]) {
      const section = screen.getByRole("region", { name: g });
      expect(within(section).getByRole("button", { name: new RegExp(`^${g}`) }).getAttribute("aria-expanded")).toBe("true");
      expect(within(section).getByText(n)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /^Budget grid: Visit budget/ })).toBeTruthy();
  });

  it("collapses and re-opens a group", async () => {
    setup();
    await row("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: /^Site fees/ }));
    expect(screen.queryByRole("button", { name: /^Startup fee/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Site fees/ }));
    expect(screen.getByRole("button", { name: /^Startup fee/ })).toBeTruthy();
  });

  it("each row says its status in words, not only in colour", async () => {
    setup({ proofreads: [mark("t1", "Ana")], flags: [{ item: "t3", by: "Ben", note: "Wrong", at }] });
    expect((await row("Startup fee")).textContent).toContain("checked");
    expect(screen.getByRole("button", { name: /^Archive fee.*flagged as looking wrong/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Holdback.*needs a look/ })).toBeTruthy();
  });

  it("filters to what needs checking, what is flagged and what I checked", async () => {
    setActingAs("Ana");
    setup({ proofreads: [mark("t1", "Ana"), mark("t3", "Ben")], flags: [{ item: "t2", by: "Ben", note: "No", at }] });
    await row("Startup fee");
    fireEvent.click(screen.getByRole("button", { name: "Needs checking 2" }));
    expect(screen.queryByRole("button", { name: /^Startup fee/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Holdback(?! and)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Flagged 1" }));
    expect(screen.queryByRole("button", { name: /^Budget grid/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Holdback(?! and)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Checked by me 1" }));
    expect(screen.getByRole("button", { name: /^Startup fee/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Archive fee/ })).toBeNull();
  });

  it("says when the contract has not been read, when the rulebook is empty, and when it can't load", async () => {
    mockApi({ "GET /versions/v1": () => version({ rulebook: null }), "GET /versions/v1/coverage": () => ({ pages: [], totals: { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 } }) });
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByText("Nothing to proofread yet")).toBeTruthy();
    cleanup();
    setup({ edit: (v) => ((v.rulebook!.terms = []), (v.rulebook!.grids = [])) });
    expect(await screen.findByText("No items to proofread")).toBeTruthy();
    cleanup();
    mockApi({});
    renderWithClient(<ProofScreen versionId="v1" />);
    expect(await screen.findByRole("heading", { name: /We can't find the proofread screen/ })).toBeTruthy();
  });
});

describe("opening on an item", () => {
  it("with no link, selects the first item that needs checking and its page, without touching the URL", async () => {
    setup();
    const v = await viewer();
    expect(v.dataset.page).toBe("2");
    expect(screen.getByRole("heading", { name: "Budget grid: Visit budget" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Budget grid: Visit budget/, current: true })).toBeTruthy();
    expect(nav.get()).toBe("");
  });

  it("marking the opening item doesn't make the selection jump", async () => {
    setActingAs("Ana");
    setup();
    await viewer();
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(screen.getByText("1 of 4 checked by someone")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Budget grid: Visit budget" })).toBeTruthy();
  });

  it("a term link: its claim, the quote, and the viewer at the quote on the quote's page", async () => {
    nav.set("ref=term:t1");
    setup();
    expect(await screen.findByRole("heading", { name: "Startup fee" })).toBeTruthy();
    const strip = screen.getByRole("region", { name: "What the rulebook claims" });
    expect(within(strip).getByText("$5,000.00 · invoiced")).toBeTruthy();
    expect(within(strip).getByText("Page 1 · Contract.pdf")).toBeTruthy();
    expect(within(strip).getByText("Startup fee $5,000")).toBeTruthy();
    const v = await viewer();
    await waitFor(() => expect(v.dataset.focus).toBe("0.1,0.5,0.6,0.55"));
    expect(v.dataset.page).toBe("1");
    expect(v.dataset.start).toBe("passage");
    expect(screen.getByRole("button", { name: "The words quoted in the rulebook" }).dataset.tone).toBe("focus");
    expect(screen.getByRole("button", { name: /^\$99\.00/ }).dataset.tone).toBe("problem");
  });

  describe("a mark that could not be pinned to the exact spot", () => {
    const NOTE = "We couldn't pin down the exact spot on this scanned page, so the highlighted area is approximate. What you're looking for is inside it.";

    it("says nothing when every box is exact", async () => {
      nav.set("ref=term:t1");
      setup();
      await viewer();
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(screen.getByRole("button", { name: "The words quoted in the rulebook" })).toBeTruthy();
    });

    it("an approximate search result is labelled as an area and explained", async () => {
      nav.set("ref=term:t1");
      setup({ find: { boxes: [[0.05, 0.3, 0.95, 0.7]], approx: true } });
      expect(await screen.findByText(NOTE)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Approximate area · The words quoted in the rulebook" })).toBeTruthy();
    });

    it("an approximate saved clause is used when the search finds nothing, and explained", async () => {
      nav.set("ref=term:t1");
      setup({ find: { boxes: [] }, coverage: (c) => Object.assign(c.pages[0]!.clauses[0]!, { approx: true }) });
      expect(await screen.findByText(NOTE)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Approximate area · The words quoted in the rulebook" })).toBeTruthy();
    });

    it("an approximate amount says it is somewhere in the area", async () => {
      nav.set("ref=term:t1");
      setup({ coverage: (c) => Object.assign(c.pages[0]!.amounts[0]!, { approx: true }) });
      expect(await screen.findByText(NOTE)).toBeTruthy(); // the line's own amount is drawn as part of the focus
      expect(screen.getByRole("button", { name: /^\$5,000\.00 is somewhere in this area · / })).toBeTruthy();
    });
  });

  it("a grid cell link focuses that cell's amount; Details are closed until asked for", async () => {
    nav.set("ref=grid:g1:0:1");
    setup();
    expect(await screen.findByRole("heading", { name: "Blood draw, Week 4" })).toBeTruthy();
    expect((await viewer()).dataset.focus).toMatch(/^0\.1,0\.4,/);
    expect(screen.getByRole("button", { name: /^Budget grid: Visit budget/, current: true })).toBeTruthy();
    expect((screen.getByText("Details").closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("clips a long quote and shows all of it on request", async () => {
    nav.set("ref=term:t1");
    const long = "Sponsor shall pay the startup fee of five thousand dollars within thirty days of the executed agreement and the receipt of a correct invoice, as set out in the schedule of payments.";
    setup({ edit: (v) => (v.rulebook!.terms[0]!.source.quote = long) });
    const q = await screen.findByText(long);
    expect(q.parentElement!.className).toContain("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "Show full quote" }));
    expect(q.parentElement!.className).not.toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("opens the page a link names with the amount picked, and explains a missing one", async () => {
    nav.set("doc=d1&page=1&box=1");
    setup();
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getAllByText(/Not in the rulebook yet/).length).toBeGreaterThan(0);
    expect((await viewer()).dataset.focus).toMatch(/^0\.1,0\.2,0\.3,0\.24/);
  });

  it("an item the rulebook no longer has says so", async () => {
    nav.set("ref=term:gone");
    setup();
    expect(await screen.findByText(/no longer in the rulebook/)).toBeTruthy();
  });
});

describe("the page and the items select each other", () => {
  it("clicking an amount selects the item it became; one with no item is selected as an amount", async () => {
    nav.set("doc=d1&page=1");
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /^\$99\.00/ }));
    expect(urlParam("box")).toBe("1");
    expect(urlParam("ref")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    fireEvent.click(screen.getByRole("button", { name: /^\$5,000\.00 · captured as Startup fee/ }));
    expect(urlParam("ref")).toBe("term:t1");
    expect(screen.getByRole("button", { name: /^Startup fee/, current: true })).toBeTruthy();
  });

  it("paging in the viewer keeps the item; picking an item goes back to its page", async () => {
    nav.set("ref=term:t1");
    setup();
    await viewer();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(urlParam("page")).toBe("2");
    expect(urlParam("ref")).toBe("term:t1");
    fireEvent.click(await row("Archive fee"));
    expect(urlParam("page")).toBeNull();
    expect(urlParam("ref")).toBe("term:t3");
  });

  it("draws problems only until every amount is asked for", async () => {
    nav.set("doc=d1&page=2");
    setup();
    await screen.findByRole("button", { name: /^\$31\.00/ });
    expect(screen.queryByRole("button", { name: /^\$25\.00/ })).toBeNull();
    expect(screen.getByText("1 amount needs a look")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show every amount" }));
    expect(screen.getByRole("button", { name: /^\$25\.00 · captured/ }).dataset.tone).toBe("captured");
    expect(screen.getByRole("button", { name: /^\$1,000\.00 · set aside/ }).dataset.tone).toBe("set_aside");
  });

  it("Next missing amount jumps to the missing amount", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Next missing amount (1)" }));
    expect(urlParam("box")).toBe("1");
    expect(urlParam("page")).toBe("1");
  });
});

describe("marks and flags in the claim strip", () => {
  it("says who proofread it and shows a flag with its person and note", async () => {
    nav.set("ref=term:t1");
    setup({ proofreads: [mark("t1", "Ana")], flags: [{ item: "t1", by: "Ben", note: "Quote is for another fee", at }] });
    const strip = await screen.findByRole("region", { name: "What the rulebook claims" });
    expect(within(strip).getByText("Proofread by Ana")).toBeTruthy();
    expect(within(strip).getByText(/Ben says something looks wrong/)).toBeTruthy();
    expect(within(strip).getByText("Quote is for another fee")).toBeTruthy();
  });

  it("marks the item as me with the button and the progress moves", async () => {
    setActingAs("Ana");
    nav.set("ref=term:t1");
    const fetch = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(screen.getByText("1 of 4 checked by someone")).toBeTruthy());
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["t1"] });
  });

  it("shows a plain-English error when the mark didn't go through", async () => {
    setActingAs("Ana");
    nav.set("ref=term:t1");
    mockApi({
      "GET /versions/v1": () => sampleVersion(),
      "GET /versions/v1/coverage": () => coverageData(),
      "GET /documents/d1/pages/1/find": () => find,
      "POST /versions/v1/proofread": () => new Response(JSON.stringify({ message: "This version has been replaced by a newer live one, so it can't be proofread." }), { status: 409 }),
    });
    renderWithClient(<ProofScreen versionId="v1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Matches the contract" }));
    expect((await screen.findByText(/replaced by a newer live one/)).getAttribute("role")).toBe("alert");
  });
});

describe("one-key review", () => {
  it("Space marks the item and moves to the next one nobody has checked, and says so", async () => {
    setActingAs("Ana");
    const fetch = setup({ proofreads: [mark("t2", "Ben")] });
    await press(" ");
    await waitFor(() => expect(urlParam("ref")).toBe("term:t1"));
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["grid:g1:0:0", "grid:g1:0:1"] });
    expect(screen.getByText("Checked. Next: Startup fee")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Startup fee" })).toBeTruthy();
  });

  it("Enter does the same, and Space on an item I already checked just moves on", async () => {
    setActingAs("Ana");
    nav.set("ref=term:t1");
    const fetch = setup({ proofreads: [mark("t1", "Ana")] });
    await press("Enter");
    await waitFor(() => expect(urlParam("ref")).toBe("term:t3"));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("asks for a name instead of sending when nobody has chosen one", async () => {
    const fetch = setup();
    await press(" ");
    await new Promise((r) => setTimeout(r, 20));
    expect(posts(fetch)).toHaveLength(0);
    expect(nav.get()).toBe("");
  });

  it("after the last item: everything is checked, with ways on", async () => {
    setActingAs("Ana");
    nav.set("ref=term:t3");
    setup({ proofreads: [mark("t1", "A"), mark("t2", "A"), mark("grid:g1:0:0", "A"), mark("grid:g1:0:1", "A")] });
    await press(" ");
    expect(await screen.findByRole("heading", { name: "Everything is checked" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the contract" }).getAttribute("href")).toBe("/studies/s1");
    expect(screen.getByRole("link", { name: "Go to Approve" }).getAttribute("href")).toBe("/versions/v1/approve");
    expect(screen.getByText("Checked. Everything is checked.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep looking" }));
    expect(screen.getByRole("heading", { name: "Archive fee" })).toBeTruthy();
  });

  it("J and the down arrow go to the next item, K and the up arrow to the previous", async () => {
    setup();
    await press("j");
    expect(urlParam("ref")).toBe("term:t2");
    // the arrows move the items from the list; in the page area they pan the page
    fireEvent.keyDown(screen.getByRole("button", { name: /^Holdback(?! and)/ }), { key: "ArrowDown" });
    expect(urlParam("ref")).toBe("term:t1");
    await press("k");
    expect(urlParam("ref")).toBe("term:t2");
    fireEvent.keyDown(screen.getByRole("button", { name: /^Holdback(?! and)/ }), { key: "ArrowUp" });
    expect(urlParam("ref")).toBe("grid:g1:-1:0");
  });

  it("the arrows are left to the page when the page area has focus", async () => {
    setup();
    const v = await viewer();
    fireEvent.keyDown(v, { key: "ArrowDown" });
    expect(nav.get()).toBe("");
    fireEvent.keyDown(v, { key: "j" });
    expect(urlParam("ref")).toBe("term:t2");
  });

  it("F opens the note and focuses it; Esc closes it; typing in it is left alone", async () => {
    setActingAs("Ana");
    nav.set("ref=term:t1");
    const fetch = setup();
    await press("f");
    const box = (await screen.findByLabelText("What looks wrong?")) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyDown(box, { key: "j" });
    expect(posts(fetch)).toHaveLength(0);
    expect(urlParam("ref")).toBe("term:t1");
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("What looks wrong?")).toBeNull());
  });

  it("ignores keys with a modifier, and a press on a button keeps its own meaning", async () => {
    setActingAs("Ana");
    const fetch = setup();
    fireEvent.keyDown(await viewer(), { key: "j", metaKey: true });
    expect(nav.get()).toBe("");
    fireEvent.keyDown(screen.getByRole("button", { name: "Show every amount" }), { key: " " });
    expect(posts(fetch)).toHaveLength(0);
  });

  it("? shows the shortcuts and ? or Esc hides them", async () => {
    setup();
    await press("?");
    expect(screen.getByRole("region", { name: "Keyboard shortcuts help" })).toBeTruthy();
    await press("Escape");
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts help" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("region", { name: "Keyboard shortcuts help" })).toBeTruthy();
  });

  it("the rail ends with the keys as hints", async () => {
    setup();
    await viewer();
    const hints = screen.getByRole("group", { name: "Keyboard shortcuts" });
    expect(within(hints).getByText("Space")).toBeTruthy();
    expect(within(hints).getByText("something looks wrong")).toBeTruthy();
  });
});

describe("narrow windows", () => {
  it("under 1100 px the rail is an Items button that opens a sheet, and picking an item closes it", async () => {
    window.innerWidth = 900;
    // jsdom has no modal <dialog>
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    setup();
    await viewer();
    expect(screen.queryByRole("complementary", { name: "Items to proofread" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Items" }));
    const sheet = await screen.findByRole("dialog", { name: "Items to proofread" });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Archive fee/ }));
    expect(urlParam("ref")).toBe("term:t3");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Items to proofread" })).toBeNull());
  });

  it("with a wide window the rail is beside the page, and resizing swaps it", async () => {
    setup();
    await viewer();
    expect(screen.getByRole("complementary", { name: "Items to proofread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Items" })).toBeNull();
    await resize(800);
    expect(screen.getByRole("button", { name: "Items" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Items to proofread" })).toBeNull();
  });
});
