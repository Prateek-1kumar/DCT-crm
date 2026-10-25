"use client";

import type { Provenance, Rulebook } from "@dct/shared";
import { createContext, useContext } from "react";

/** Shared by the review screen and the read-only rulebook view. */
export type RulebookCtx = {
  rulebook: Rulebook;
  /** Inline editing allowed (draft + a person selected). */
  editable: boolean;
  /** Pointer of the value last shown in the contract. */
  focused: string | null;
  show: (path: string, prov: Provenance | null | undefined, label: string) => void;
  editing: string | null;
  setEditing: (path: string | null) => void;
  /** PATCH /values. Resolves when saved. */
  save: (path: string, value: unknown, note: string) => Promise<void>;
  /** Pointers with an open anomaly, to flag in place. */
  flagged: Set<string>;
};

export const RulebookContext = createContext<RulebookCtx | null>(null);

export function useRulebook(): RulebookCtx {
  const c = useContext(RulebookContext);
  if (!c) throw new Error("useRulebook outside RulebookContext");
  return c;
}

/** True if `path` or something under it has an open anomaly. */
export const isFlagged = (flagged: Set<string>, path: string) => [...flagged].some((f) => f === path || f.startsWith(`${path}/`));
