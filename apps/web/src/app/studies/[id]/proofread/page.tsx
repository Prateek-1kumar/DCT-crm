"use client";

import type { RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Check, CheckCircle2, CornerDownLeft, Flag, Info, ListChecks, ShieldCheck, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { RowCompare } from "@/components/RowCompare";
import { NeedsPerson } from "@/components/Sidebar";
import { DEFAULT_ZOOM, SpotView } from "@/components/SpotView";
import { Badge, Button, btnCls, cx, ErrorNote, LoadError, ProgressBar, Sheet, Spinner } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { formatValue, relativeTime } from "@/lib/format";
import { asked, proofUnits, reportWrong, SECTION_LABEL, unitStatus, type ProofSection, type ProofUnit, type UnitStatus } from "@/lib/proofread";
import { useInvalidateStudy, useProofread, useStudy, useVersion } from "@/lib/queries";

export default function ProofreadPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  // The newest version with a master that isn't superseded: a draft being reviewed, else the live one.
  const versions = study.data ? [...study.data.versions].sort((a, b) => b.version - a.version) : [];
  const pickV = sp.get("v") ? Number(sp.get("v")) : (versions.find((v) => v.status === "draft") ?? versions.find((v) => v.status === "signed"))?.version ?? null;
  const version = useVersion(id, pickV);

  const failed = (!study.data && study.error) || (!version.data && version.error);
  if (failed) return <LoadError error={failed} retry={() => void (study.error ? study.refetch() : version.refetch())} />;
  if (!study.data || (pickV !== null && !version.data))
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Loading the contract" />
      </div>
    );
  if (!version.data?.rulebook || version.data.status === "superseded")
    return (
      <div className="grid min-h-screen place-items-center p-8">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <p className="text-title font-semibold tracking-tight">Nothing to proofread yet</p>
          <p className="text-body text-muted">Once the contract has been read and checked, its numbers can be proofread here.</p>
          <Link href={`/studies/${id}`} className={btnCls("primary")}>
            Back to the contract
          </Link>
        </div>
      </div>
    );
  return <Proof key={`${id}/${pickV}`} study={study.data} version={version.data} />;
}

/** The whole row as one box: what the page view frames. */
const rowBox = (u: ProofUnit): [number, number, number, number] | null => {
  const b = u.cells.flatMap((c) => (c.box ? [c.box] : []));
  if (!b.length) return null;
  const x0 = Math.min(...b.map((x) => x[0]));
  const y0 = Math.min(...b.map((x) => x[1]));
  return [x0, y0, Math.max(...b.map((x) => x[0] + x[2])) - x0, Math.max(...b.map((x) => x[1] + x[3])) - y0];
};

const STATUS_ICON: Record<UnitStatus, React.ReactNode> = {
  todo: <span className="size-3.5 rounded-full ring-[1.5px] ring-line-strong" />,
  done: (
    <span className="grid size-4 place-items-center rounded-full bg-ok text-on-primary">
      <Check className="size-2.5" strokeWidth={3.5} />
    </span>
  ),
  reported: (
    <span className="grid size-4 place-items-center rounded-full bg-warn-soft text-warn ring-1 ring-warn/30">
      <Flag className="size-2.5" strokeWidth={2.5} />
    </span>
  ),
};

