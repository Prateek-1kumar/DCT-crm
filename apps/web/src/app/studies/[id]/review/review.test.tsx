import { type AnswerDraft, answerQuestion, askAbout, blankQuestions, interpretations, isoDate, type Rulebook, type RulebookVersionDto, suggest, tableQuestions, type ValueEvidence } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { confirmed, DOC, rulebook, study, version } from "@/test/fixtures";
import ReviewPage from "./page";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "st-1" }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const START = "interpret:/appliesFrom/value";

/**
 * The review page on one question of `v`, a draft held as the API holds it: an answer is applied by the shared rule the
 * API runs (answerQuestion) and the page refetches it. Returns what each answer sent, and the draft as it is now.
 */
function renderPage(v: RulebookVersionDto, item: string) {
  nav.search = `item=${encodeURIComponent(item)}`;
  vi.spyOn(api, "getStudy").mockResolvedValue(study({ needsYou: v.review.length }));
  vi.spyOn(api, "getVersion").mockImplementation(async () => structuredClone(v));
  vi.spyOn(api, "pageSrc").mockResolvedValue("data:image/svg+xml,");
  const sent = vi.spyOn(api, "answerReview").mockImplementation(async (_s, _v, itemId, body) => {
    const r = answerQuestion(v as AnswerDraft, itemId, body, { isoDate, now: new Date().toISOString() });
    if ("refusal" in r) throw new ApiError(r.refusal.status, r.refusal.message);
    return structuredClone(v);
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewPage />
    </QueryClientProvider>,
  );
  return sent;
}

/** An amendment of Sep 30 that says it's retroactive with no start date: `read`, the start date the master holds. */
function amendment(read: string | null) {
  const rb = rulebook();
  rb.documents.push({ id: "doc-2", kind: "amendment", title: "Amendment 1", date: "2026-09-30" });
  rb.appliesFrom.value = read;
  const review = interpretations(rb, { amendment: true, anomalies: [{ code: "RETROACTIVE_NO_DATE", path: "/appliesFrom/value", message: "Retroactive, with no start date", refs: [] }] });
  return version(rb, { review: review.filter((i) => i.id === START) });
}

/** The grid's prices held for its columns (a scan whose headers don't match), and, with `blank`, its ECG row printing nothing at Week 4. */
function heldTable(blank = false) {
  const rb: Rulebook = rulebook();
  if (blank) rb.budgetGrids[0]!.procedures[2]!.cells.V2 = "invoiceable";
  const evidence: ValueEvidence[] = confirmed(rb).map((e) => (/^\/budgetGrids\/0\/procedures\/\d+\/cells\//.test(e.path) ? { ...e, status: "ungrounded", held: "t1" } : e));
  const BLANK = "/budgetGrids/0/procedures/2/cells/V2";
  if (blank) evidence.push({ path: BLANK, status: "ungrounded", printed: null, note: null, where: [{ documentId: DOC, page: 9, box: [0.1, 0.5, 0.8, 0.02] }], blank: "b1" });
  const columns = rb.budgetGrids[0]!.visits.map((x, i) => ({ visit: x.code, box: { documentId: DOC, page: 9, box: [0.3 + i * 0.2, 0.2, 0.15, 0.5] as [number, number, number, number] } }));
  const review = [
    ...tableQuestions(rb, evidence, [{ id: "t1", grid: 0, page: 9, columns }], () => 0.999),
    ...(blank ? blankQuestions(evidence, [{ id: "b1", grid: 0, page: 9, table: { documentId: DOC, page: 9, box: [0.1, 0.2, 0.8, 0.5] }, rows: [2], cells: [BLANK], after: "t1" }]) : []),
  ];
  return version(rb, { evidence, review });
}

beforeEach(() => {
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
    let v = amendment("2026-09-01");
    let sent = renderPage(v, START);
    const prospective = await screen.findByRole("radio", { name: /^Prospective only: from the amendment.s own date$/ });
    const typed = screen.getByRole("radio", { name: "From a date the contract gives" });
    expect([prospective, typed].map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    fireEvent.click(typed);
    // the date the master holds, typed
    fireEvent.change(screen.getByLabelText("What the contract says"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-1", 1, START, expect.objectContaining({ value: "2026-09-01" })));
    expect(sent.mock.calls[0]![3]).not.toHaveProperty("optionId");
    expect(v.review.find((i) => i.id === START)!.outcome).toBe("matched");

    cleanup();
    v = amendment(null);
    sent = renderPage(v, START);
    fireEvent.click(await screen.findByRole("radio", { name: /^Prospective only/ }));
    fireEvent.change(screen.getByLabelText("The amendment's own date, as printed on it"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-1", 1, START, expect.objectContaining({ optionId: "prospective", value: "2026-09-30" })));
    expect(v.rulebook!.appliesFrom.value).toBe("2026-09-30");
  });

  it("an interpretation picked other than the read: both shown, and keeping the reading sends its option with a note", async () => {
    const rb = rulebook();
    const id = "interpret:/payment/visitPayment/value";
    const sent = renderPage(version(rb, { review: interpretations(rb, { amendment: false }) }), id);
    fireEvent.click(await screen.findByRole("radio", { name: "By invoice" }));
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^Look at the close-up again\. What you picked is different from what we read\. A choice like this isn't in the PDF's text/);
    fireEvent.click(screen.getByRole("radio", { name: /We read.*Automatic \(from EDC\)/ }));
    fireEvent.change(screen.getByLabelText("Where on the page is it printed?"), { target: { value: "§4.1, first line" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenLastCalledWith("st-1", 1, id, expect.objectContaining({ optionId: "auto_edc", note: "§4.1, first line" })));
  });

  it("a value question shows our suggestion and why; “Use” answers with it and settles it (ADR-003)", async () => {
    // we read $71.00; the PDF's text prints 76.00 there
    const rb = rulebook();
    const CELL = "/budgetGrids/0/procedures/2/cells/V1";
    rb.budgetGrids[0]!.procedures[2]!.cells.V1 = 7100;
    const evidence = confirmed(rb).map((e) => (e.path === CELL ? { ...e, status: "conflict" as const, printed: "76.00" } : e));
    const q = askAbout(rb, evidence, CELL, "q1", "VALUE_CONFLICT");
    const v = version(rb, { evidence, review: [q] });
    const s = suggest(q, v)!;
    expect(s.value).toBe(7600);
    const sent = renderPage(v, q.id);
    expect(await screen.findByText("Our suggestion")).toBeTruthy();
    expect(screen.getByText(new RegExp(s.why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Use / }));
    await waitFor(() => expect(sent).toHaveBeenLastCalledWith("st-1", 1, q.id, expect.objectContaining({ value: 7600 })));
    expect(v.review.find((i) => i.id === q.id)!.outcome).toBe("matched");
  });

  it("a table's columns: which visit is the highlighted column, real radios with the visits in order, nothing picked; the pick is sent and settles it", async () => {
    const v = heldTable();
    const q = v.review.find((i) => i.reason === "TABLE_CHECK")!;
    const sent = renderPage(v, q.id);
    expect((await screen.findByRole("heading", { name: "Which visit is the highlighted column of the table on page 9?" })).id).toBe(`q-${q.id}`);
    expect(screen.getByText(/doesn't say which visit each column is/, { selector: "p" })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    // our reading is marked on the visit the read gave the column (ADR-003), and nothing is picked for the person
    expect(radios.map((r) => r.closest("label")?.textContent?.replace(/Our reading$/, ""))).toEqual(q.options.map((o) => o.label));
    expect(radios.find((r) => r.value === q.table!.expect)!.closest("label")!.textContent).toMatch(/Our reading$/);
    expect(radios.some((r) => r.checked)).toBe(false);
    fireEvent.click(radios[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Save and next/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("st-1", 1, q.id, expect.objectContaining({ optionId: q.options[0]!.id })));
    expect(v.review.find((i) => i.id === q.id)!.outcome).not.toBeNull();
  });

  it("a table that prints no prices at the visits: one question naming the page, the table and its rows to look at, two radios and nothing picked; it waits for the table's columns", async () => {
    const v = heldTable(true);
    const q = v.review.find((i) => i.reason === "BLANK_INVOICEABLE")!;
    const sent = renderPage(v, q.id);
    expect((await screen.findByRole("heading", { name: "On page 9, the highlighted items print no price at the scheduled visits. How are they billed?" })).id).toBe(`q-${q.id}`);
    // the table, then each row, as places to look at
    const places = screen.getByRole("group", { name: "Places in the contract" });
    expect([...places.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["The table", "Row 1"]);
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
  });
});
