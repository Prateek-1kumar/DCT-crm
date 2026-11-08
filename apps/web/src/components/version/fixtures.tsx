import type { Question, Rulebook, Term } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Version } from "@/lib/types";

export const term = (id: string, over: Partial<Term> = {}): Term => ({
  id,
  category: "other",
  name: id,
  amountCents: null,
  unit: null,
  billing: "invoice",
  trigger: null,
  cap: null,
  formula: null,
  conditions: null,
  holdbackApplies: "n/a",
  overheadApplies: "n/a",
  deadline: null,
  source: { doc: "Contract.pdf", page: 2, quote: "quote" },
  evidence: "quote",
  houseRuleIds: [],
  notes: null,
  ...over,
});

export const question = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  kind: "decision",
  origin: "check",
  about: null,
  question: `Question text ${id}`,
  context: "",
  source: { doc: "Contract.pdf", page: 2, quote: "net 45 days" },
  options: [
    { label: `${id} option A`, patches: [] },
    { label: `${id} option B`, patches: [] },
  ],
  suggestion: null,
  state: "open",
  blocking: true,
  readings: [],
  resolution: null,
  ...over,
});

export const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "NWP-418", sponsor: "Northwind", payer: null, siteEntity: "Site", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [],
  grids: [],
  accounted: [],
  questions: [],
  ...over,
});

export const version = (over: Partial<Version> = {}): Version => ({
  id: "v1",
  studyId: "s1",
  number: 3,
  status: "draft",
  documentIds: ["d1"],
  documents: [{ id: "d1", name: "Contract.pdf", pageCount: 10 }],
  rulebook: rulebook(),
  problems: [],
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "Ana",
  approvedAt: null,
  approvedBy: null,
  answers: [],
  read: null,
  proofreads: [],
  flags: [],
  ...over,
});

type Handler = (body: unknown) => unknown;

/** Routes are "METHOD /path" (no query); a Response is returned as is, anything else as 200 JSON. */
export function mockApi(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("/api/v1", "").split("?")[0]}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    const out = handler(init?.body ? JSON.parse(init.body as string) : undefined);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export const posts = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(([, init]) => init?.method === "POST");

export function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" }, mutations: { networkMode: "always" } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
