import type {
  AuditEntryDto,
  DiffEntry,
  DocumentDto,
  DocumentKind,
  JobDto,
  RulebookVersionDto,
  SettingsDto,
  StudyDetailDto,
  StudySummaryDto,
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

export const api = {
  listStudies: () => request<StudySummaryDto[]>("GET", "/studies"),
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
  /** A blank draft to type a contract in by hand (ByHandBody). */
  startByHand: (id: string, by: string) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/by-hand`, { by }),
  /** Type one value; by-hand drafts only. */
  typeValue: (id: string, v: number, body: { path: string; value: unknown; by: string }) =>
    request<RulebookVersionDto>("PATCH", `/studies/${q(id)}/versions/${v}/values`, { ...body, note: "Typed by hand" }),
  /** Proposed route: typing is done; picks the values someone else re-types blind. */
  finishByHand: (id: string, v: number, by: string) => request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/by-hand/done`, { by }),
  signOff: (id: string, v: number, body: { by: string; note?: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/sign-off`, body),

  audit: (studyId?: string) => request<AuditEntryDto[]>("GET", `/audit${studyId ? `?studyId=${q(studyId)}` : ""}`),
  getSettings: () => request<SettingsDto>("GET", "/settings"),
  patchSettings: (body: Partial<SettingsDto>) => request<SettingsDto>("PATCH", "/settings", body),

  /** URL for an <img>. Mock mode renders a synthetic page in the browser. */
  pageSrc: async (docId: string, page: number): Promise<string> => {
    if (MOCK) return (await import("./mock/server")).mockPageSrc(docId, page);
    return `/api/documents/${q(docId)}/pages/${page}.png`;
  },
};
