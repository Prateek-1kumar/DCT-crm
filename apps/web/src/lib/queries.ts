"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export const useStudies = () => useQuery({ queryKey: keys.studies, queryFn: api.listStudies });
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
