import { type RulebookVersionDto, type StudyDetailDto, suggest } from "@dct/shared";
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
  mockSampling.random = () => 1 - 2 ** -32; // a table check's columns pinned, as in server.test.ts
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

  it("a value question shows our suggestion and why; “Use” answers with it and settles it (ADR-003)", async () => {
    const v = await get<RulebookVersionDto>("/studies/st-northwind/versions/1");
    const q = v.review.find((i) => i.kind === "confirm_value" && i.input === "money" && suggest(i, v)?.value !== undefined)!;
    const s = suggest(q, v)!;
    const sent = renderPage("st-northwind", q.id);
    expect(await screen.findByText("Our suggestion", {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByText(new RegExp(s.why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Use / }));
    await waitFor(() => expect(sent).toHaveBeenLastCalledWith("st-northwind", 1, q.id, expect.objectContaining({ value: s.value })), { timeout: 10_000 });
    await waitFor(async () => expect((await get<RulebookVersionDto>("/studies/st-northwind/versions/1")).review.find((i) => i.id === q.id)!.outcome).toBe("matched"), { timeout: 10_000 });
  }, 60_000);

  it("a table's columns: which visit is the highlighted column, real radios with the visits in order, nothing picked; the pick is sent and settles it", async () => {
    const v = await get<RulebookVersionDto>("/studies/st-cobalt/versions/1");
    const q = v.review.find((i) => i.reason === "TABLE_CHECK")!;
    const sent = renderPage("st-cobalt", q.id);
    expect((await screen.findByRole("heading", { name: /^Which visit is the highlighted column of the table on page \d+\?$/ }, { timeout: 10_000 })).id).toBe(`q-${q.id}`);
    expect(screen.getByText(/doesn't say which visit each column is/, { selector: "p" })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    // our reading is marked on the visit the read gave the column (ADR-003), and nothing is picked for the person
    expect(radios.map((r) => r.closest("label")?.textContent?.replace(/Our reading$/, ""))).toEqual(q.options.map((o) => o.label));
    expect(radios.find((r) => r.value === q.table!.expect)!.closest("label")!.textContent).toMatch(/Our reading$/);
    expect(radios.some((r) => r.checked)).toBe(false);
    fireEvent.click(radios[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-cobalt", 1, q.id, expect.objectContaining({ optionId: q.options[0]!.id })), { timeout: 10_000 });
    await waitFor(async () => expect((await get<RulebookVersionDto>("/studies/st-cobalt/versions/1")).review.find((i) => i.id === q.id)!.outcome).not.toBeNull(), { timeout: 10_000 });
  }, 60_000);

  it("a table that prints no prices at the visits: one question naming the page, the table and its rows to look at, two radios and nothing picked; it waits for the table's columns", async () => {
    const v = await get<RulebookVersionDto>("/studies/st-cobalt/versions/1");
    const q = v.review.find((i) => i.reason === "BLANK_INVOICEABLE")!;
    const sent = renderPage("st-cobalt", q.id);
    expect((await screen.findByRole("heading", { name: /^On page \d+, the highlighted items print no price at the scheduled visits\. How are they billed\?$/ }, { timeout: 10_000 })).id).toBe(`q-${q.id}`);
    // the table, then each row, as places to look at
    const places = screen.getByRole("group", { name: "Places in the contract" });
    expect([...places.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["The table", ...q.where.slice(1).map((_, i) => `Row ${i + 1}`)]);
    expect(screen.getByText(/A person has to say how the contract bills them/, { selector: "p" })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["Only where the contract prints a price", "At every scheduled visit shown"]);
    expect(radios.some((r) => r.checked)).toBe(false);
    // the page never says what was read
    expect(document.body.textContent).not.toMatch(/Inv\.|invoiceable/);
    // it waits for the table's columns: said so, and nothing can be sent yet
    expect(screen.getByText(/Confirm the table's columns first/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save and next/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  }, 60_000);
});
