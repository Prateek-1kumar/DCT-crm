import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs, usePersonPrompt } from "@/lib/acting-as";
import type { Version } from "@/lib/types";
import { ApprovePanel } from "./ApprovePanel";
import { mockApi, posts, question, renderWithClient, rulebook, term, version } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => setActingAs("Bea"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const terms = [
  term("pay", { category: "payment_terms", name: "Payment terms", formula: "Net 45 days" }),
  term("hold", { category: "holdback", name: "Holdback", formula: "10% held back" }),
  term("rest", { category: "recurring_fee", name: "Monthly storage", amountCents: 5000, unit: "per month" }),
];
const clean = (over: Partial<Version> = {}) => version({ rulebook: rulebook({ terms }), ...over });

function open(v: Version, after?: Version) {
  let current = v;
  const fetch = mockApi({
    "GET /versions/v1": () => current,
    "GET /studies/s1": () => ({ id: "s1", versions: [{ id: "v1", number: 3 }, { id: "v9", number: 4 }] }),
    ...(after && { "POST /versions/v1/approve": () => (current = after) }),
  });
  renderWithClient(<ApprovePanel versionId="v1" />);
  return fetch;
}

const approveButton = () => screen.getByRole("button", { name: /^(Approve|Waiting)/ }) as HTMLButtonElement;
const tickAll = () => screen.getAllByRole("checkbox").forEach((c) => fireEvent.click(c));

describe("ApprovePanel: ready to approve", () => {
  it("shows the three sections, each key term with its value, quote and a link into the contract", async () => {
    open(clean());
    expect(await screen.findByRole("heading", { name: "Needs your decision" })).toBeTruthy();
    expect(screen.getByText("Nothing waiting")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Key terms to tick" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Payment terms" })).toBeTruthy();
    expect(screen.getByText("Net 45 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Where this came from: Payment terms" }).getAttribute("href")).toBe("/versions/v1/proof?tab=contract&ref=term:pay");
    expect(screen.getByRole("heading", { name: "Everything else, proven" })).toBeTruthy();
  });

  it("needs every key term ticked, says how many are left, then approves with the ticked ids and the person's name", async () => {
    const live = clean({ status: "approved", approvedBy: "Bea", approvedAt: "2026-11-07T10:00:00Z" });
    const fetch = open(clean(), live);
    await screen.findByRole("checkbox", { name: "Payment terms" });
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText("3 left to tick")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Payment terms" }));
    expect(screen.getByText("2 left to tick")).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Holdback" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Monthly storage" }));
    expect(screen.getByText("All ticked")).toBeTruthy();
    expect(approveButton().disabled).toBe(false);
    fireEvent.click(approveButton());
    expect(await screen.findByRole("heading", { name: "This rulebook is live" })).toBeTruthy();
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Bea", ticked: ["pay", "hold", "rest"] });
    expect(screen.getByText(/Approved by Bea on/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the contract workspace" }).getAttribute("href")).toBe("/studies/s1");
    expect(screen.getByRole("link", { name: "See the summary" }).getAttribute("href")).toBe("/versions/v1");
  });

  it("asks who is approving when no name is chosen, and sends nothing", async () => {
    setActingAs(null);
    const fetch = open(clean());
    await screen.findByRole("checkbox", { name: "Payment terms" });
    tickAll();
    const seen: boolean[] = [];
    const Probe = () => (seen.push(usePersonPrompt()), null);
    renderWithClient(<Probe />);
    fireEvent.click(approveButton());
    await waitFor(() => expect(seen.at(-1)).toBe(true));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("shows each key term's proofreaders", async () => {
    open(clean({ proofreads: [{ item: "pay", by: "Cy", at: "2026-11-06T10:00:00Z" }] }));
    await screen.findByRole("checkbox", { name: "Payment terms" });
    expect(screen.getByText("Proofread by Cy")).toBeTruthy();
  });

  it("searches the rest of the rulebook and leaves out what is already on the tick list", async () => {
    const many = Array.from({ length: 10 }, (_, i) => term(`m${i}`, { category: "recurring_fee", name: `Fee ${i}`, amountCents: 100 * (i + 1), evidence: "quote" }));
    open(version({ rulebook: rulebook({ terms: [...terms, ...many] }) }));
    const section = (await screen.findByRole("heading", { name: "Everything else, proven" })).closest("section")!;
    const ticks = screen.getAllByRole("checkbox").length;
    expect(ticks).toBe(8);
    expect(within(section).getByText("Recurring fees")).toBeTruthy();
    fireEvent.change(within(section).getByRole("searchbox"), { target: { value: "zzz" } });
    expect(within(section).getByText(/Nothing matches/)).toBeTruthy();
  });
});

describe("ApprovePanel: blocked", () => {
  it("lists open decisions and failing checks, links to the decisions and keeps Approve off", async () => {
    open(
      clean({
        rulebook: rulebook({ terms, questions: [question("a"), question("b", { blocking: false })] }),
        problems: [{ check: "grid", message: "A grid total is off by $10." }],
      }),
    );
    expect(await screen.findByText("2 items waiting")).toBeTruthy();
    expect(screen.getByText("Question text a")).toBeTruthy();
    expect(screen.queryByText("Question text b")).toBeNull();
    expect(screen.getByText("A grid total is off by $10.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the decisions" }).getAttribute("href")).toBe("/versions/v1/questions");
    tickAll();
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText("Sort out the decisions above first.")).toBeTruthy();
  });
});

describe("ApprovePanel: maker-checker", () => {
  const answered = clean({ answers: [{ questionId: "q", option: 0, by: "bea", at: "2026-11-06T10:00:00Z" }] });

  it("reads Waiting for a colleague, disabled, and names who answered, ignoring case", async () => {
    open(answered);
    await screen.findByRole("checkbox", { name: "Payment terms" });
    tickAll();
    expect(approveButton().textContent).toBe("Waiting for a colleague");
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText(/bea answered this version's decisions, so someone else has to approve it/)).toBeTruthy();
  });

  it("lets someone else approve, and says who answered", async () => {
    setActingAs("Ben");
    open(answered);
    await screen.findByRole("checkbox", { name: "Payment terms" });
    tickAll();
    expect(approveButton().textContent).toBe("Approve this rulebook");
    expect(approveButton().disabled).toBe(false);
    expect(screen.getByText(/bea answered the decisions/)).toBeTruthy();
  });
});

describe("ApprovePanel: not a draft", () => {
  it("says a live rulebook is live, with who approved it", async () => {
    open(clean({ status: "approved", approvedBy: "Ben", approvedAt: "2026-11-05T09:00:00Z" }));
    expect(await screen.findByRole("heading", { name: "This rulebook is live" })).toBeTruthy();
    expect(screen.getByText(/Approved by Ben on/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says a superseded version was replaced and links to the newer one", async () => {
    open(clean({ status: "superseded" }));
    expect(await screen.findByText("A newer version replaced this one")).toBeTruthy();
    expect((await screen.findByRole("link", { name: "Go to version 4" })).getAttribute("href")).toBe("/versions/v9/approve");
  });

  it("says a plain-English reason when the version can't load", async () => {
    mockApi({ "GET /versions/v1": () => new Response(JSON.stringify({ message: "nope" }), { status: 404 }) });
    renderWithClient(<ApprovePanel versionId="v1" />);
    expect(await screen.findByText("We can't find this version")).toBeTruthy();
  });
});
