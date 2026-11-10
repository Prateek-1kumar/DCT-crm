"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";

// The API takes at most 200 items per request.
const BATCH = 200;

/**
 * Mark or unmark proofread items as the person using the app. With no name chosen yet it asks for one instead of
 * sending. The version the API returns replaces the cached one, so every screen showing it updates at once.
 */
export function useProofread(versionId: string) {
  const me = useActingAs();
  const client = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ items, mark, by }: { items: string[]; mark: boolean; by: string }) => {
      let latest: Version | null = null;
      // One after another: each answer is a snapshot, and the last one sent must be the last one stored.
      if (mark) for (let i = 0; i < items.length; i += BATCH) latest = await api.proofread(versionId, by, items.slice(i, i + BATCH));
      else for (const item of items) latest = await api.unproofread(versionId, by, item);
      return latest;
    },
    onSuccess: (v) => v && client.setQueryData(keys.version(versionId), v),
  });
  /** `unmark` lists only items the person has marked, since taking off a mark you don't have is an error. */
  const run = (items: string[], mark: boolean) => {
    if (items.length === 0) return;
    if (!me) return askForPerson();
    m.mutate({ items, mark, by: me });
  };
  return { me, run, busy: m.isPending, error: m.error };
}
