"use client";

import type { RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { useInvalidateStudy } from "@/lib/queries";
import { PageViewer, type ViewerTarget } from "./PageViewer";
import { RulebookContext, type RulebookCtx } from "./review-context";

/**
 * Split view: contract page on the left, rulebook content on the right.
 * Provides the RulebookContext (jump-to-source, inline edit) to everything inside.
 */
export function Workspace({ study, version, editable, children }: { study: StudyDetailDto; version: RulebookVersionDto; editable: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const by = useActingAs();
  const invalidate = useInvalidateStudy();

  const flagged = useMemo(() => new Set(version.anomalies.filter((a) => !a.resolution && a.path).map((a) => a.path!)), [version.anomalies]);
  const ctx: RulebookCtx | null = version.rulebook
    ? {
        rulebook: version.rulebook,
        editable: editable && !!by,
        focused,
        flagged,
        editing,
        setEditing,
        show: (path, prov, label) => {
          setFocused(path);
          if (prov?.source) setTarget((t) => ({ source: prov.source!, label, nonce: (t?.nonce ?? 0) + 1 }));
        },
        save: async (path, value, note) => {
          await api.correctValue(study.id, version.version, { path, value, note, by: by! });
          await invalidate(study.id);
        },
      }
    : null;

  if (!ctx) return null;
  return (
    <RulebookContext.Provider value={ctx}>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(380px,5fr)_7fr]">
        <aside aria-label="Contract pages" className="border-line max-lg:h-[60vh] lg:sticky lg:self-start lg:top-[calc(3.5rem+var(--bar,0px))] lg:h-[calc(100vh-3.5rem-var(--bar,0px))] lg:border-r">
          <PageViewer documents={study.documents} target={target} />
        </aside>
        <div className="min-w-0 px-5 py-4">{children}</div>
      </div>
    </RulebookContext.Provider>
  );
}
