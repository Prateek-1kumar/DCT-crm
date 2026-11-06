import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { Rulebook, Term } from "@dct/shared";
import { Suspense, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/rulebook/Dashboard";
import type { Version } from "@/lib/types";
import SummaryPage from "./page";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

const term = (over: Partial<Term>): Term => ({
  id: "t",
  category: "other",
  name: "Item",
  amountCents: null,
  unit: null,
  billing: "auto_paid",
  trigger: null,
  cap: null,
  formula: null,
  conditions: null,
  holdbackApplies: "n/a",
  overheadApplies: "n/a",
  deadline: null,
  source: { doc: "CTA.pdf", page: 1, quote: "" },
  evidence: "quote",
  houseRuleIds: [],
  notes: null,
  ...over,
});

const study: Rulebook["study"] = {
  protocol: "NWP-418",
  sponsor: "Northwind",
  payer: null,
  siteEntity: "Site",
  siteNumber: null,
  pi: null,
  effectiveDate: null,
  documents: [
    { doc: "CTA.pdf", role: "cta", hasMoney: true, supersedes: [], effectiveFrom: "2024-01-05", retroactive: false, notes: null },
    { doc: "Amendment 2.pdf", role: "amendment", hasMoney: true, supersedes: [], effectiveFrom: "2025-03-01", retroactive: false, notes: null },
  ],
};

const full: Rulebook = {
  study,
  terms: [
    term({ id: "pay", category: "payment_terms", name: "Payment terms", conditions: "Net 45 days from a valid invoice" }),
    term({ id: "hb", category: "holdback", name: "Holdback", conditions: "10% held until closeout" }),
    term({ id: "sf", category: "screen_failure", name: "Screen failure", amountCents: 30000, unit: "per patient", billing: "invoice", conditions: "After consent is signed" }),
    term({ id: "dl", category: "invoicing", name: "Invoice deadline", deadline: "Within 30 days of the visit" }),
    term({ id: "small", category: "site_fee", name: "Pharmacy setup", amountCents: 50000, unit: "one time" }),
    term({ id: "big", category: "site_fee", name: "Startup fee", amountCents: 500000, unit: "one time", billing: "invoice", trigger: "when the site is activated", conditions: "Once the contract is signed" }),
    term({ id: "rec", category: "recurring_fee", name: "Storage fee", amountCents: 10000, unit: "per month" }),
    term({ id: "tr", category: "stipend_travel", name: "Patient travel", amountCents: 7500, unit: "per visit", billing: "invoice", deadline: "60 days" }),
    term({ id: "unk", category: "bonus", name: "Enrolment bonus", amountCents: 100000, billing: "unknown" }),
  ],
  grids: [
    {
      id: "g1",
      name: "Budget",
      arm: "Arm A",
      doc: "Budget.pdf",
      pages: [1],
      visits: ["V1", "V2"],
      overheadPct: 25,
      rows: [{ name: "ECG", code: null, unitCostCents: 4000, cells: [4000, "Invoice"], printedRowTotalCents: 4000 }],
      subtotal: [4000, 0],
      overhead: [1000, 0],
      additions: [],
      total: [5000, 0],
      grandTotalCents: 5000,
      cellsReadTwice: [], acceptedAsPrinted: false,
    },
  ],
  accounted: [],
  questions: [],
};

const version = (over: Partial<Version> = {}, rulebook: Rulebook | null = full): Version => ({
  id: "v1",
  studyId: "s1",
  number: 1,
  status: "draft",
  documentIds: [],
  documents: [],
  rulebook,
  problems: [],
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "Avery",
  approvedAt: null,
  approvedBy: null,
  answers: [],
  read: null,
  ...over,
});

const question = (id: string, over: Partial<Rulebook["questions"][number]> = {}): Rulebook["questions"][number] => ({
  id,
  kind: "decision",
  origin: "rule",
  about: null,
  question: "Q?",
  context: "",
  source: { doc: "CTA.pdf", page: 1, quote: "" },
  options: [],
  suggestion: null,
  state: "open",
  blocking: true,
  readings: [],
  resolution: null,
  ...over,
});

afterEach(cleanup);

const section = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section")!;

describe("Dashboard sections", () => {
  it("shows the key rules with links to where each came from", () => {
    render(<Dashboard version={version()} />);
    const rules = section("Key rules");
    expect(within(rules).getByText("Net 45 days from a valid invoice")).toBeTruthy();
    expect(within(rules).getByText("10% held until closeout")).toBeTruthy();
    expect(within(rules).getByText("25% overhead, included in the visit totals")).toBeTruthy();
    expect(within(rules).getByText("Within 30 days of the visit")).toBeTruthy();
    expect(within(rules).getByText("$300.00 per patient")).toBeTruthy();
    expect(within(rules).getByText("Amendment 2.pdf")).toBeTruthy();
    expect(within(rules).getByText("From March 1, 2025")).toBeTruthy();
    expect(within(rules).getByRole("link", { name: "See where this came from: Net 45 days from a valid invoice" }).getAttribute("href")).toBe("/versions/v1/proof?tab=rulebook&ref=term:pay");
  });

  it("lists one-time fees biggest first and recurring fees on their own", () => {
    render(<Dashboard version={version()} />);
    const fees = within(section("One-time fees")).getAllByRole("heading", { level: 3 });
    expect(fees.map((h) => h.textContent)).toEqual(["Startup fee", "Pharmacy setup"]);
    const startup = within(section("One-time fees")).getAllByRole("listitem")[0]!;
    expect(within(startup).getByText("$5,000.00 one time")).toBeTruthy();
    expect(within(startup).getByText("When the site is activated")).toBeTruthy();
    expect(within(startup).getByText("You invoice for it")).toBeTruthy();
    expect(within(startup).getByText("Once the contract is signed")).toBeTruthy();
    expect(within(section("Recurring fees")).getByText("$100.00 per month")).toBeTruthy();
  });

  it("shows each visit grid with its one-line summary", () => {
    render(<Dashboard version={version()} />);
    const schedule = section("Visit schedule");
    expect(within(schedule).getByRole("heading", { level: 3, name: "Arm A" })).toBeTruthy();
    expect(within(schedule).getByText("2 visits · $50.00 per patient · 25% overhead included")).toBeTruthy();
    expect(within(schedule).getByRole("table", { name: "Budget" })).toBeTruthy();
  });

  it("groups what the site must invoice and flags unsettled billing", () => {
    render(<Dashboard version={version()} />);
    const checklist = section("What you need to invoice");
    const groups = within(checklist).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(["Screen failures", "Stipends, travel and bonuses", "Other items you invoice", "Billed from the visit schedule"]);
    expect(within(checklist).getByText("Deadline: 60 days")).toBeTruthy();
    expect(within(checklist).getByText("Invoice at V2")).toBeTruthy();
    expect(within(checklist).getByText("$40.00")).toBeTruthy();
    expect(within(checklist).getByText("How this is paid isn't settled yet")).toBeTruthy();
    expect(within(checklist).queryByText("Pharmacy setup")).toBeNull();
  });

  it("leaves out sections with nothing in them", () => {
    render(<Dashboard version={version({}, { study: { ...study, documents: [] }, terms: [term({ id: "x", category: "recurring_fee", name: "Storage fee", amountCents: 100 })], grids: [], accounted: [], questions: [] })} />);
    expect(screen.queryByRole("heading", { name: "Key rules" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "One-time fees" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Visit schedule" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What you need to invoice" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Recurring fees" })).toBeTruthy();
  });

  it("says so when there is no rulebook yet", () => {
    render(<Dashboard version={version({ status: "reading" }, null)} />);
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
  });
});

describe("Dashboard banner", () => {
  it("tells a draft how many blocking questions still need an answer", () => {
    const questions = [question("a"), question("b"), question("c", { state: "answered" }), question("d", { blocking: false })];
    render(<Dashboard version={version({}, { ...full, questions })} />);
    expect(screen.getByText("Draft: not live yet. 2 questions still need an answer.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Answer them" }).getAttribute("href")).toBe("/versions/v1/questions");
  });

  it("uses the singular for one question, and points to approval when none are left", () => {
    const { unmount } = render(<Dashboard version={version({}, { ...full, questions: [question("a")] })} />);
    expect(screen.getByText("Draft: not live yet. 1 question still needs an answer.")).toBeTruthy();
    unmount();
    render(<Dashboard version={version()} />);
    expect(screen.getByRole("link", { name: "Review and approve" }).getAttribute("href")).toBe("/versions/v1/approve");
  });

  it("says when a live version went live and who approved it", () => {
    render(<Dashboard version={version({ status: "approved", approvedAt: "2026-03-14T12:00:00Z", approvedBy: "Jordan Lee" })} />);
    expect(screen.getByText("Live since March 14, 2026, approved by Jordan Lee")).toBeTruthy();
    expect(screen.queryByText(/not live yet/)).toBeNull();
  });
});

describe("Summary page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the version and shows its dashboard", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(version()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Suspense>
            <SummaryPage params={Promise.resolve({ id: "v1" })} />
          </Suspense>
        </QueryClientProvider>,
      );
    });
    expect(await screen.findByRole("heading", { name: "One-time fees" })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/v1/versions/v1", expect.anything());
  });
});
