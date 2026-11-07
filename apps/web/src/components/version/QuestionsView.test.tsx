import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { mockApi, posts, question, renderWithClient, rulebook, version } from "./fixtures";
import { QuestionsView } from "./QuestionsView";
import { cropFor, kindLabel, newQuestions } from "./questions";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("@/components/PageView", () => ({
  PageView: ({ page, boxes }: { page: number; boxes: unknown[] }) => <div data-testid="page" data-page={page} data-boxes={boxes.length} />,
}));

beforeEach(() => setActingAs("Ana"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const view = () => renderWithClient(<QuestionsView versionId="v1" />);
const box = [0.1, 0.4, 0.4, 0.45];
const find = (boxes: number[][] = [box]) => () => ({ boxes });
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

  it("crops the page to the spot with a link to the whole page, or shows the whole page when nothing is located", async () => {
    mockApi({
      "GET /versions/v1": () => withQuestions(question("a", { source: { doc: "Contract.pdf", page: 2, quote: "net 45 days", region: [0.1, 0.5, 0.5, 0.55] } }), question("b", { source: { doc: "Contract.pdf", page: 4, quote: "lost words" } })),
      "GET /documents/d1/pages/2/find": find(),
      "GET /documents/d1/pages/4/find": find([]),
    });
    view();
    await screen.findByText("Question text a");
    await waitFor(() => expect(screen.getAllByRole("img", { name: /this question is about/ })).toHaveLength(2));
    expect(screen.queryByTestId("page")).toBeNull();
    expect(screen.getByRole("link", { name: "See the whole page" }).getAttribute("href")).toBe("/api/v1/documents/d1/pages/2/image");
    skip();
    expect(await screen.findByText("We couldn't highlight the exact words on this page.")).toBeTruthy();
    expect(screen.getByTestId("page").getAttribute("data-page")).toBe("4");
    expect(screen.queryByRole("link", { name: "See the whole page" })).toBeNull();
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

  it("crops around the spot with room to read, and falls back to the whole page", () => {
    expect(cropFor([])).toBeNull();
    const [x0, y0, x1, y1] = cropFor([[0.4, 0.4, 0.5, 0.42]])!;
    expect(x1 - x0).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(y1 - y0).toBeGreaterThanOrEqual(0.22 - 1e-9);
    expect(x0).toBeLessThanOrEqual(0.4);
    expect(x1).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(y0).toBeLessThanOrEqual(0.4);
    expect(y1).toBeGreaterThanOrEqual(0.42 - 1e-9);
    const [a, , b] = cropFor([[0, 0.9, 0.05, 0.95]])!;
    expect(a).toBe(0);
    expect(b - a).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(cropFor([[0, 0, 1, 1]])).toBeNull();
  });
});
