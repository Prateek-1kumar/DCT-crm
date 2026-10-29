"use client";

import { type PageBox, type RulebookVersionDto, type StudyDetailDto, withheldPaths } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { formatDate, formatValue, labelFor } from "@/lib/format";
import { findProv, getAt } from "@/lib/pointer";
import { keys, useInvalidateStudy } from "@/lib/queries";
import { NeedsPerson } from "./Sidebar";
import { DEFAULT_ZOOM, SpotView } from "./SpotView";
import { Dot, EVIDENCE, RulebookContext, type RulebookCtx } from "./review-context";
import { Button, cx, Dialog, ErrorNote, Field, inputCls } from "./ui";

const isLeaf = (v: unknown) => v !== undefined && (v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object")));

/**
 * The invoicing master with the contract one click away: clicking a value opens a drawer with the spot on the page,
 * what backs the value, and "This looks wrong". Provides the RulebookContext (evidence, blind-entry masks, proofread
 * marks, search hits) to everything inside. `focus`: a value to open (⌘K, a search hit); a new `n` opens it again.
 * `report`: a value can be reported (live versions and drafts).
 */
export function Workspace({ study, version, children, report, hits, focus }: {
  study: StudyDetailDto;
  version: RulebookVersionDto;
  children: ReactNode;
  report?: boolean;
  hits?: Set<string>;
  focus?: { path: string; n: number } | null;
}) {
  // `from`: what opened the drawer, so closing it puts keyboard focus back there.
  const [focused, setFocused] = useState<{ path: string; label: string; from: HTMLElement | null } | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const evidence = useMemo(() => new Map(version.evidence.map((e) => [e.path, e.status])), [version.evidence]);
  // the paths the server withholds (with what an open answer decides, as a cap's limit or each visit's "paid automatically")
  const masked = useMemo(() => new Set(withheldPaths(version)), [version]);
  const proofread = useMemo(() => new Map((version.proofread ?? []).map((m) => [m.path, m])), [version.proofread]);
  const noHits = useMemo(() => new Set<string>(), []);

  // A value asked for from outside (⌘K, a search hit): open it and bring it into view.
  const [opened, setOpened] = useState<typeof focus>(null);
  if (focus && focus !== opened && version.rulebook) {
    setOpened(focus);
    setFocused({ path: focus.path, label: labelFor(focus.path, version.rulebook).split(" › ").slice(-2).join(" · "), from: null });
  }
  useEffect(() => {
    if (!focus) return;
    // After the tab with the value has rendered.
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => document.querySelector(`[data-path="${CSS.escape(focus.path)}"]`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" }), 60);
    return () => clearTimeout(t);
  }, [focus]);

  if (!version.rulebook) return null;
  const ctx: RulebookCtx = {
    rulebook: version.rulebook,
    focused: focused?.path ?? null,
    evidence,
    masked,
    proofread,
    hits: hits ?? noHits,
    show: (path, _prov, label) => setFocused({ path, label, from: document.activeElement instanceof HTMLElement ? document.activeElement : null }),
  };
  return (
    <RulebookContext.Provider value={ctx}>
      {/* Room for the drawer, so it never covers what was clicked. */}
      <div className={cx("transition-[padding] duration-200 motion-reduce:transition-none", focused && "lg:pr-[456px]")}>{children}</div>
      {focused && (
        <ValueDrawer
          key={focused.path}
          study={study}
          version={version}
          path={focused.path}
          label={focused.label}
          report={!!report}
          zoom={zoom}
          onZoom={setZoom}
          onClose={() => {
            setFocused(null);
            if (focused.from?.isConnected) focused.from.focus();
          }}
        />
      )}
    </RulebookContext.Provider>
  );
}

/**
 * The value, the spot in the contract that backs it, and how it was checked. Not modal: the master stays clickable.
 * It takes focus when it opens (Tab moves through it, Escape closes it and returns focus to the value).
 */
function ValueDrawer({ study, version, path, label, report, zoom, onZoom, onClose }: {
  study: StudyDetailDto; version: RulebookVersionDto; path: string; label: string; report: boolean; zoom: number; onZoom: (z: number) => void; onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const rb = version.rulebook!;
  // a value, or one it's made of (a cap's limit), withheld for a blind answer
  const masked = withheldPaths(version).some((p) => p === path || p.startsWith(`${path}/`));
  const ev = version.evidence.find((e) => e.path === path);
  const prov = findProv(rb, path);
  const mark = version.proofread?.find((m) => m.path === path);
  const spot: PageBox | null = ev?.where[0] ?? (prov?.source ? { documentId: prov.source.documentId, page: prov.source.page, box: null } : null);
  const value = getAt(rb, path);
  // typed by hand: reported once typing is marked done (before, the value is changed in the form)
  const reportable = report && (version.status === "signed" || (version.status === "draft" && (!version.byHand || version.review.length > 0))) && isLeaf(value) && !masked;

  const self = useRef<HTMLElement>(null);
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open]") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      ref={self}
      tabIndex={-1}
      aria-label={`In the contract: ${label}`}
      className="fixed inset-x-2 bottom-2 z-40 flex h-[78vh] flex-col overflow-hidden rounded-card bg-surface shadow-raised ring-1 ring-ink/[0.08] lg:inset-x-auto lg:top-3 lg:right-3 lg:bottom-3 lg:h-auto lg:w-[480px]"
    >
      <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-small text-muted">{label}</p>
          <p className="num truncate text-heading font-semibold tracking-tight">{masked ? <span className="text-warn">Needs you</span> : value === undefined ? "—" : formatValue(path, value)}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X className="size-4" strokeWidth={2} />
        </Button>
      </header>

      <div className="flex flex-col gap-2 px-5 py-3 text-small">
        {masked ? (
          <p className="text-warn">Someone types what the contract says here before it&apos;s shown. Answer it in Needs you.</p>
        ) : ev ? (
          <p className="flex items-start gap-2">
            {/* The words follow, so the dot's own label would only repeat them. */}
            <span aria-hidden className="mt-1.5">
              <Dot status={ev.status} />
            </span>
            <span>
              <span className="font-medium">{EVIDENCE[ev.status].label}.</span>{" "}
              {ev.status === "confirmed" && ev.printed && <span className="text-muted">The page prints “{ev.printed}” here.</span>}
              {ev.status === "attested" && <span className="text-muted">A person typed or chose it from the contract.</span>}
              {ev.status === "conflict" && <span className="text-muted">The page prints {ev.printed ? `“${ev.printed}”` : "something else"} here.</span>}
              {ev.status === "ungrounded" && <span className="text-muted">It couldn&apos;t be found on the page.</span>}
              {ev.note && <span className="block text-faint">{ev.note}</span>}
            </span>
          </p>
        ) : (
          <p className="text-muted">Wording, not a number: read it on the page below.</p>
        )}
        {mark && (
          <p className="flex items-center gap-2 text-ok">
            <Check aria-hidden className="size-3.5" strokeWidth={3} /> Proofread by {mark.by} · {formatDate(mark.at)}
          </p>
        )}
        {/* a rule's quote prints its number: never while the value is withheld */}
        {!masked && prov?.source?.quote && <blockquote className="border-l-2 border-line-strong pl-3 text-muted italic">“{prov.source.quote}”</blockquote>}
      </div>

      <div className="min-h-0 flex-1 px-3">
        {spot ? <SpotView documents={study.documents} spot={spot} zoom={zoom} onZoom={onZoom} /> : <p className="px-2 py-8 text-center text-small text-muted">No page reference for this value.</p>}
      </div>

      <footer className="flex min-h-16 items-center gap-3 px-5 py-3 text-small">
        {sent ? (
          <span role="status" className="text-ok">
            {sent}
          </span>
        ) : reportable ? (
          <>
            <span className="flex-1 text-muted">Doesn&apos;t match the contract?</span>
            <Button size="sm" onClick={() => setOpen(true)}>
              This looks wrong
            </Button>
          </>
        ) : null}
      </footer>
      {reportable && <ReportDialog open={open} onClose={() => setOpen(false)} study={study} version={version} path={path} label={label} onSent={(m) => (setOpen(false), setSent(m))} />}
    </aside>
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
        <p className="text-small text-muted">
          Someone will type what the contract says here without seeing the value we have, and it&apos;s settled before approval.
          {live && ` Version ${version.version} stays live until a corrected version ${version.version + 1} is approved.`}
        </p>
        <Field
          label="What looks wrong? (required)"
          htmlFor="rep-note"
          hint="Any figures in your note are hidden from whoever answers, so they can't steer them. Say where on the page it looks wrong instead."
        >
          <textarea id="rep-note" rows={3} data-autofocus className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The visit total on page 2 doesn't match the rows above it." />
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
