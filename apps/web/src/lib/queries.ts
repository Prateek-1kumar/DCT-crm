"use client";

import type { StudyListQuery } from "@dct/shared";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";

/** Query keys and hooks: one place so invalidation stays consistent. */
export const keys = {
  studies: ["studies"] as const,
  study: (id: string) => ["study", id] as const,
  version: (id: string, v: number) => ["version", id, v] as const,
  diff: (id: string, v: number, against: number) => ["diff", id, v, against] as const,
  job: (id: string) => ["job", id] as const,
  audit: (studyId?: string) => ["audit", studyId ?? "all"] as const,
  settings: ["settings"] as const,
};

/** The contract list, a page at a time; the server filters and orders. `fetchNextPage` for "Show more". */
export const useStudyPages = (query: Omit<StudyListQuery, "cursor">) =>
  useInfiniteQuery({
    queryKey: [...keys.studies, "page", query],
    queryFn: ({ pageParam }) => api.listStudies({ ...query, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
/** Contracts per view and the sites there are (tabs, sidebar). */
export const useStudyCounts = (site?: string) => useQuery({ queryKey: [...keys.studies, "counts", site ?? ""], queryFn: () => api.studyCounts(site) });

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
/** ⌘K: contracts and rates. Empty text asks nothing. */
export const useSearch = (text: string) => {
  const q = useDebounced(text.trim());
  return useQuery({ queryKey: [...keys.studies, "search", q], queryFn: () => api.search(q), enabled: q.length > 0, placeholderData: keepPreviousData });
};
/** What in one invoicing master matches `text`. */
export const useMasterSearch = (id: string, v: number | null, text: string) => {
  const q = useDebounced(text.trim());
  return useQuery({ queryKey: ["version", id, v ?? -1, "search", q], queryFn: () => api.searchMaster(id, v!, q), enabled: v !== null && q.length > 0, placeholderData: keepPreviousData });
};
/** Polls while the study is extracting. */
export const useStudy = (id: string) =>
  useQuery({ queryKey: keys.study(id), queryFn: () => api.getStudy(id), refetchInterval: (q) => (q.state.data?.status === "extracting" ? 2500 : false) });
export const useVersion = (id: string, v: number | null) =>
  useQuery({
    queryKey: keys.version(id, v ?? -1),
    queryFn: () => api.getVersion(id, v!),
    enabled: v !== null,
    refetchInterval: (q) => (q.state.data?.status === "extracting" ? 2500 : false),
  });
export const useDiff = (id: string, v: number | null, against: number | null) =>
  useQuery({
    queryKey: keys.diff(id, v ?? -1, against ?? -1),
    queryFn: () => api.getDiff(id, v!, against!),
    enabled: v !== null && against !== null && v !== against,
  });
/** Polls until the job finishes. */
export const useJob = (jobId: string | null) =>
  useQuery({
    queryKey: keys.job(jobId ?? ""),
    queryFn: () => api.getJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && (q.state.data.state === "succeeded" || q.state.data.state === "failed") ? false : 700),
  });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.getSettings, staleTime: 60_000 });

/** Alerts for `person`, a page at a time. Polled, so new ones show up without a reload.
 * ponytail: polling every 30 s; server-sent events if that ever feels slow. */
export const useAlerts = (person: string | null) =>
  useInfiniteQuery({
    queryKey: ["alerts", person ?? ""],
    queryFn: ({ pageParam }) => api.alerts({ for: person!, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!person,
    refetchInterval: 30_000,
  });

/** After any write to a study: refresh everything that summarizes it. */
export function useInvalidateStudy() {
  const qc = useQueryClient();
  return (id: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.study(id) }),
      qc.invalidateQueries({ queryKey: ["version", id] }),
      qc.invalidateQueries({ queryKey: ["diff", id] }),
      qc.invalidateQueries({ queryKey: keys.studies }),
      qc.invalidateQueries({ queryKey: ["audit"] }),
      qc.invalidateQueries({ queryKey: ["alerts"] }),
    ]);
}

/** Mark values as proofread; the returned version replaces the cached one. */
export function useProofread(id: string, v: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { paths: string[]; by: string }) => api.proofread(id, v, body),
    onSuccess: (dto) => {
      qc.setQueryData(keys.version(id, v), dto);
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** Answer one review question; the returned version replaces the cached one. */
export function useAnswerReview(id: string, v: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidateStudy();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: Parameters<typeof api.answerReview>[3] }) => api.answerReview(id, v, itemId, body),
    onSuccess: (dto) => {
      qc.setQueryData(keys.version(id, v), dto);
      void invalidate(id);
    },
  });
}
