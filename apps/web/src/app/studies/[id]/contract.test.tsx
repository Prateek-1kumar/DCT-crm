import { askAbout, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { rulebook, study, version } from "@/test/fixtures";
import ContractPage from "./page";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "st-1" }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const AT = "2026-10-02T10:00:00.000Z";
const live = () => version(rulebook(), { status: "signed", signedBy: "Morgan Lee", signedAt: AT });
/** "This looks wrong" on the live version's net days, as the API leaves it: a correction draft asking about it. */
const corrected = () => {
  const rb = rulebook();
  return version(rb, { version: 2, review: [askAbout(rb, [], "/payment/netDays/value", "reported:1", "reported")] });
};
/** The live contract, and `draft` (its newest version) if there is one. */
function renderPage(search = "", draft?: RulebookVersionDto) {
  nav.search = search;
  const versions = [live(), ...(draft ? [draft] : [])];
  const detail: StudyDetailDto = study({
    status: draft ? "amendment_in_review" : "live", liveVersion: 1, needsYou: draft?.review.length ?? 0,
    versions: versions.map(({ version: v, status, createdAt, signedBy, signedAt, appliesFrom }) => ({ version: v, status, createdAt, signedBy, signedAt, appliesFrom })),
  });
  vi.spyOn(api, "getStudy").mockResolvedValue(detail);
  vi.spyOn(api, "getVersion").mockImplementation(async (_, v) => versions.find((x) => x.version === v)!);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ContractPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the contract page", () => {
  it("marks, on the live version, a value the correction draft is re-checking blind, with the way to its question", async () => {
    const reported = corrected();
    const item = reported.review[0]!;
    renderPage("corrected=2", reported);

    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/^Being re-checked in version 2:/);
    expect(note.textContent).toContain("Version 1 stays live until version 2 is approved.");
    const href = `/studies/st-1/review?v=2&item=${encodeURIComponent(item.id)}`;
    expect(within(note).getByRole("link", { name: "Payment · Net days" }).getAttribute("href")).toBe(href);

    // The Payment key term still shows the live value billing works from, and says it's being re-checked.
    const term = screen.getByText("Payment", { selector: "span" }).closest("li")!;
    expect(term.textContent).toContain("45 days");
    expect(within(term).getByRole("link", { name: "Being re-checked in version 2" }).getAttribute("href")).toBe(href);
    // Version 2 is the draft the report opened, so its thanks shows.
    expect(screen.getByText(/^Thanks\. Version 2 is open to correct it/)).toBeTruthy();
  });

  it("thanks for a correction only for the study's current draft, whatever the address says", async () => {
    renderPage("corrected=7", corrected());
    await screen.findByText("Payment", { selector: "span" });
    expect(screen.queryByText(/^Thanks\. Version/)).toBeNull();
  });

  it("marks nothing when no draft is re-checking anything, and never claims an approval from the address", async () => {
    renderPage("approved=2&corrected=2");
    await screen.findByText("Payment", { selector: "span" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/Being re-checked/)).toBeNull();
    expect(screen.queryByText(/Approved\. Version 2/)).toBeNull();
    expect(screen.queryByText(/^Thanks\. Version/)).toBeNull(); // no draft at all
  });
});
