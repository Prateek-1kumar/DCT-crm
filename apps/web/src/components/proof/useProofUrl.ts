"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CoverageRef } from "@/lib/types";
import { decodeRef, encodeRef } from "./model";

export type Tab = "contract" | "rulebook";

/** All of the screen's state that a link can carry: ?tab=contract|rulebook&ref=term:ID|grid:ID:ROW:COL&doc=DOCUMENT_ID&page=N&box=INDEX. */
export interface ProofUrl {
  tab: Tab;
  ref: CoverageRef | null;
  doc: string | null;
  page: number | null;
  box: number | null;
}

const num = (s: string | null) => (s !== null && /^\d+$/.test(s) ? Number(s) : null);

export function useProofUrl() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const url: ProofUrl = {
    tab: params.get("tab") === "rulebook" ? "rulebook" : "contract",
    ref: decodeRef(params.get("ref")),
    doc: params.get("doc"),
    page: num(params.get("page")),
    box: num(params.get("box")),
  };

  /** `null` removes a key. A tab switch is a history step (Back returns to the other tab); selections replace. */
  const set = (patch: Partial<ProofUrl>, push = false) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, k === "ref" ? encodeRef(v as CoverageRef) : String(v));
    }
    router[push ? "push" : "replace"](`${pathname}?${next}`, { scroll: false });
  };

  return { url, set };
}
