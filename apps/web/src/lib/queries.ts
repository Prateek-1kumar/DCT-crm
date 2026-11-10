import type { Region } from "@dct/shared";
import { request } from "./api";
import type { ActivityItem, ActivityPage, Coverage, Party, PartyRow, PageText, Read, Study, StudyRow, Uploaded, Version } from "./types";

/** TanStack Query keys: one place, so a write can invalidate exactly what it changed. */
export const keys = {
  studies: ["studies"] as const,
  study: (id: string) => ["study", id] as const,
  read: (id: string) => ["read", id] as const,
  version: (id: string) => ["version", id] as const,
  coverage: (versionId: string) => ["coverage", versionId] as const,
  pageText: (documentId: string, page: number) => ["pageText", documentId, page] as const,
  find: (documentId: string, page: number, quote: string) => ["find", documentId, page, quote] as const,
  parties: ["parties"] as const,
  activity: (studyId?: string) => ["activity", studyId ?? "all"] as const,
};

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]]))).toString();
  return s ? `?${s}` : "";
};

export const api = {
  studies: () => request<StudyRow[]>("GET", "/studies"),
  study: (id: string) => request<Study>("GET", `/studies/${id}`),
  parties: () => request<PartyRow[]>("GET", "/parties"),
  /** Renaming keeps the old name as an alias, so a later read of the same wording still finds this party. */
  renameParty: (id: string, name: string, by: string) => request<Party>("PATCH", `/parties/${id}`, { name, by }),
  /** Folds `id` into `into` (same kind): its contracts move across, its names become aliases, and it is removed. Returns the party that remains. */
  mergeParty: (id: string, into: string, by: string) => request<Party>("POST", `/parties/${id}/merge`, { into, by }),
  /** Points a contract at existing parties; null clears one, leaving a slot out keeps it. Returns the study. */
  setStudyParties: (studyId: string, parties: { sponsorId?: string | null; payerId?: string | null; siteId?: string | null }, by: string) => request<Study>("PATCH", `/studies/${studyId}/parties`, { ...parties, by }),
  /** Newest first; `study` limits it to one contract, `before` is the previous page's `next`. */
  activity: (params: { study?: string; before?: number; limit?: number } = {}) => request<ActivityPage>("GET", `/activity${q(params)}`),

  createStudy: (body: { by: string }) => request<{ id: string }>("POST", "/studies", body),

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
  /** Marks items as checked against the PDF by `by`; repeats are ignored. */
  proofread: (versionId: string, by: string, items: string[]) => request<Version>("POST", `/versions/${versionId}/proofread`, { by, items }),
  /** Takes back your own mark. */
  unproofread: (versionId: string, by: string, item: string) => request<Version>("DELETE", `/versions/${versionId}/proofread${q({ by, item })}`),
  /** Says an item looks wrong, with a note; flagging again replaces your note. */
  flag: (versionId: string, by: string, item: string, note: string) => request<Version>("POST", `/versions/${versionId}/flag`, { by, item, note }),
  /** Takes back your own flag. */
  unflag: (versionId: string, by: string, item: string) => request<Version>("DELETE", `/versions/${versionId}/flag${q({ by, item })}`),

  pageText: (documentId: string, page: number) => request<PageText>("GET", `/documents/${documentId}/pages/${page}/text`),
  /** Where `quote` sits on the page, as boxes to highlight; empty when the words aren't there. `approx` (scanned pages only) means the boxes are a larger area that contains the words. */
  find: (documentId: string, page: number, quote: string) => request<{ boxes: Region[]; approx?: true }>("GET", `/documents/${documentId}/pages/${page}/find${q({ q: quote })}`),
};

/** The page as a PNG, through the same-origin /api proxy (an <img> src). */
/**
 * A page, or just `region` of it (fractions 0–1, origin top-left), rendered at `dpi` (up to 300). The server shrinks the sharpness
 * to keep one image within 4096 px, so read the picture's own size rather than assuming it.
 */
export const pageImageAt = (documentId: string, page: number, { dpi, region }: { dpi?: number; region?: Region } = {}) =>
  `/api/v1/documents/${documentId}/pages/${page}/image${q({ dpi, region: region?.map((n) => n.toFixed(4)).join(",") })}`;

export const pageImage = (documentId: string, page: number, dpi?: number) => `/api/v1/documents/${documentId}/pages/${page}/image${q({ dpi })}`;

/**
 * Every activity entry, newest first, for an export. `since` (a time in ms) stops once entries are older than it: the trail
 * arrives newest first, so nothing after that point can be in range.
 */
export async function allActivity({ study, since }: { study?: string; since?: number } = {}): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  let before: number | undefined;
  // ponytail: 200 pages of 100 is the ceiling; a server-side export if a trail ever outgrows 20,000 entries
  for (let page = 0; page < 200; page++) {
    const got = await api.activity({ study, before, limit: 100 });
    out.push(...got.items);
    if (got.next === null || (since !== undefined && got.items.some((i) => Date.parse(i.at) < since))) break;
    before = got.next;
  }
  return since === undefined ? out : out.filter((i) => Date.parse(i.at) >= since);
}
