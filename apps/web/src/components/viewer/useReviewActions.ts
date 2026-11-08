"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { askForPerson } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { errorText } from "../ui";
import { markState } from "./reviewState";

// The API takes at most 200 items per request.
const BATCH = 200;

/**
 * What a reviewer can do to an item: mark it as matching the contract, take the mark back, flag it as looking wrong, take the
 * flag back. Each call returns the updated version (null when nothing was sent: no name chosen yet, or nothing to do), puts it in
 * the cache so every screen showing the version updates at once, and calls `onChange`. With no name chosen, a call asks for one
 * instead of sending. The screens wire these to their own keys.
 */
export function useReviewActions(version: Version, me: string | null, onChange?: (updated: Version) => void) {
  const client = useQueryClient();
  const m = useMutation({
    mutationFn: (send: (by: string) => Promise<Version | null>) => send(me!),
    onSuccess: (v) => {
      if (!v) return;
      client.setQueryData(keys.version(version.id), v);
      onChange?.(v);
    },
  });

  // Nothing is sent without a name, and a failure is shown by `error` rather than thrown into the screen's key handler.
  const run = async (send: (by: string) => Promise<Version | null>): Promise<Version | null> => {
    if (!me) {
      askForPerson();
      return null;
    }
    try {
      return await m.mutateAsync(send);
    } catch {
      return null;
    }
  };

  return {
    /** Marks every item I haven't marked yet; repeats are skipped. */
    match: (items: string[]) =>
      run(async (by) => {
        const todo = markState(version, items, by).todo;
        let latest: Version | null = null;
        // One batch after another: each answer is a snapshot, and the last one sent must be the last one stored.
        for (let i = 0; i < todo.length; i += BATCH) latest = await api.proofread(version.id, by, todo.slice(i, i + BATCH));
        return latest;
      }),
    /** Takes back my marks on these items. */
    unmatch: (items: string[]) =>
      run(async (by) => {
        let latest: Version | null = null;
        for (const item of markState(version, items, by).mine) latest = await api.unproofread(version.id, by, item);
        return latest;
      }),
    flag: (item: string, note: string) => run((by) => api.flag(version.id, by, item, note.trim())),
    unflag: (item: string) => run((by) => api.unflag(version.id, by, item)),
    busy: m.isPending,
    error: m.error ? errorText(m.error) : null,
    /** Clears a shown error, e.g. when the person starts again. */
    reset: m.reset,
  };
}
