import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { mockApi, posts, question, renderWithClient, rulebook, version } from "./fixtures";
import { QuestionsView } from "./QuestionsView";

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
const box = [0.1, 0.1, 0.4, 0.2];
const find = (boxes: number[][] = [box]) => () => ({ boxes });

describe("QuestionsView", () => {
  it("asks the must-answer questions first, then the worth-a-look ones", async () => {
    mockApi({
      "GET /versions/v1": () =>
        version({ rulebook: rulebook({ questions: [question("look", { blocking: false }), question("must1"), question("must2")] }) }),
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    expect(await screen.findByText("Question text must1")).toBeTruthy();
    expect(screen.getByText("Question 1 of 3")).toBeTruthy();
    expect(screen.getByText("Must answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Question text must2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Question text look")).toBeTruthy();
    expect(screen.getByText("Question 3 of 3")).toBeTruthy();
    expect(screen.getByText("You can approve without answering this.")).toBeTruthy();
  });

  it("shows the context, our suggestion with its reason, and the two readings side by side", async () => {
    mockApi({
      "GET /versions/v1": () =>
        version({
          rulebook: rulebook({
            questions: [
              question("a", {
                kind: "reading",
                context: "The contract says net 45 but a note says net 30.",
                suggestion: { option: 1, reason: "The table is signed, the note is not." },
                readings: [
                  { model: "m1", answer: "Net 45 days" },
                  { model: "m2", answer: "Net 30 days" },
                ],
              }),
            ],
          }),
        }),
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    expect(await screen.findByText("The contract says net 45 but a note says net 30.")).toBeTruthy();
    expect(screen.getByText("Why we suggest it: The table is signed, the note is not.")).toBeTruthy();
    expect(screen.getByText("We suggest this")).toBeTruthy();
    expect(screen.getByText("First reading")).toBeTruthy();
    expect(screen.getByText("Net 45 days")).toBeTruthy();
    expect(screen.getByText("Second reading")).toBeTruthy();
    expect(screen.getByText("Net 30 days")).toBeTruthy();
  });

  it("posts the chosen option with the person's name and moves on to the next question", async () => {
    const answered = version({ rulebook: rulebook({ questions: [question("a", { state: "answered" }), question("b")] }) });
    const fetch = mockApi({
      "GET /versions/v1": () => version({ rulebook: rulebook({ questions: [question("a"), question("b")] }) }),
      "POST /versions/v1/questions/a/answer": () => answered,
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    await screen.findByText("Question text a");
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /a option B/ }));
    fireEvent.click(answer);
    expect(await screen.findByText("Question text b")).toBeTruthy();
    const [[url, init]] = posts(fetch);
    expect(url).toBe("/api/v1/versions/v1/questions/a/answer");
    expect(JSON.parse(init!.body as string)).toEqual({ option: 1, by: "Ana" });
    expect(screen.getByText("Question 2 of 2")).toBeTruthy();
  });

  it("doesn't post without a name", async () => {
    const fetch = mockApi({
      "GET /versions/v1": () => version({ rulebook: rulebook({ questions: [question("a")] }) }),
      "GET /documents/d1/pages/2/find": find(),
    });
    setActingAs(null);
    view();
    await screen.findByText("Question text a");
    fireEvent.click(screen.getByRole("radio", { name: /a option A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("highlights the quote and the region on the page, or says it couldn't find the words", async () => {
    mockApi({
      "GET /versions/v1": () =>
        version({
          rulebook: rulebook({
            questions: [question("a", { source: { doc: "Contract.pdf", page: 2, quote: "net 45 days", region: [0, 0.5, 1, 0.6] } }), question("b", { source: { doc: "Contract.pdf", page: 4, quote: "lost words" } })],
          }),
        }),
      "GET /documents/d1/pages/2/find": find(),
      "GET /documents/d1/pages/4/find": find([]),
    });
    view();
    await screen.findByText("Question text a");
    await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-boxes")).toBe("2"));
    expect(screen.queryByText(/couldn't highlight/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("We couldn't highlight the exact words on this page.")).toBeTruthy();
    expect(screen.getByTestId("page").getAttribute("data-page")).toBe("4");
  });

  it("finishes with All questions answered and a way on to the proof", async () => {
    mockApi({
      "GET /versions/v1": () => version({ rulebook: rulebook({ questions: [question("a", { state: "answered" })] }), answers: [{ questionId: "a", option: 0, by: "Ana", at: "2026-11-02T09:00:00Z" }] }),
    });
    view();
    expect(await screen.findByText("All questions answered")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next: check the proof" }).getAttribute("href")).toBe("/versions/v1/proof");
    fireEvent.click(screen.getByRole("button", { name: "Review answers" }));
    const chosen = (await screen.findByRole("radio", { name: /a option A/ })) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    expect(chosen.matches(":disabled")).toBe(true);
    expect(screen.getByText(/Answered by Ana on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("is read-only once the version is live", async () => {
    mockApi({
      "GET /versions/v1": () => version({ status: "approved", rulebook: rulebook({ questions: [question("a")] }) }),
      "GET /documents/d1/pages/2/find": find(),
    });
    view();
    expect(await screen.findByText("Question text a")).toBeTruthy();
    expect(screen.getByText("This rulebook is live, so its answers can't be changed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.getByRole("radio", { name: /a option A/ }).matches(":disabled")).toBe(true);
  });
});
