import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { mockApi, posts, question, renderWithClient, rulebook, version } from "./fixtures";
import { QuestionsView } from "./QuestionsView";
import { kindLabel, newQuestions } from "./questions";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));
// jsdom has no layout, so the real viewer is replaced by a stand-in that shows what it was asked to draw.
vi.mock("@/components/viewer", async (original) => ({
  ...(await original<object>()),
  ContractViewer: ({ documentId, page, focus, boxes, startIn, onPageChange }: { documentId: string; page: number; focus: number[] | null; boxes: { tone: string; label: string; approx?: boolean }[]; startIn: string; onPageChange: (p: number) => void }) => (
    <div data-testid="viewer" data-doc={documentId} data-page={page} data-focus={focus ? focus.join(",") : ""} data-boxes={boxes.length} data-tones={boxes.map((b) => b.tone).join(",")} data-approx={boxes.map((b) => !!b.approx).join(",")} data-labels={boxes.map((b) => b.label).join("|")} data-start={startIn}>
      <button onClick={() => onPageChange(page + 1)}>Stub next page</button>
    </div>
  ),
}));

beforeEach(() => setActingAs("Ana"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const view = () => renderWithClient(<QuestionsView versionId="v1" />);
const box = [0.1, 0.4, 0.4, 0.45];
const find = (boxes: number[][] = [box], approx?: true) => () => ({ boxes, ...(approx && { approx }) });
const APPROX_NOTE = "We couldn't pin down the exact spot on this scanned page, so the highlighted area is approximate. What you're looking for is inside it.";
const withQuestions = (...questions: ReturnType<typeof question>[]) => version({ rulebook: rulebook({ questions }) });
const skip = () => fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

describe("QuestionsView", () => {
  it("asks the must-answer questions first and says the others don't hold up approval", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("look", { blocking: false }), question("must1"), question("must2")), "GET /documents/d1/pages/2/find": find() });
    view();
    expect(await screen.findByText("Question text must1")).toBeTruthy();
    expect(screen.getByText("Question 1 of 3")).toBeTruthy();
    expect(screen.getByText("0 answered · 3 to go")).toBeTruthy();
    expect(screen.getByText("The contract doesn't say")).toBeTruthy();
    skip();
    expect(await screen.findByText("Question text must2")).toBeTruthy();
    skip();
    expect(await screen.findByText("Question text look")).toBeTruthy();
    expect(screen.getByText("Question 3 of 3")).toBeTruthy();
    expect(screen.getByText("Worth a look")).toBeTruthy();
    expect(screen.getByText("This isn't holding up approval.")).toBeTruthy();
    // skipping kept them open and wraps back to the first
    skip();
    expect(await screen.findByText("Question text must1")).toBeTruthy();
    expect(screen.getByText("0 answered · 3 to go")).toBeTruthy();
  });

  it("shows the suggestion with its reason and the two readings side by side, never the model names or codes", async () => {
    mockApi({
      "GET /versions/v1": () =>
        withQuestions(
          question("a", {
            kind: "reading",
            context: "The contract says net 45 but a note says net 30.",
            suggestion: { option: 1, reason: "The table is signed, the note is not." },
            readings: [
              { model: "gpt-x", answer: "Net 45 days" },
              { model: "claude-y", answer: "Net 30 days" },
            ],
          }),
        ),
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    expect(await screen.findByText("The contract says net 45 but a note says net 30.")).toBeTruthy();
    expect(screen.getByText("Checking a printed figure")).toBeTruthy();
    expect(screen.getByText("Suggested")).toBeTruthy();
    expect(screen.getByText("Why: The table is signed, the note is not.")).toBeTruthy();
    expect(screen.getByText("First reading")).toBeTruthy();
    expect(screen.getByText("Net 45 days")).toBeTruthy();
    expect(screen.getByText("Second reading")).toBeTruthy();
    expect(screen.queryByText("gpt-x")).toBeNull();
    expect(screen.getByText(/net 45 days/, { selector: "blockquote" })).toBeTruthy();
  });

  it("posts the chosen option as the person, jumps to the next open question and says when the checks raised another", async () => {
    const after = withQuestions(question("a", { state: "answered" }), question("b"), question("c"), question("new"));
    after.answers = [{ questionId: "a", option: 1, by: "Ana", at: "2026-11-02T09:00:00Z" }];
    const fetch = mockApi({
      "GET /versions/v1": () => withQuestions(question("a"), question("b"), question("c")),
      "POST /versions/v1/questions/a/answer": () => after,
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    await screen.findByText("Question text a");
    const use = screen.getByRole("button", { name: "Use this answer" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /a option B/ }));
    fireEvent.click(use);
    expect(await screen.findByText("Question text b")).toBeTruthy();
    const [[url, init]] = posts(fetch);
    expect(url).toBe("/api/v1/versions/v1/questions/a/answer");
    expect(JSON.parse(init!.body as string)).toEqual({ option: 1, by: "Ana" });
    expect(screen.getByText("Question 2 of 4")).toBeTruthy();
    expect(screen.getByText("Answer saved. One more came up after that answer.")).toBeTruthy();
    expect(screen.getByText("1 answered · 3 to go")).toBeTruthy();
  });

  it("doesn't post without a name", async () => {
    const fetch = mockApi({ "GET /versions/v1": () => withQuestions(question("a")), "GET /documents/d1/pages/2/find": find() });
    setActingAs(null);
    view();
    await screen.findByText("Question text a");
    fireEvent.click(screen.getByRole("radio", { name: /a option A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use this answer" }));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("answers from the keyboard: a number picks, Enter confirms, J and K move between questions", async () => {
    const fetch = mockApi({
      "GET /versions/v1": () => withQuestions(question("a"), question("b")),
      "POST /versions/v1/questions/a/answer": () => withQuestions(question("a", { state: "answered" }), question("b")),
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    await screen.findByText("Question text a");
    const screenEl = screen.getByText("Question text a").closest("[tabindex]")!;
    fireEvent.keyDown(screenEl, { key: "j" });
    expect(await screen.findByText("Question text b")).toBeTruthy();
    fireEvent.keyDown(screen.getByText("Question text b").closest("[tabindex]")!, { key: "k" });
    expect(await screen.findByText("Question text a")).toBeTruthy();
    const el = screen.getByText("Question text a").closest("[tabindex]")!;
    fireEvent.keyDown(el, { key: "2" });
    expect((screen.getByRole("radio", { name: /a option B/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(await screen.findByText("Question text b")).toBeTruthy();
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ option: 1, by: "Ana" });
  });

  it("ignores keys typed into a text box", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a")), "GET /documents/d1/pages/2/find": find() });
    const { container } = view();
    await screen.findByText("Question text a");
    const input = document.createElement("input");
    container.appendChild(input);
    fireEvent.keyDown(input, { key: "1" });
    expect((screen.getByRole("radio", { name: /a option A/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("opens the contract at the passage: the quote's own words on its page, or the region when there is one", async () => {
    mockApi({
      "GET /versions/v1": () => withQuestions(question("a", { source: { doc: "Contract.pdf", page: 2, quote: "net 45 days" } }), question("b", { source: { doc: "Contract.pdf", page: 4, quote: "scanned", region: [0.1, 0.5, 0.5, 0.55] } })),
      "GET /documents/d1/pages/2/find": find([[0.1, 0.4, 0.4, 0.45], [0.1, 0.46, 0.3, 0.5]]),
    });
    view();
    await screen.findByText("Question text a");
    const viewer = () => screen.getByTestId("viewer");
    // two lines of the quote: both drawn as the focus, the viewer zooms to the box around them
    await waitFor(() => expect(viewer().getAttribute("data-focus")).toBe("0.1,0.4,0.4,0.5"));
    expect(viewer().getAttribute("data-tones")).toBe("focus,focus");
    expect(viewer().getAttribute("data-start")).toBe("passage");
    expect(viewer().getAttribute("data-page")).toBe("2");
    expect(viewer().getAttribute("data-doc")).toBe("d1");
    // another question: the viewer follows to its page and passage (the region, with no page-text search)
    skip();
    await screen.findByText("Question text b");
    await waitFor(() => expect(viewer().getAttribute("data-page")).toBe("4"));
    expect(viewer().getAttribute("data-focus")).toBe("0.1,0.5,0.5,0.55");
    expect(viewer().getAttribute("data-boxes")).toBe("1");
  });

  describe("how exactly the passage can be marked", () => {
    const region = [0.1, 0.5, 0.5, 0.55];
    const quoted = (over: object) => question("a", { source: { doc: "Contract.pdf", page: 2, quote: "net 45 days", ...over } });
    const viewer = () => screen.getByTestId("viewer");

    it("an exact search result beats a region the AI typed", async () => {
      mockApi({ "GET /versions/v1": () => withQuestions(quoted({ region })), "GET /documents/d1/pages/2/find": find([box]) });
      view();
      await waitFor(() => expect(viewer().getAttribute("data-focus")).toBe(box.join(",")));
      expect(viewer().getAttribute("data-approx")).toBe("false");
      expect(viewer().getAttribute("data-labels")).toBe("The words this question is about");
      expect(screen.queryByText(APPROX_NOTE)).toBeNull();
    });

    it("draws nothing while the search is running, so the region never shows first and then jumps", async () => {
      const fetch = mockApi({ "GET /versions/v1": () => withQuestions(quoted({ region })) });
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (url.includes("/find") ? new Promise(() => {}) : fetch(url, init)));
      view();
      await screen.findByText("Question text a");
      expect(viewer().getAttribute("data-boxes")).toBe("0");
      expect(viewer().getAttribute("data-focus")).toBe("");
    });

    it("a search result flagged approximate is drawn as an approximate area, with the note", async () => {
      mockApi({ "GET /versions/v1": () => withQuestions(quoted({ region })), "GET /documents/d1/pages/2/find": find([[0.05, 0.3, 0.9, 0.6]], true) });
      view();
      await waitFor(() => expect(viewer().getAttribute("data-focus")).toBe("0.05,0.3,0.9,0.6"));
      expect(viewer().getAttribute("data-approx")).toBe("true");
      expect(viewer().getAttribute("data-labels")).toBe("Approximate area · The words this question is about");
      expect(screen.getByText(APPROX_NOTE)).toBeTruthy();
    });

    it("falls back to the region, as approximate, when the words aren't found; the note replaces the warning", async () => {
      mockApi({ "GET /versions/v1": () => withQuestions(quoted({ region })), "GET /documents/d1/pages/2/find": find([]) });
      view();
      await waitFor(() => expect(viewer().getAttribute("data-focus")).toBe(region.join(",")));
      expect(viewer().getAttribute("data-approx")).toBe("true");
      expect(await screen.findByText(APPROX_NOTE)).toBeTruthy();
      expect(screen.queryByText("We couldn't highlight the exact words on this page.")).toBeNull();
    });

    it("a question with a region and no quote uses the region as approximate, without searching", async () => {
      const fetch = mockApi({ "GET /versions/v1": () => withQuestions(quoted({ quote: "", region })) });
      view();
      await screen.findByText("Question text a");
      expect(viewer().getAttribute("data-focus")).toBe(region.join(","));
      expect(viewer().getAttribute("data-approx")).toBe("true");
      expect(screen.getByText(APPROX_NOTE)).toBeTruthy();
      expect(fetch.mock.calls.some(([url]) => String(url).includes("/find"))).toBe(false);
    });

    it("with no flag from the search, nothing is approximate", async () => {
      mockApi({ "GET /versions/v1": () => withQuestions(quoted({})), "GET /documents/d1/pages/2/find": find() });
      view();
      await waitFor(() => expect(viewer().getAttribute("data-boxes")).toBe("1"));
      expect(viewer().getAttribute("data-approx")).toBe("false");
      expect(screen.queryByText(APPROX_NOTE)).toBeNull();
    });
  });

  it("puts the quote, page and file in a strip above the contract and says when the words can't be found", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a", { source: { doc: "Contract.pdf", page: 2, quote: "lost words" } })), "GET /documents/d1/pages/2/find": find([]) });
    view();
    expect(await screen.findByText(/lost words/, { selector: "blockquote" })).toBeTruthy();
    expect(screen.getByText("The contract says:")).toBeTruthy();
    expect(screen.getByText(/page 2/)).toBeTruthy();
    expect(await screen.findByText("We couldn't highlight the exact words on this page.")).toBeTruthy();
    expect(screen.getByTestId("viewer").getAttribute("data-focus")).toBe("");
  });

  it("lets you turn to another page and come back to the passage", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a")), "GET /documents/d1/pages/2/find": find() });
    view();
    await screen.findByText("Question text a");
    fireEvent.click(screen.getByRole("button", { name: "Stub next page" }));
    expect(screen.getByTestId("viewer").getAttribute("data-page")).toBe("3");
    expect(screen.getByTestId("viewer").getAttribute("data-boxes")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Back to the passage" }));
    expect(screen.getByTestId("viewer").getAttribute("data-page")).toBe("2");
  });

  it("says plainly when the page can't be shown, and the question stays answerable", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a", { source: { doc: "Missing.pdf", page: 1, quote: "" } })) });
    view();
    expect(await screen.findByText(/We couldn't show this page\. The question is still answerable/)).toBeTruthy();
    expect(screen.queryByTestId("viewer")).toBeNull();
    expect((screen.getByRole("radio", { name: /a option A/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it("folds the contract away in a panel when stacked", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a")), "GET /documents/d1/pages/2/find": find() });
    view();
    await screen.findByText("Question text a");
    const toggle = screen.getByRole("button", { name: "Contract" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("contract-panel")!.className).toContain("hidden");
  });

  it("clamps a long explanation until asked", async () => {
    mockApi({ "GET /versions/v1": () => withQuestions(question("a", { context: "x ".repeat(200) })), "GET /documents/d1/pages/2/find": find() });
    view();
    await screen.findByText("Question text a");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("all decisions made leads to Approve, or waits for a colleague when you answered", async () => {
    const done = withQuestions(question("a", { state: "answered" }));
    done.answers = [{ questionId: "a", option: 0, by: "Bea", at: "2026-11-02T09:00:00Z" }];
    mockApi({ "GET /versions/v1": () => done });
    view();
    expect(await screen.findByText("All decisions made")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review and approve" }).getAttribute("href")).toBe("/versions/v1/approve");
    cleanup();
    done.answers = [{ questionId: "a", option: 0, by: "Ana", at: "2026-11-02T09:00:00Z" }];
    view();
    const wait = (await screen.findByRole("button", { name: "Waiting for a colleague" })) as HTMLButtonElement;
    expect(wait.disabled).toBe(true);
    expect(screen.getByText(/Ana answered these decisions/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Review and approve" })).toBeNull();
  });

  it("lets you review answered questions, read-only, with who answered and when", async () => {
    const done = withQuestions(question("a", { state: "answered" }));
    done.answers = [{ questionId: "a", option: 0, by: "Bea", at: "2026-11-02T09:00:00Z" }];
    mockApi({ "GET /versions/v1": () => done, "GET /documents/d1/pages/2/find": find() });
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Review the answers" }));
    const chosen = (await screen.findByRole("radio", { name: /a option A/ })) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    expect(chosen.disabled).toBe(true);
    expect(screen.getByText(/Answered by Bea on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("All decisions made")).toBeTruthy();
  });

  it("a question with nothing to choose explains it and offers Start again", async () => {
    const rerun = question("review:not-run", { question: "This read wasn't checked for judgment calls.", context: "The second reader couldn't run on this read.", options: [] });
    mockApi({ "GET /versions/v1": () => withQuestions(rerun), "GET /documents/d1/pages/2/find": find() });
    view();
    expect(await screen.findByText(/wasn't checked for judgment calls/)).toBeTruthy();
    expect(screen.getByText(/nothing to choose here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this answer" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("failing checks with no question to answer are listed in words with a way to read again", async () => {
    mockApi({ "GET /versions/v1": () => version({ problems: [{ check: "money", message: "$1,200.00 on page 3 isn't accounted for.", doc: "Contract.pdf", page: 3 }] }) });
    view();
    expect(await screen.findByText("Some checks still fail")).toBeTruthy();
    expect(screen.getByText(/isn't accounted for/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start the read again" })).toBeTruthy();
    expect(screen.queryByText("All decisions made")).toBeNull();
  });

  it("says a live version's decisions can't be answered, shows them read-only and links back to the contract", async () => {
    mockApi({ "GET /versions/v1": () => ({ ...withQuestions(question("a")), status: "approved" }), "GET /documents/d1/pages/2/find": find() });
    view();
    expect(await screen.findByText("Question text a")).toBeTruthy();
    expect(screen.getAllByText(/can't be answered or changed/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back to the contract" }).getAttribute("href")).toBe("/studies/s1");
    expect(screen.queryByRole("button", { name: "Use this answer" })).toBeNull();
    expect((screen.getByRole("radio", { name: /a option A/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows a skeleton while loading and a plain message when the version doesn't load", async () => {
    mockApi({ "GET /versions/v1": () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }) });
    view();
    expect(screen.getByRole("status", { name: "Loading the decisions" })).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("question helpers", () => {
  it("names a question's kind in plain words", () => {
    expect(kindLabel({ kind: "reading", blocking: true })).toBe("Checking a printed figure");
    expect(kindLabel({ kind: "decision", blocking: true })).toBe("The contract doesn't say");
    expect(kindLabel({ kind: "reading", blocking: false })).toBe("Worth a look");
  });

  it("counts the questions an answer brought in", () => {
    expect(newQuestions([question("a")], [question("a"), question("b"), question("c")])).toBe(2);
  });
});
