import type { RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { mockSampling } from "@/lib/mock/fixtures";
import { mockRequest, mockReset } from "@/lib/mock/server";
import ReviewPage from "./page";

const nav = vi.hoisted(() => ({ id: "st-halcyon", search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: nav.id }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const get = async <T,>(path: string) => (await mockRequest("GET", path, undefined)).json as T;
const START = "interpret:/appliesFrom/value";

/** The review page on one question, answering through the sample server; returns what each answer sent. */
function renderPage(id: string, item: string) {
  Object.assign(nav, { id, search: `item=${encodeURIComponent(item)}` });
  vi.spyOn(api, "getStudy").mockImplementation((s) => get<StudyDetailDto>(`/studies/${s}`));
  vi.spyOn(api, "getVersion").mockImplementation((s, v) => get<RulebookVersionDto>(`/studies/${s}/versions/${v}`));
  vi.spyOn(api, "pageSrc").mockResolvedValue("data:image/svg+xml,");
  const sent = vi.spyOn(api, "answerReview").mockImplementation(async (s, v, i, body) => (await mockRequest("POST", `/studies/${s}/versions/${v}/review/${encodeURIComponent(i)}`, body)).json as RulebookVersionDto);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewPage />
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => {
  mockSampling.random = () => 1 - 2 ** -32; // the sample pinned, as in server.test.ts
  mockReset();
  localStorage.setItem("dct.actingAs", "Taylor Brooks");
  // jsdom has no <dialog> methods and no layout (as SpotView.test.tsx)
  Object.assign(HTMLDialogElement.prototype, { showModal() {}, close() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("answering on the review page", () => {
  it("an amendment's start date: real radios, nothing picked; 'prospective only' sends the pick with the amendment's date typed, a date the typed value", async () => {
    await mockRequest("POST", "/studies/st-halcyon/versions/2/send-back", { itemIds: [START], note: "Check §1", by: "Morgan Lee" });
    let sent = renderPage("st-halcyon", START);
    // the read's date of the amendment isn't shown: it's typed, blind
    const prospective = await screen.findByRole("radio", { name: /^Prospective only: from the amendment.s own date$/ }, { timeout: 10_000 });
    const typed = screen.getByRole("radio", { name: "From a date the contract gives" });
    expect([prospective, typed].map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    fireEvent.click(typed);
    // the date it was answered with when seeded, typed again
    fireEvent.change(screen.getByLabelText("What the contract says"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-halcyon", 2, START, expect.objectContaining({ value: "2026-09-01" })));
    expect(sent.mock.calls[0]![3]).not.toHaveProperty("optionId");
    const start = async () => (await get<RulebookVersionDto>("/studies/st-halcyon/versions/2")).review.find((i) => i.id === START)!;
    await waitFor(async () => expect((await start()).outcome).toBe("matched"), { timeout: 10_000 }); // taken before it's sent back again

    cleanup();
    await mockRequest("POST", "/studies/st-halcyon/versions/2/send-back", { itemIds: [START], note: "Again", by: "Morgan Lee" });
    sent = renderPage("st-halcyon", START);
    fireEvent.click(await screen.findByRole("radio", { name: /^Prospective only/ }, { timeout: 10_000 }));
    fireEvent.change(screen.getByLabelText("The amendment's own date, as printed on it"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-halcyon", 2, START, expect.objectContaining({ optionId: "prospective", value: "2026-09-30" })));
    await waitFor(async () => expect((await get<RulebookVersionDto>("/studies/st-halcyon/versions/2")).rulebook!.appliesFrom.value).toBe("2026-09-30"), { timeout: 10_000 });
  }, 60_000); // many requests, each with the sample server's network delay

  it("an interpretation picked other than the read: both shown, and keeping the reading sends its option with a note", async () => {
    const id = "interpret:/payment/visitPayment/value";
    const sent = renderPage("st-northwind", id);
    fireEvent.click(await screen.findByRole("radio", { name: "By invoice" }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    const alert = await screen.findByRole("alert", {}, { timeout: 10_000 });
    expect(alert.textContent).toMatch(/^Look at the close-up again\. What you picked is different from what we read\. A choice like this isn't in the PDF's text/);
    fireEvent.click(screen.getByRole("radio", { name: /We read.*Automatic \(from EDC\)/ }));
    fireEvent.change(screen.getByLabelText("Where on the page is it printed?"), { target: { value: "§4.1, first line" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenLastCalledWith("st-northwind", 1, id, expect.objectContaining({ optionId: "auto_edc", note: "§4.1, first line" })), { timeout: 10_000 });
  }, 60_000);
});
