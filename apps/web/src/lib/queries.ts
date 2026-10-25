"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
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
export const useStudy = (id: string, poll = false) =>
  useQuery({ queryKey: keys.study(id), queryFn: () => api.getStudy(id), refetchInterval: poll ? 2500 : false });
export const useVersion = (id: string, v: number | null) =>
  useQuery({ queryKey: keys.version(id, v ?? -1), queryFn: () => api.getVersion(id, v!), enabled: v !== null });
export const useDiff = (id: string, v: number | null, against: number | null) =>
  useQuery({
    queryKey: keys.diff(id, v ?? -1, against ?? -1),
    queryFn: () => api.getDiff(id, v!, against!),
    enabled: v !== null && against !== null && v !== against,
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
