import type { RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { blankRulebook } from "@/lib/byhand";
import { ByHandForm } from "./ByHandForm";

const study = { id: "st-1", documents: [] } as unknown as StudyDetailDto;
const version = (rb = blankRulebook([], { sponsor: "Synthetic Pharma", protocol: "SP-1", site: "DCT", pi: "Dr Rao" }), typed: string[] = []) =>
  ({ version: 1, status: "draft", byHand: true, rulebook: rb, evidence: typed.map((path) => ({ path, status: "attested" })), review: [] }) as unknown as RulebookVersionDto;

function renderForm(v: RulebookVersionDto) {
  // As the contract page does: the form gets the cached version, which a save replaces.
  function Page() {
    const cached = useQuery({ queryKey: ["version", "st-1", 1], queryFn: () => v, initialData: v, staleTime: Infinity });
    return <ByHandForm study={study} version={cached.data} />;
  }
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.setItem("dct.actingAs", "Asha Patel"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ByHandForm", () => {
  it("marks the field whose save failed as not saved, beside it, until a save goes through", async () => {
    const typeValue = vi.spyOn(api, "typeValue").mockRejectedValueOnce(new ApiError(0, "Can't reach the API."));
    renderForm(version());
    const field = screen.getByLabelText("Visit V1 total") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "1234.56" } });
    fireEvent.blur(field);

    const note = await screen.findByText(/^Not saved\./, { selector: "[role=alert]" });
    expect(note.textContent).toMatch(/Can't reach DCT Finance/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(note.id);
    expect(field.value).toBe("1234.56"); // what was typed stays, marked as not saved
    // Typing more doesn't make it look saved.
    fireEvent.change(field, { target: { value: "1234.5" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");

    // Try again: this time it saves, and the field shows the saved value, unmarked.
    const rb = blankRulebook([], { sponsor: "Synthetic Pharma", protocol: "SP-1", site: "DCT", pi: "Dr Rao" });
    rb.budgetGrids[0]!.visits[0]!.totalCents = 123450;
    typeValue.mockResolvedValueOnce(version(rb, ["/budgetGrids/0/visits/0/totalCents"]));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(typeValue).toHaveBeenLastCalledWith("st-1", 1, { path: "/budgetGrids/0/visits/0/totalCents", value: 123450, by: "Asha Patel" });
    await waitFor(() => expect(screen.queryByText(/^Not saved\./)).toBeNull());
    const saved = screen.getByLabelText("Visit V1 total") as HTMLInputElement;
    expect(saved.value).toBe("1234.50");
    expect(saved.getAttribute("aria-invalid")).toBeNull();
  });

  it("says a failed row or visit change where it's in view, and keeps a visit's cells while the visit stays", async () => {
    const rb = blankRulebook([], { sponsor: "S", protocol: "P", site: "X", pi: "Y" });
    const g = rb.budgetGrids[0]!;
    g.visits.push({ ...g.visits[0]!, code: "V2", order: 2 });
    g.procedures[0]!.cells = { V1: 5500, V2: 5500 };
    const typeValue = vi.spyOn(api, "typeValue").mockRejectedValue(new ApiError(503, "Request failed (503)"));
    renderForm(version(rb));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove visit V2" })));
    expect(typeValue).toHaveBeenCalledTimes(1); // the cells weren't cleared for a visit that's still there
    const alert = screen.getByText(/^That change wasn't saved\./);
    expect(alert.closest(".sticky")).not.toBeNull();
  });
});
