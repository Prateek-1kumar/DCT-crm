import type { RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { mockRequest, mockReset } from "@/lib/mock/server";
import ContractPage from "./page";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "st-meridian" }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const get = async <T,>(path: string) => (await mockRequest("GET", path, undefined)).json as T;
function renderPage(search = "") {
  nav.search = search;
  vi.spyOn(api, "getStudy").mockImplementation((id) => get<StudyDetailDto>(`/studies/${id}`));
  vi.spyOn(api, "getVersion").mockImplementation((id, v) => get<RulebookVersionDto>(`/studies/${id}/versions/${v}`));
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ContractPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the contract page", () => {
  it("marks, on the live version, a value the correction draft is re-checking blind, with the way to its question", async () => {
    const reported = (await mockRequest("POST", "/studies/st-meridian/versions/1/report", { path: "/payment/netDays/value", note: "Looks wrong", by: "Ben Okafor" }, "k-1")).json as RulebookVersionDto;
    expect(reported.version).toBe(2);
    const item = reported.review.find((i) => i.path === "/payment/netDays/value")!;
    const live = await get<RulebookVersionDto>("/studies/st-meridian/versions/1");
    renderPage("corrected=2");

    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(/^Being re-checked in version 2:/);
    expect(note.textContent).toContain("Version 1 stays live until version 2 is approved.");
    const href = `/studies/st-meridian/review?v=2&item=${encodeURIComponent(item.id)}`;
    expect(within(note).getByRole("link", { name: "Payment · Net days" }).getAttribute("href")).toBe(href);

    // The Payment key term still shows the live value billing works from, and says it's being re-checked.
    const term = screen.getByText("Payment", { selector: "span" }).closest("li")!;
    expect(term.textContent).toContain(`${live.rulebook!.payment.netDays.value} days`);
    expect(within(term).getByRole("link", { name: "Being re-checked in version 2" }).getAttribute("href")).toBe(href);
    // Version 2 is the draft the report opened, so its thanks shows.
    expect(screen.getByText(/^Thanks\. Version 2 is open to correct it/)).toBeTruthy();
  });

  it("thanks for a correction only for the study's current draft, whatever the address says", async () => {
    await mockRequest("POST", "/studies/st-meridian/versions/1/report", { path: "/payment/netDays/value", note: "Looks wrong", by: "Ben Okafor" }, "k-2");
    renderPage("corrected=7");
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