function Proof({ study, version }: { study: StudyDetailDto; version: RulebookVersionDto }) {
  const by = useActingAs();
  const invalidate = useInvalidateStudy();
  const proof = useProofread(study.id, version.version);
  const units = useMemo(() => proofUnits(version), [version]);
  const marks = useMemo(() => new Map((version.proofread ?? []).map((m) => [m.path, m])), [version.proofread]);
  const [reported, setReported] = useState<Set<string>>(() => new Set(version.review.filter((i) => i.reason === "reported" && i.path).map((i) => i.path!)));
  const [pick, setPick] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [toast, setToast] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const status = (u: ProofUnit) => unitStatus(u, marks, reported);
  const current = pick === "__done" ? null : ((pick ? units.find((u) => u.id === pick) : undefined) ?? units.find((u) => status(u) === "todo") ?? null);
  const totalValues = units.reduce((n, u) => n + u.cells.length, 0);
  const proofed = units.reduce((n, u) => n + u.cells.filter((c) => marks.has(c.path)).length, 0);

  const say = (msg: string) => {
    setToast(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  };
  const go = (id: string | null) => {
    setPick(id);
    setSelecting(false);
    setSelected(new Set());
    setListOpen(false);
  };
  /** Next unit still to do after `u`, wrapping round, judged with the marks just made. */
  const after = (u: ProofUnit, justMarked: string[], justReported: string[] = []) => {
    const m = new Map(marks);
    for (const p of justMarked) m.set(p, { path: p, by: by!, at: "" });
    const r = new Set([...reported, ...justReported]);
    const at = units.indexOf(u);
    return [...units.slice(at + 1), ...units.slice(0, at)].find((x) => unitStatus(x, m, r) === "todo")?.id ?? "__done";
  };

  const right = (u: ProofUnit) => {
    const paths = u.cells.map((c) => c.path);
    proof.mutate({ paths, by: by! }, { onSuccess: () => (say("Ticked as right"), go(after(u, paths))) });
  };

  // Each wrong value becomes a blind question in Needs you. On a live version the first report opens a correction
  // draft; the rest go to that draft, and so does a try again after a failure (`opened`). The values not picked are
  // ticked as right, unless an earlier try already sent them.
  const opened = useRef<RulebookVersionDto | null>(null);
  const wrong = useMutation({
    mutationFn: async ({ u, bad }: { u: ProofUnit; bad: string[] }) => {
      const v = await reportWrong(study.id, version, bad, by!, opened);
      const rest = u.cells.map((c) => c.path).filter((p) => !bad.includes(p) && !(opened.current && asked(opened.current, p)));
      if (rest.length) await proof.mutateAsync({ paths: rest, by: by! });
      return { u, bad, rest, draft: v };
    },
    onSuccess: ({ u, bad, rest, draft }) => {
      setReported((cur) => new Set([...cur, ...bad]));
      void invalidate(study.id);
      say(`${bad.length} ${bad.length === 1 ? "number" : "numbers"} sent to Needs you${draft !== version.version ? ` (version ${draft} opened to correct ${bad.length === 1 ? "it" : "them"})` : ""}`);
      go(after(u, rest, bad));
    },
  });

  const sections = (["terms", "totals", "rows"] as ProofSection[]).map((s) => ({ s, units: units.filter((u) => u.section === s) })).filter((x) => x.units.length);
  const live = version.status === "signed";
  const busy = proof.isPending || wrong.isPending;
  const isRow = current && current.cells.length > 1;

  const list = (
    <nav aria-label="What to proofread" className="flex flex-col gap-5 p-4">
      <div className="flex items-center justify-between px-2">
        <p className="text-body font-semibold">Proofread</p>
        <p className="num text-small text-muted">
          {units.filter((u) => status(u) !== "todo").length} of {units.length} done
        </p>
      </div>
      {sections.map(({ s, units: us }) => (
        <div key={s} className="flex flex-col gap-0.5">
          <p className="eyebrow px-2 pb-1.5">
            {SECTION_LABEL[s]} · {us.length}
          </p>
          {us.map((u) => {
            const active = u.id === current?.id;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => go(u.id)}
                aria-current={active ? "true" : undefined}
                className={cx("flex items-start gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors", active ? "bg-surface shadow-card ring-1 ring-ink/[0.06]" : "hover:bg-ink/[0.04]")}
              >
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center">{STATUS_ICON[status(u)]}</span>
                <span className="min-w-0">
                  <span className={cx("block truncate text-small", active ? "font-medium text-ink" : status(u) === "done" ? "text-faint" : "text-ink-2")}>{u.title}</span>
                  {u.cells.length > 1 && (
                    <span className="num block truncate text-caption text-faint">
                      {u.sub} · {u.cells.length} numbers
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface/90 px-4 backdrop-blur-md lg:px-5">
        <Link href={`/studies/${study.id}`} className="mr-auto flex min-w-0 items-center gap-2.5 md:mr-0" title="Back to the contract">
          <Image src="/dct-mark.png" alt="" width={26} height={26} />
          <span className="truncate text-body font-semibold tracking-tight">{study.protocol}</span>
          <Badge tone="ok">Proofread</Badge>
        </Link>
        <div className="mx-auto hidden items-center gap-3 md:flex">
          <span className="num text-small text-ink-2">
            {proofed.toLocaleString("en-US")} of {totalValues.toLocaleString("en-US")} numbers proofread
          </span>
          <span className="w-44">
            <ProgressBar value={totalValues ? (proofed / totalValues) * 100 : 100} label="Numbers proofread" />
          </span>
        </div>
        <Button size="sm" className="xl:hidden" aria-label="What to proofread" onClick={() => setListOpen(true)}>
          <ListChecks className="size-4" strokeWidth={1.75} /> <span className="hidden sm:inline">List</span>
        </Button>
        <Link href={`/studies/${study.id}`} className={btnCls("secondary", "sm")}>
          Save and exit
        </Link>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[264px_minmax(0,1fr)_400px]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-line bg-canvas/60 xl:block">{list}</aside>

        {!current ? (
          <section className="grid place-items-center p-8 lg:col-span-2">
            <div className="flex max-w-[520px] flex-col items-center gap-5 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
                <ShieldCheck className="size-7" strokeWidth={1.75} />
              </span>
              <div>
                <h1 className="text-display font-semibold tracking-tight">{units.length ? "Everything is proofread" : "Nothing to proofread"}</h1>
                <p className="mt-2 text-lead text-muted">
                  {units.length
                    ? `${proofed.toLocaleString("en-US")} numbers looked right${reported.size ? `, ${reported.size} sent to Needs you` : ""}. Thank you for checking.`
                    : "No number on this contract was confirmed against the PDF's text, so there's nothing to compare. Its questions cover everything."}
                </p>
              </div>
              <Link href={`/studies/${study.id}`} className={btnCls("primary", "lg")}>
                Back to the contract <ArrowRight className="size-[18px]" strokeWidth={2} />
              </Link>
            </div>
          </section>
        ) : (
          <>
            <section aria-label="The PDF and our numbers" className="flex h-[48vh] min-h-0 flex-col p-4 lg:h-auto lg:p-5">
              {isRow ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                  <RowCompare unit={current} selecting={selecting} selected={selected} onToggle={(p) => setSelected((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])))} />
                  {/* The page around the row, for the column headings and context. */}
                  <div className="min-h-[180px] flex-1">
                    <SpotView documents={study.documents} spot={{ documentId: current.doc, page: current.page, box: rowBox(current) }} zoom={zoom} onZoom={setZoom} />
                  </div>
                </div>
              ) : (
                <SpotView documents={study.documents} spot={{ documentId: current.doc, page: current.page, box: current.cells[0]!.box }} zoom={zoom} onZoom={setZoom} />
              )}
            </section>

            <section aria-label="Proofread" className="min-h-0 overflow-y-auto border-t border-line px-6 py-6 lg:border-t-0 lg:border-l">
              <Panel
                key={current.id}
                unit={current}
                index={units.indexOf(current)}
                total={units.length}
                status={status(current)}
                mark={marks.get(current.cells[0]!.path)}
                live={live}
                selecting={selecting}
                picked={selected.size}
                busy={busy}
                canAct={!!by}
                error={proof.error ?? wrong.error}
                onRight={() => right(current)}
                onWrong={() => (isRow ? setSelecting(true) : wrong.mutate({ u: current, bad: [current.cells[0]!.path] }))}
                onSend={() => wrong.mutate({ u: current, bad: [...selected] })}
                onCancel={() => (setSelecting(false), setSelected(new Set()))}
                onNext={() => go(after(current, []))}
              />
              {!by && (
                <div className="mt-4">
                  <NeedsPerson />
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Sheet open={listOpen} onClose={() => setListOpen(false)} label="What to proofread">
        <div className="flex justify-end p-2">
          <Button size="icon" variant="ghost" aria-label="Close the list" onClick={() => setListOpen(false)}>
            <X className="size-5" strokeWidth={1.75} />
          </Button>
        </div>
        {list}
      </Sheet>

      {toast && (
        <p role="status" className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-small font-medium text-surface shadow-raised">
          <CheckCircle2 className="size-4 text-ok-soft" strokeWidth={2} />
          {toast}
        </p>
      )}
    </div>
  );
}

function Panel(p: {
  unit: ProofUnit;
  index: number;
  total: number;
  status: UnitStatus;
  mark?: { by: string; at: string };
  live: boolean;
  selecting: boolean;
  picked: number;
  busy: boolean;
  canAct: boolean;
  error: unknown;
  onRight: () => void;
  onWrong: () => void;
  onSend: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const { unit: u } = p;
  const row = u.cells.length > 1;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">{SECTION_LABEL[u.section]}</Badge>
          {p.live && <Badge>Live contract</Badge>}
          <span className="num ml-auto text-small text-faint">
            {p.index + 1} of {p.total}
          </span>
        </div>
        <h1 className="text-title font-semibold tracking-tight text-balance">{u.title}</h1>
        {u.sub && (
          <p className="num text-small text-muted">
            {u.sub} · page {u.page}
          </p>
        )}
        <p className="flex items-start gap-2 text-small text-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {row
            ? `These ${u.cells.length} numbers already matched the PDF's own text. Compare our row with the PDF's row above it.`
            : "This number already matched the PDF's own text. Compare ours with the close-up."}
        </p>
      </div>

      {!row && (
        <div className="rounded-tile bg-sunken p-5">
          <p className="eyebrow">Ours</p>
          <p className="num mt-1 text-heading font-semibold tracking-tight">{formatValue(u.cells[0]!.path, u.cells[0]!.value)}</p>
        </div>
      )}

      {p.status === "done" && p.mark && (
        <p className="flex items-center gap-2 rounded-tile bg-ok-soft px-4 py-3 text-small text-ok">
          <CheckCircle2 className="size-4" strokeWidth={2} /> Proofread by {p.mark.by}
          {p.mark.at ? ` · ${relativeTime(p.mark.at)}` : ""}
        </p>
      )}
      {p.status === "reported" && <p className="rounded-tile bg-warn-soft px-4 py-3 text-small text-warn">Sent to Needs you. It&apos;s answered there, blind.</p>}

      {p.selecting ? (
        <div className="flex flex-col gap-4 rounded-tile bg-danger-soft/50 p-5 ring-1 ring-danger/20">
          <p className="text-body font-medium">Click the numbers in “Ours” that look wrong.</p>
          <p className="text-small text-muted">
            Each one becomes a question in Needs you, answered blind{p.live ? " on a correction draft; this live version stays in use until it's approved" : ""}. The numbers you don&apos;t pick are ticked as right.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" onClick={p.onCancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!p.picked || p.busy || !p.canAct} onClick={p.onSend}>
              {p.busy ? "Sending…" : p.picked ? `Send ${p.picked} to Needs you` : "Pick at least one number"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          {p.status === "todo" ? (
            <>
              <Button variant="ghost" disabled={p.busy || !p.canAct} onClick={p.onWrong}>
                <Flag className="size-4" strokeWidth={1.75} /> Something&apos;s wrong
              </Button>
              <Button variant="primary" size="lg" autoFocus disabled={p.busy || !p.canAct} onClick={p.onRight}>
                {p.busy ? "Saving…" : "Looks right"}
                {!p.busy && <CornerDownLeft className="size-4 opacity-80" strokeWidth={2} />}
              </Button>
            </>
          ) : (
            <Button variant="primary" className="ml-auto" onClick={p.onNext}>
              Next <ArrowRight className="size-4" strokeWidth={2} />
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={p.error} />
    </div>
  );
}
