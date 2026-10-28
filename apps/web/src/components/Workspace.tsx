"use client";

import { settled, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { getAt } from "@/lib/pointer";
import { keys, useInvalidateStudy } from "@/lib/queries";
import { NeedsPerson } from "./AppHeader";
import { PageViewer, type ViewerTarget } from "./PageViewer";
import { RulebookContext, type RulebookCtx } from "./review-context";
import { Button, Dialog, ErrorNote, Field, inputCls } from "./ui";

const isLeaf = (v: unknown) => v !== undefined && (v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object")));

/**
 * Split view: contract page on the left, the invoicing master on the right.
 * Provides the RulebookContext (jump to the page, evidence, blind-entry masks) to everything inside.
 * `report`: a clicked value can be reported with "This looks wrong" (live versions and drafts).
 */
export function Workspace({ study, version, children, report }: { study: StudyDetailDto; version: RulebookVersionDto; children: ReactNode; report?: boolean }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [focused, setFocused] = useState<{ path: string; label: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const evidence = useMemo(() => new Map(version.evidence.map((e) => [e.path, e.status])), [version.evidence]);
  const masked = useMemo(
    () => new Set(version.status === "draft" ? version.review.filter((i) => i.path && !settled(i)).map((i) => i.path!) : []),
    [version.review, version.status],
  );
  if (!version.rulebook) return null;
  const ctx: RulebookCtx = {
    rulebook: version.rulebook,
    focused: focused?.path ?? null,
    evidence,
    masked,
    show: (path, prov, label) => {
      setFocused({ path, label });
      setSent(null);
      if (prov?.source) setTarget((t) => ({ source: prov.source!, label, nonce: (t?.nonce ?? 0) + 1 }));
    },
  };
  const reportable =
    report && (version.status === "signed" || (version.status === "draft" && !version.byHand)) && focused && isLeaf(getAt(version.rulebook, focused.path)) && !masked.has(focused.path);
  return (
    <RulebookContext.Provider value={ctx}>
      <div className="grid min-h-0 flex-1 overflow-hidden rounded-card border border-line bg-surface shadow-card lg:grid-cols-[minmax(360px,5fr)_7fr]">
        <aside aria-label="Contract pages" className="border-line max-lg:h-[60vh] lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:self-start lg:border-r">
          <PageViewer documents={study.documents} target={target} />
        </aside>
        <div className="min-w-0 px-5 pt-4">
          {children}
          <div className="sticky bottom-0 -mx-5 mt-4 flex min-h-14 items-center gap-3 border-t border-line bg-surface/95 px-5 py-2.5 text-[13px] backdrop-blur">
            {sent ? (
              <span role="status" className="text-ok">
                {sent}
              </span>
            ) : reportable ? (
              <>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted">Selected: </span>
                  {focused.label}
                </span>
                <Button size="sm" onClick={() => setOpen(true)}>
                  This looks wrong
                </Button>
              </>
            ) : (
              <span className="text-muted">{report ? "Click a value to see it in the contract, and to report it if it looks wrong." : "Click a value to see it in the contract."}</span>
            )}
          </div>
        </div>
      </div>
      {reportable && (
        <ReportDialog
          open={open}
          onClose={() => setOpen(false)}
          study={study}
          version={version}
          path={focused.path}
          label={focused.label}
          onSent={(m) => (setOpen(false), setFocused(null), setSent(m))}
        />
      )}
    </RulebookContext.Provider>
  );
}

/** Asks only for a note: the value itself is checked by someone typing what the contract says, blind. */
function ReportDialog({ open, onClose, onSent, study, version, path, label }: {
  open: boolean; onClose: () => void; onSent: (message: string | null) => void; study: StudyDetailDto; version: RulebookVersionDto; path: string; label: string;
}) {
  const by = useActingAs();
  const router = useRouter();
  const qc = useQueryClient();
  const invalidate = useInvalidateStudy();
  const [note, setNote] = useState("");
  const live = version.status === "signed";
  const send = useMutation({
    mutationFn: () => api.reportValue(study.id, version.version, { path, note: note.trim(), by: by! }),
    onSuccess: async (draft) => {
      qc.setQueryData(keys.version(study.id, draft.version), draft);
      await invalidate(study.id);
      if (live) router.push(`/studies/${study.id}?corrected=${draft.version}`);
      // A live report moves to the contract page, whose banner says what happened.
      onSent(live ? null : "Added to Needs you. Someone will type what the contract says.");
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="This looks wrong">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) send.mutate();
        }}
      >
        <p className="font-medium">{label}</p>
        <p className="text-[13px] text-muted">
          Someone will type what the contract says here without seeing the value we have, and it&apos;s settled before approval.
          {live && ` Version ${version.version} stays live until a corrected version ${version.version + 1} is approved.`}
        </p>
        <Field label="What looks wrong? (required)" htmlFor="rep-note">
          <textarea id="rep-note" rows={3} autoFocus className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The sponsor's payment for this visit was $10 higher." />
        </Field>
        {!by && <NeedsPerson />}
        <ErrorNote error={send.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!note.trim() || !by || send.isPending}>
            {send.isPending ? "Sending…" : "Report it"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
