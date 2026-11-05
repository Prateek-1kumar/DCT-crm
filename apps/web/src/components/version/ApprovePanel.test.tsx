import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
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

const clean = (over: Partial<Version> = {}) =>
  version({
    rulebook: rulebook({
      terms: [term("pay", { category: "payment_terms", name: "Payment terms", formula: "Net 45 days" }), term("hold", { category: "holdback", name: "Holdback", formula: "10% held back" })],
    }),
    ...over,
  });

const totals = { amounts: 142, captured: 137, decided: 2, setAside: 3, missing: 0 };

function open(v: Version, extra: Parameters<typeof mockApi>[0] = {}, after?: Version) {
  let current = v;
  const fetch = mockApi({ "GET /versions/v1": () => current, ...(after && { "POST /versions/v1/approve": () => (current = after) }), "GET /versions/v1/coverage": () => ({ pages: [], totals }), ...extra });
  renderWithClient(<ApprovePanel versionId="v1" />);
  return fetch;
}

const approveButton = () => screen.getByRole("button", { name: "Approve this rulebook" }) as HTMLButtonElement;
const tickAll = () => screen.getAllByRole("checkbox").forEach((c) => fireEvent.click(c));

describe("ApprovePanel", () => {
  it("lists the coverage, with a link to the proof, and each key term with a link into the contract", async () => {
    open(clean());
    expect(await screen.findByText(/142 amounts in the contract: 139 captured, 3 set aside, 0 missing/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the proof" }).getAttribute("href")).toBe("/versions/v1/proof");
    expect(screen.getByText("Net 45 days")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Show in contract" })[0]!.getAttribute("href")).toBe("/versions/v1/proof?doc=d1&page=2");
  });

  it("stays disabled until every key term is ticked, then approves with the ticked ids", async () => {
    const fetch = open(clean(), {}, clean({ status: "approved", approvedBy: "Bea" }));
    await screen.findByText("Payment terms");
    expect(approveButton().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(approveButton().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(approveButton().disabled).toBe(false);
    fireEvent.click(approveButton());
    expect(await screen.findByText("This rulebook is live")).toBeTruthy();
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Bea", ticked: ["pay", "hold"] });
    expect(screen.getByRole("link", { name: "Go to the summary" }).getAttribute("href")).toBe("/versions/v1");
  });

  it("stays disabled while a must-answer question is open, and links to it; worth-a-look ones don't block", async () => {
    open(clean({ rulebook: { ...clean().rulebook!, questions: [question("a"), question("b", { blocking: false })] } }));
    await screen.findByText("Payment terms");
    tickAll();
    expect(screen.getByText("1 question still to answer")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Answer them first" }).getAttribute("href")).toBe("/versions/v1/questions");
    expect(screen.getByText(/1 other question worth a look/)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
  });

  it("lets worth-a-look questions stay open", async () => {
    open(clean({ rulebook: { ...clean().rulebook!, questions: [question("b", { blocking: false })] } }));
    await screen.findByText("Payment terms");
    tickAll();
    expect(approveButton().disabled).toBe(false);
  });

  it("stays disabled while the checks find a problem, which it states in words", async () => {
    open(clean({ problems: [{ check: "grid_sum", message: "The Visit 3 total doesn't add up." }] }));
    await screen.findByText("Payment terms");
    tickAll();
    expect(screen.getByText("The Visit 3 total doesn't add up.")).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
  });

  it("stays disabled without a name, and offers to set one", async () => {
    setActingAs(null);
    open(clean());
    await screen.findByText("Payment terms");
    tickAll();
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Choose your name" })).toBeTruthy();
  });

  it("explains the maker-checker refusal and who answered", async () => {
    open(clean({ answers: [{ questionId: "a", option: 0, by: "Bea", at: "2026-11-02T09:00:00Z" }, { questionId: "b", option: 1, by: "Cy", at: "2026-11-02T09:05:00Z" }] }), {
      "POST /versions/v1/approve": () => new Response(JSON.stringify({ message: "Someone who answered this version's questions can't also approve it: ask a colleague." }), { status: 409 }),
    });
    await screen.findByText("Payment terms");
    tickAll();
    fireEvent.click(approveButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Someone who answered this version's questions can't also approve it."));
    expect(screen.getByRole("alert").textContent).toContain("Answered by Bea, Cy.");
  });

  it("shows a live version as live and a replaced one as not approvable", async () => {
    open(clean({ status: "approved", approvedBy: "Dee", approvedAt: "2026-11-03T10:00:00Z" }));
    expect(await screen.findByText("This rulebook is live")).toBeTruthy();
    expect(screen.getByText(/Approved by Dee on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve this rulebook" })).toBeNull();
    cleanup();
    open(clean({ status: "superseded" }));
    expect(await screen.findByText("A newer version replaced this one, so it can't be approved.")).toBeTruthy();
  });
});
