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

  /** Assumed extra form fields (see docs/phase-1/web.md): `by`, and `studyId` to attach files to an existing study (amendments). */
  upload: (files: File[], by: string, studyId?: string) => {
    const fd = new FormData();
    for (const f of files) fd.append("files[]", f, f.name);
    fd.append("by", by);
    if (studyId) fd.append("studyId", studyId);
    return request<DocumentDto[]>("POST", "/uploads", fd);
  },
  createStudy: (documentIds: string[]) => request<{ studyId: string; jobId: string }>("POST", "/studies", { documentIds }),
  confirmStudy: (id: string, body: { sponsor: string; protocol: string; siteName: string; investigator: string; by: string }) =>
    request<StudyDetailDto>("PATCH", `/studies/${q(id)}`, body),
  setDocumentKind: (docId: string, kind: DocumentKind, by: string) =>
    request<DocumentDto>("PATCH", `/documents/${q(docId)}`, { kind, by }),
  extract: (id: string, by: string) => request<{ jobId: string; version: number }>("POST", `/studies/${q(id)}/extract`, { by }),
  /** Proposed route: blank draft for manual entry after a failed extraction. */
  createManualVersion: (id: string, by: string) =>
    request<{ version: number }>("POST", `/studies/${q(id)}/versions`, { manual: true, by }),
  getJob: (jobId: string) => request<JobDto>("GET", `/jobs/${q(jobId)}`),

  correctValue: (id: string, v: number, body: { path: string; value: unknown; note: string; by: string }) =>
    request<RulebookVersionDto>("PATCH", `/studies/${q(id)}/versions/${v}/values`, body),
  resolveAnomaly: (id: string, v: number, aid: string, body: { kind: "fixed" | "chosen" | "accepted_with_note"; note: string; by: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/anomalies/${q(aid)}/resolve`, body),
  chooseGrid: (id: string, v: number, body: { gridId: string; note: string; by: string }) =>
    request<RulebookVersionDto>("POST", `/studies/${q(id)}/versions/${v}/grid-choice`, body),
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
