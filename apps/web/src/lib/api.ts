import type {
  AlertListQuery,
  AlertPage,
  AuditEntryDto,
  DiffEntry,
  DocumentDto,
  DocumentKind,
  JobDto,
  MasterSearch,
  RulebookVersionDto,
  SearchResults,
  SettingsDto,
  StudyCounts,
  StudyDetailDto,
  StudyListQuery,
  StudyPage,
} from "@dct/shared";

/** Typed client for the HTTP API in docs/PHASE-1.md. Everything goes through `request`. */

export const MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | FormData | undefined;

async function request<T>(method: string, path: string, body?: Body): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import("./mock/server");
    const res = await mockRequest(method, path, body);
    if (res.status >= 400) throw new ApiError(res.status, errorMessage(res.json, res.status));
    return res.json as T;
  }
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "Can't reach the API. Is it running on port 4100?");
  }
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, errorMessage(json, res.status));
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** Accepts Fastify's `{ message }`, `{ error }`, or a bare string. */
export function errorMessage(json: unknown, status: number): string {
  if (typeof json === "string" && json) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["message", "error"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  }
  return `Request failed (${status})`;
}

const q = encodeURIComponent;
/** `?a=1&b=2` from the set values, or "". */
const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const t = p.toString();
  return t ? `?${t}` : "";
};

export const api = {
  /** One page of the contract list; the server filters, orders and pages. Pass `nextCursor` back for the next page. */
  listStudies: (query: StudyListQuery) => request<StudyPage>("GET", `/studies${qs(query)}`),
  studyCounts: (site?: string) => request<StudyCounts>("GET", `/studies/counts${qs({ site })}`),
  /** ⌘K: contracts and rates in live contracts. */
  search: (text: string, limit = 8) => request<SearchResults>("GET", `/search${qs({ q: text, limit })}`),
  /** What in one invoicing master matches. */
  searchMaster: (id: string, v: number, text: string) => request<MasterSearch>("GET", `/studies/${q(id)}/versions/${v}/search${qs({ q: text })}`),
  getStudy: (id: string) => request<StudyDetailDto>("GET", `/studies/${q(id)}`),
  getVersion: (id: string, v: number) => request<RulebookVersionDto>("GET", `/studies/${q(id)}/versions/${v}`),
  getDiff: (id: string, v: number, against: number) =>
    request<DiffEntry[]>("GET", `/studies/${q(id)}/versions/${v}/diff?against=${against}`),

  /** `by` is an extra form field for the audit log. Files join a study via createStudy or extract({documentIds}). */
  upload: (files: File[], by: string) => {
    const fd = new FormData();
    fd.append("by", by);
    for (const f of files) fd.append("files[]", f, f.name);
    return request<DocumentDto[]>("POST", "/uploads", fd);
  },
  createStudy: (documentIds: string[], by: string) => request<{ studyId: string; jobId: string }>("POST", "/studies", { documentIds, by }),
  confirmStudy: (id: string, body: { sponsor: string; protocol: string; siteName: string; investigator: string; by: string }) =>
    request<StudyDetailDto>("PATCH", `/studies/${q(id)}`, body),
  setDocumentKind: (docId: string, kind: DocumentKind, by: string) =>
    request<DocumentDto>("PATCH", `/documents/${q(docId)}`, { kind, by }),
  /** `documentIds` adds documents to the study first (amendment journey). */
  extract: (id: string, by: string, documentIds?: string[]) =>
    request<{ jobId: string; version: number }>("POST", `/studies/${q(id)}/extract`, { by, ...(documentIds?.length ? { documentIds } : {}) }),
  getJob: (jobId: string) => request<JobDto>("GET", `/jobs/${q(jobId)}`),

  /** One answer to one question (AnswerReviewBody). Returns the version with the outcome filled in. */
  answerReview: (id: string, v: number, itemId: string, body: { value?: unknown; optionId?: string; cantTell?: boolean; note?: string; by: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/review/${q(itemId)}`, body),
  /** "This looks wrong" (ReportValueBody). On a draft: adds a question. On the live version: opens a correction draft. Returns the draft. */
  reportValue: (id: string, v: number, body: { path: string; note: string; by: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/report`, body),
  /** The approver reopens answered questions with a note (SendBackBody). */
  sendBack: (id: string, v: number, body: { itemIds: string[]; note: string; by: string }) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/send-back`, body),
  /** Values that looked right to someone proofreading (ProofreadBody); any version with a master, live ones too. */
  proofread: (id: string, v: number, body: { paths: string[]; by: string }) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/proofread`, body),
  /** A blank draft to type a contract in by hand (ByHandBody). */
  startByHand: (id: string, by: string) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/by-hand`, { by }),
  /** Type one value; by-hand drafts only. */
  typeValue: (id: string, v: number, body: { path: string; value: unknown; by: string }) =>
    request<RulebookVersionDto>("PATCH", `/studies/${q(id)}/versions/${v}/values`, { ...body, note: "Typed by hand" }),
  /** Proposed route: typing is done; picks the values someone else re-types blind. */
  finishByHand: (id: string, v: number, by: string) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/by-hand/done`, { by }),
  signOff: (id: string, v: number, body: { by: string; note?: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/sign-off`, body),

  /** Alerts for one person (everyone sees every alert; read state is theirs), newest first. */
  alerts: (query: AlertListQuery) => request<AlertPage>("GET", `/alerts${qs(query)}`),
  /** Marks `ids`, or every alert, read for `by`. */
  readAlerts: (body: { by: string; ids?: string[] }) => request<{ unread: number }>("POST", "/alerts/read", body),

  audit: (studyId?: string) => request<AuditEntryDto[]>("GET", `/audit${studyId ? `?studyId=${q(studyId)}` : ""}`),
  getSettings: () => request<SettingsDto>("GET", "/settings"),
  patchSettings: (body: Partial<SettingsDto>) => request<SettingsDto>("PATCH", "/settings", body),

  /** Downloads the invoicing master as an Excel file (built by the server; by the sample server in mock mode). */
  exportXlsx: async (id: string, v: number, by: string) => {
    let href: string, filename: string | undefined;
    if (MOCK) {
      const { mockExport } = await import("./mock/server");
      const f = await mockExport(id, v, by);
      href = URL.createObjectURL(f.blob);
      filename = f.filename;
    } else href = `/api/studies/${q(id)}/versions/${v}/export.xlsx${qs({ by })}`;
    const a = Object.assign(document.createElement("a"), { href, download: filename ?? "" });
    a.click();
    if (MOCK) setTimeout(() => URL.revokeObjectURL(href), 10_000);
  },

  /** URL for an <img>. Mock mode renders a synthetic (vector) page in the browser. `dpi`: sharper page for close-ups. */
  pageSrc: async (docId: string, page: number, dpi?: number): Promise<string> => {
    if (MOCK) return (await import("./mock/server")).mockPageSrc(docId, page);
    return `/api/documents/${q(docId)}/pages/${page}.png${dpi ? `?dpi=${dpi}` : ""}`;
  },
};
