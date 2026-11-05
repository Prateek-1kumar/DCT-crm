import type { Region } from "@dct/shared";
import { request } from "./api";
import type { Coverage, Party, PartyKind, PageText, Read, Study, StudyRow, Uploaded, Version } from "./types";

/** TanStack Query keys: one place, so a write can invalidate exactly what it changed. */
export const keys = {
  studies: ["studies"] as const,
  study: (id: string) => ["study", id] as const,
  parties: (kind: PartyKind, q: string) => ["parties", kind, q] as const,
  read: (id: string) => ["read", id] as const,
  version: (id: string) => ["version", id] as const,
  coverage: (versionId: string) => ["coverage", versionId] as const,
  pageText: (documentId: string, page: number) => ["pageText", documentId, page] as const,
  find: (documentId: string, page: number, quote: string) => ["find", documentId, page, quote] as const,
};

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]]))).toString();
  return s ? `?${s}` : "";
};

export const api = {
  studies: () => request<StudyRow[]>("GET", "/studies"),
  study: (id: string) => request<Study>("GET", `/studies/${id}`),
  createStudy: (body: { protocol: string; sponsorId: string; payerId: string | null; siteId: string; by: string }) => request<{ id: string }>("POST", "/studies", body),

  parties: (kind: PartyKind, search: string) => request<Party[]>("GET", `/parties${q({ kind, q: search })}`),
  createParty: (body: { kind: PartyKind; name: string; aliases?: string[]; by: string }) => request<Party>("POST", "/parties", body),

  upload: (studyId: string, files: File[], by: string) => {
    const form = new FormData();
    form.append("by", by);
    for (const f of files) form.append("files[]", f, f.name);
    return request<Uploaded[]>("POST", `/studies/${studyId}/documents`, form);
  },
  removeDocument: (studyId: string, documentId: string, by: string) => request<{ ok: true }>("DELETE", `/studies/${studyId}/documents/${documentId}${q({ by })}`),

  startRead: (studyId: string, by: string) => request<{ readId: string; versionId: string }>("POST", `/studies/${studyId}/reads`, { by }),
  read: (id: string) => request<Read>("GET", `/reads/${id}`),

  version: (id: string) => request<Version>("GET", `/versions/${id}`),
  answer: (versionId: string, questionId: string, option: number, by: string) =>
    request<Version>("POST", `/versions/${versionId}/questions/${encodeURIComponent(questionId)}/answer`, { option, by }),
  /** `ticked`: the key terms the approver ticked, recorded with the approval. */
  approve: (versionId: string, by: string, ticked: string[]) => request<Version>("POST", `/versions/${versionId}/approve`, { by, ticked }),
  coverage: (versionId: string) => request<Coverage>("GET", `/versions/${versionId}/coverage`),

  pageText: (documentId: string, page: number) => request<PageText>("GET", `/documents/${documentId}/pages/${page}/text`),
  /** Where `quote` sits on the page, as boxes to highlight; empty when the words aren't there. */
  find: (documentId: string, page: number, quote: string) => request<{ boxes: Region[] }>("GET", `/documents/${documentId}/pages/${page}/find${q({ q: quote })}`),
};

/** The page as a PNG, through the same-origin /api proxy (an <img> src). */
export const pageImage = (documentId: string, page: number, dpi?: number) => `/api/v1/documents/${documentId}/pages/${page}/image${q({ dpi })}`;
