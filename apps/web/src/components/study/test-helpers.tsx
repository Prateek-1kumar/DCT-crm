import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { Read, Study, StudyDocument, VersionSummary } from "@/lib/types";

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Handler = (url: URL, init: RequestInit) => unknown;

export function stubApi(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    const handler = routes[`${init.method ?? "GET"} ${url.pathname.replace("/api/v1", "")}`];
    if (!handler) return new Response(JSON.stringify({ message: "No such route in this test." }), { status: 404 });
    const body = handler(url, init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const party = (id: string, kind: "sponsor" | "cro" | "site", name: string) => ({ id, kind, name, aliases: [], createdAt: "2026-11-01T10:00:00Z", createdBy: "Avery Chen" });

export const doc = (over: Partial<StudyDocument> = {}): StudyDocument => ({ id: "d1", name: "Contract.pdf", bytes: 2_400_000, pageCount: 12, scannedPages: [], scansRead: [], ...over });

export const version = (over: Partial<VersionSummary> = {}): VersionSummary => ({
  id: "v1",
  number: 1,
  status: "reading",
  createdAt: "2026-11-02T09:30:00Z",
  createdBy: "Avery Chen",
  approvedAt: null,
  approvedBy: null,
  ...over,
});

export const study = (over: Partial<Study> = {}): Study => ({
  id: "s1",
  protocol: "NWP-418-02",
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "Avery Chen",
  sponsor: party("p1", "sponsor", "Northwind Pharma"),
  payer: party("p2", "cro", "Fieldstone CRO"),
  site: party("p3", "site", "Discovery Clinical Trials"),
  documents: [doc()],
  versions: [],
  ...over,
});

export const read = (over: Partial<Read> = {}): Read => ({
  id: "r1",
  versionId: "v1",
  status: "running",
  budgetUsd: 3,
  spentUsd: 0.84,
  progress: ["Reading the payment schedule", "Checking the visit grid"],
  error: null,
  createdAt: "2026-11-02T09:30:00Z",
  startedAt: "2026-11-02T09:30:05Z",
  finishedAt: null,
  ...over,
});

/** jsdom has no <dialog> behaviour: give it open/close so modals render their contents in tests. */
export function stubDialog() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
