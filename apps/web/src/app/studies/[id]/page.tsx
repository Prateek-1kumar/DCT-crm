"use client";

import type { MasterSection, ReviewItem, RulebookVersionDto, StudyDetailDto, VersionSummaryDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BadgeCheck, ChevronDown, Download, FileSpreadsheet, Printer, Search, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { ByHandForm } from "@/components/ByHandForm";
import { DiffView } from "@/components/DiffView";
import { DotLegend, useRulebook } from "@/components/review-context";
import { RulebookView, type MasterPart } from "@/components/RulebookView";
import { DocList } from "@/components/UploadDocs";
import { Badge, Button, Card, ErrorNote, PageTitle, pageCls, Spinner, StagePill, Stepper, btnCls, cx, inputBase } from "@/components/ui";
import { Workspace } from "@/components/Workspace";
import { api } from "@/lib/api";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { keyTerms } from "@/lib/approve";
import { formatDate, formatDateTime } from "@/lib/format";
import { keys, useDiff, useInvalidateStudy, useMasterSearch, useStudy, useVersion } from "@/lib/queries";
import { KIND_LABEL, minutesFor, needsYou, pdfCheckLine, versionStage, type StageState } from "@/lib/review";

type Tab = "overview" | "grid" | "fees" | "terms" | "documents" | "history";
const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["grid", "Budget grid"],
  ["fees", "Fees & invoiceables"],
  ["terms", "Payment terms"],
  ["documents", "Documents"],
  ["history", "History"],
];
const PART: Partial<Record<Tab, MasterPart>> = { grid: "grid", fees: "fees", terms: "terms" };
const SECTION_TAB: Record<MasterSection, Tab> = { grid: "grid", fees: "fees", invoiceables: "fees", terms: "terms" };
const tabOf = (path: string): Tab =>
  path.startsWith("/budgetGrids") ? "grid" : /^\/(siteFees|invoiceables|screenFail)/.test(path) ? "fees" : /^\/(study|referencedDocuments)/.test(path) ? "documents" : "terms";

/** A search hit is an item (a grid row, a fee, a term); this is the value that opens for it. */
const TERM_VALUE: Record<string, string> = {
  "/payment": "/payment/netDays/value",
  "/holdback": "/holdback/pct",
  "/overhead": "/overhead/pct/value",
  "/screenFail": "/screenFail/amountCents",
  "/overpayment": "/overpayment/refundDays",
  "/rounding": "/rounding/value",
  "/appliesFrom": "/appliesFrom/value",
};
const valueOf = (path: string) =>
  TERM_VALUE[path] ??
  (/\/procedures\/\d+$/.test(path) ? `${path}/unitCents` : /\/visits\/\d+$/.test(path) ? `${path}/totalCents` : /^\/(siteFees|invoiceables)\/\d+$/.test(path) ? `${path}/amountCents` : /^\/deadlines\/\d+$/.test(path) ? `${path}/value` : path);

const VERSION_LABEL: Record<VersionSummaryDto["status"], string> = { extracting: "Reading", draft: "Draft", signed: "Live", superseded: "Replaced", failed: "Couldn't read" };

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const latest = study.data ? [...study.data.versions].sort((a, b) => b.version - a.version)[0] : undefined;
  const draft = useVersion(id, latest?.status === "draft" ? latest.version : null);

  if (study.error) return <div className="p-6"><ErrorNote error={study.error} /></div>;
  if (!study.data || (latest?.status === "draft" && !draft.data)) return <div className="p-6"><Spinner /></div>;
  const s = study.data;
  const stage = versionStage(latest, draft.data);
  const approved = sp.get("approved");
  const corrected = sp.get("corrected");
  const amending = !!s.liveVersion && stage.stage !== "Live";

  return (
    <div className={pageCls}>
      <p className="mb-3 text-[13px]">
        <Link href="/" className="text-muted hover:text-ink">
          ← Contracts
        </Link>
      </p>
      <PageTitle
        eyebrow={`${s.sponsor ?? "Sponsor not confirmed yet"} · ${s.siteName ?? "No site yet"}`}
        title={
          <>
            {s.protocol ?? "New contract"} <span className="text-[18px] text-muted">{s.investigator}</span>
          </>
        }
        actions={
          <>
            {(stage.stage === "Needs you" || stage.stage === "Approve" || stage.stage === "Live") && !stage.byHand && (
              <Link href={`/studies/${s.id}/proofread`} className={btnCls()}>
                Proofread
              </Link>
            )}
            {stage.stage === "Live" && (
              <Link href={`/studies/${s.id}/amend`} className={btnCls()}>
                Upload amendment
              </Link>
            )}
            <Link href={`/audit?studyId=${s.id}`} className={btnCls("ghost")}>
              Activity
            </Link>
          </>
        }
      />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2">
        <StagePill state={stage} />
        {s.liveVersion && <Badge tone="ok">Live: version {s.liveVersion}</Badge>}
        {amending && <span className="text-[13px] text-muted">A new version is in progress. Version {s.liveVersion} stays live until it&apos;s approved.</span>}
      </div>
      <Stepper state={stage} className="mb-6" />
      {approved && (
        <p role="status" className="mb-5 rounded-[10px] bg-ok-soft px-4 py-2.5 text-[13px] text-ok">
          ✓ Approved. Version {approved} is now the live invoicing master.
        </p>
      )}
      {corrected && stage.stage !== "Live" && (
        <p role="status" className="mb-5 rounded-[10px] bg-accent-soft px-4 py-2.5 text-[13px] text-accent">
          Thanks. Version {corrected} is open to correct it; version {s.liveVersion} stays live until version {corrected} is approved.
        </p>
      )}
      <StageCard study={s} stage={stage} draft={draft.data} />

      <Master study={s} />
    </div>
  );
}

function StageCard({ study, stage, draft }: { study: StudyDetailDto; stage: StageState; draft: RulebookVersionDto | undefined }) {
  if (stage.stage === "Upload")
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <p>The files are in. Check the study details, then start reading.</p>
        <Link href={`/studies/new?study=${encodeURIComponent(study.id)}`} className={btnCls("primary")}>
          Continue →
        </Link>
      </Card>
    );
  if (!draft && stage.stage === "Reading") return stage.failed ? <FailedCard study={study} /> : <Card className="p-5"><Spinner label="Reading the contract. This page updates by itself" /></Card>;
  if (!draft) return null;
  if (stage.byHand && stage.stage === "Reading") return <TypingCard study={study} draft={draft} />;
  if (stage.stage === "Approve") return <ApproveCard study={study} draft={draft} />;
  const open = needsYou(draft.review);
  const kinds = new Map<ReviewItem["kind"], number>();
  for (const i of open) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  return (
    <Card className="flex flex-col gap-4 p-6">
      <CheckLine draft={draft} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1">Needs you</p>
          <p className="text-lg">
            {open.length} {open.length === 1 ? "question" : "questions"} <span className="text-muted">· about {minutesFor(open.length)} min</span>
          </p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {[...kinds].map(([k, n]) => (
              <Badge key={k}>
                {KIND_LABEL[k]} · {n}
              </Badge>
            ))}
          </p>
        </div>
        <Link href={`/studies/${study.id}/review`} className={btnCls("primary")}>
          {open.length < draft.review.length ? "Continue answering →" : "Start answering →"}
        </Link>
      </div>
    </Card>
  );
}

function CheckLine({ draft }: { draft: RulebookVersionDto }) {
  const { pdfCheck, byHand } = draft;
  const good = pdfCheck || byHand;
  const sample = draft.review.filter((i) => i.reason === "spot_check").length;
  return (
    <p className={cx("flex items-start gap-2 rounded-[10px] px-3.5 py-2.5 text-[13px]", good ? "bg-ok-soft" : "bg-warn-soft")}>
      <span aria-hidden className={good ? "text-ok" : "text-warn"}>
        {good ? "✓" : "!"}
      </span>
      <span>
        <span className="eyebrow mr-2">{byHand ? "Typed by hand" : "Checking"}</span>
        {byHand
          ? `Someone who didn't type it re-types ${sample} of the values without seeing them, to catch typos.`
          : `${pdfCheckLine(pdfCheck)}${pdfCheck ? "." : ""}`}
      </span>
    </p>
  );
}

/** A contract being typed in by hand: the form is below; this marks it done. */
function TypingCard({ study, draft }: { study: StudyDetailDto; draft: RulebookVersionDto }) {
  const by = useActingAs();
  const qc = useQueryClient();
  const invalidate = useInvalidateStudy();
  const typed = draft.evidence.length;
  const done = useMutation({
    mutationFn: () => api.finishByHand(study.id, draft.version, by!),
    onSuccess: async (dto) => {
      qc.setQueryData(keys.version(study.id, draft.version), dto);
      await invalidate(study.id);
    },
  });
  return (
    <Card className="flex flex-wrap items-end justify-between gap-4 p-6">
      <div className="max-w-[70ch]">
        <p className="eyebrow mb-1">Typed by hand</p>
        <p className="text-lg">Type what the contract says into the invoicing master below</p>
        <p className="mt-1 text-[13px] text-muted">
          Leave anything the contract doesn&apos;t mention empty. Each value is saved when you leave its box. When you&apos;re done, someone else re-types 10
          of them without seeing them, to catch typos.
        </p>
        <p className="mt-2 text-[13px]">
          {typed} {typed === 1 ? "value" : "values"} typed so far
        </p>
      </div>
      <div className="flex flex-col items-end gap-2">
        <Button variant="primary" disabled={!by || !typed || done.isPending} onClick={() => done.mutate()}>
          {done.isPending ? "Saving…" : "I'm done typing →"}
        </Button>
        {!by && <NeedsPerson />}
        <ErrorNote error={done.error} />
      </div>
    </Card>
  );
}

function FailedCard({ study }: { study: StudyDetailDto }) {
  const by = useActingAs();
  const router = useRouter();
  const invalidate = useInvalidateStudy();
  const retry = useMutation({
    mutationFn: () => api.extract(study.id, by!),
    onSuccess: (r) => router.push(`/studies/${study.id}/reading?job=${encodeURIComponent(r.jobId)}&v=${r.version}`),
  });
  const byHand = useMutation({ mutationFn: () => api.startByHand(study.id, by!), onSuccess: () => invalidate(study.id) });
  return (
    <Card className="flex flex-wrap items-center gap-3 p-5">
      <p className="text-danger">We couldn&apos;t read this contract. A clearer copy, ideally the e-signed PDF, usually fixes it. Or type it in by hand.</p>
      <div className="ml-auto flex gap-2">
        <Button disabled={!by || byHand.isPending} onClick={() => byHand.mutate()}>
          Type it in by hand
        </Button>
        <Button variant="primary" disabled={!by || retry.isPending} onClick={() => retry.mutate()}>
          Read it again
        </Button>
      </div>
      {!by && <NeedsPerson />}
      <ErrorNote error={retry.error ?? byHand.error} />
    </Card>
  );
}

/** Ready for approval: a short summary and the way to the approval page. */
function ApproveCard({ study, draft }: { study: StudyDetailDto; draft: RulebookVersionDto }) {
  const ev = (st: string) => draft.evidence.filter((e) => e.status === st).length;
  const cant = draft.review.filter((i) => i.outcome === "cant_tell").length;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-5 p-6">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-tile bg-brand-soft text-accent">
          <BadgeCheck className="size-5" strokeWidth={1.75} />
        </span>
        <div>
          <p className="text-title font-semibold tracking-tight">Ready for approval</p>
          <p className="num text-small text-muted">
            {draft.pdfCheck ? `${ev("confirmed").toLocaleString("en-US")} matched the PDF · ` : ""}
            {ev("attested")} confirmed by people{cant ? ` · ${cant} couldn't tell` : ""}
          </p>
        </div>
      </div>
      <Link href={`/studies/${study.id}/approve`} className={btnCls("primary", "lg")}>
        Review and approve <ArrowRight className="size-[18px]" strokeWidth={2} />
      </Link>
    </Card>
  );
}
/** The invoicing master in tabs, with a search over it, the drawer for any value, and the export. */
function Master({ study }: { study: StudyDetailDto }) {
  const sp = useSearchParams();
  const router = useRouter();
  const invalidate = useInvalidateStudy();
  const withMaster = study.versions.filter((x) => x.status !== "failed" && x.status !== "extracting").sort((a, b) => b.version - a.version);
  const [picked, setPicked] = useState<number | null>(Number(sp.get("v")) || null);
  const v = picked ?? study.liveVersion ?? withMaster[0]?.version ?? null;
  const version = useVersion(study.id, v);
  const [want, setWant] = useState<{ path: string; n: number } | null>(() => {
    const f = sp.get("focus");
    return f ? { path: valueOf(f), n: 0 } : null;
  });
  const tab = (TABS.find(([k]) => k === sp.get("tab"))?.[0] ?? (want ? tabOf(want.path) : "overview")) as Tab;
  const setTab = (t: Tab) => {
    const p = new URLSearchParams(sp);
    p.set("tab", t);
    p.delete("focus");
    router.replace(`/studies/${study.id}?${p}`, { scroll: false });
  };
  const [text, setText] = useState("");
  const found = useMasterSearch(study.id, v, text);
  const hits = useMemo(() => new Set(text.trim() && found.data ? found.data.hits.map((h) => h.path) : []), [found.data, text]);
  const open = (path: string, t: Tab) => {
    setTab(t);
    setWant((w) => ({ path: valueOf(path), n: (w?.n ?? 0) + 1 }));
  };

  const meta = study.versions.find((x) => x.version === v);
  const rb = version.data?.rulebook;
  const typing = !!version.data?.byHand && version.data.status === "draft" && !version.data.review.length;
  const tabs = typing ? [["overview", "Type it in"] as [Tab, string], ...TABS.slice(4)] : TABS;
  const shown = typing && PART[tab] ? "overview" : tab;

  const body = () => {
    if (shown === "history") return <VersionsTab study={study} />;
    if (shown === "documents")
      return (
        <div className="flex flex-col gap-5">
          {rb && <RulebookView part="details" />}
          <section className="rounded-card bg-surface p-5 ring-1 ring-line">
            <h3 className="mb-3 text-body font-semibold tracking-tight">Files ({study.documents.length})</h3>
            <DocList docs={study.documents} onChange={() => void invalidate(study.id)} />
            <p className="mt-2 text-caption text-muted">Changing a file&apos;s kind affects the next reading, not approved versions.</p>
          </section>
        </div>
      );
    if (v === null) return <p className="text-small text-muted">The invoicing master appears here once the contract has been read.</p>;
    if (!version.data) return version.error ? <ErrorNote error={version.error} /> : <Spinner />;
    if (typing) return <ByHandForm study={study} version={version.data} />;
    if (shown === "overview") return <Overview study={study} version={version.data} />;
    return <RulebookView part={PART[shown]!} />;
  };

  return (
    <div className="mt-8 flex flex-col gap-4">
      {rb && !typing && (
        <div className="flex flex-wrap items-center gap-3">
          {withMaster.length > 1 && (
            <label className="flex items-center gap-2 text-small">
              <span className="text-muted">Version</span>
              <select className={cx(inputBase, "w-auto")} value={v ?? ""} onChange={(e) => setPicked(Number(e.target.value))}>
                {withMaster.map((x) => (
                  <option key={x.version} value={x.version}>
                    Version {x.version} · {VERSION_LABEL[x.status]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-small text-muted">
            {meta?.status === "signed" && meta.signedBy ? `Approved by ${meta.signedBy} · ${formatDate(meta.signedAt)}` : meta?.status === "draft" ? "Draft, not approved yet" : `Version ${v}`}
            {meta?.appliesFrom && ` · applies from ${formatDate(meta.appliesFrom)}`}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search this contract</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
              <input
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search this contract"
                title="A procedure, a fee, a term or an amount, like ECG, 98.00 or holdback"
                className="h-10 w-72 max-w-full rounded-full bg-surface pr-4 pl-9 text-small shadow-button ring-1 ring-line-strong placeholder:text-faint hover:ring-ink/20 focus:ring-4 focus:ring-brand/20 focus:outline-none"
              />
            </label>
            {v !== null && (meta?.status === "signed" || meta?.status === "superseded") && <ExportMenu study={study} version={v} />}
          </div>
        </div>
      )}

      {text.trim() && found.data && (
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          <span className="text-small text-muted">{found.data.hits.length ? `${found.data.hits.length} ${found.data.hits.length === 1 ? "match" : "matches"}:` : `Nothing in this contract matches “${text.trim()}”.`}</span>
          {found.data.hits.slice(0, 12).map((h) => (
            <button
              key={h.path}
              type="button"
              onClick={() => open(h.path, SECTION_TAB[h.section])}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-brand-soft px-3 text-small text-accent ring-1 ring-brand/20 hover:ring-brand/50"
            >
              {h.label}
              <span className="text-caption text-faint">{TABS.find(([k]) => k === SECTION_TAB[h.section])![1]}</span>
            </button>
          ))}
          {found.data.hits.length > 12 && <span className="text-small text-faint">and {found.data.hits.length - 12} more; type more of the name</span>}
          <Button size="sm" variant="ghost" onClick={() => setText("")}>
            <X className="size-3.5" strokeWidth={2} /> Clear
          </Button>
        </div>
      )}

      <div role="tablist" aria-label="Invoicing master" className="flex gap-0.5 overflow-x-auto border-b border-line [scrollbar-width:none]">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={shown === k}
            onClick={() => setTab(k)}
            className={cx(
              "-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-body whitespace-nowrap transition-colors",
              shown === k ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {l}
            {k === "history" && <span className="num ml-1.5 text-caption text-faint">{study.versions.length}</span>}
          </button>
        ))}
      </div>
      {PART[shown] && rb && <DotLegend />}

      <div role="tabpanel">
        {version.data?.rulebook ? (
          <Workspace study={study} version={version.data} report hits={hits} focus={want}>
            {body()}
          </Workspace>
        ) : (
          body()
        )}
      </div>
    </div>
  );
}

/** The terms that decide most of the money, each opening its spot in the contract, and how the numbers were checked. */
function Overview({ study, version }: { study: StudyDetailDto; version: RulebookVersionDto }) {
  const { rulebook: rb, show, masked } = useRulebook();
  const terms = keyTerms(rb, version.evidence);
  const count = (st: string) => version.evidence.filter((e) => e.status === st).length;
  const numbers = version.evidence.length;
  const proofread = version.proofread?.length ?? 0;
  return (
    <div className="flex flex-col gap-5">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {terms.map((t) => {
          const hidden = t.paths.some((p) => masked.has(p));
          const path = t.paths[0];
          const inner = (
            <>
              <span className="text-small text-muted">{t.label}</span>
              <span className={cx("num block text-title font-semibold tracking-tight", hidden && "text-warn")}>{hidden ? "Needs you" : t.value}</span>
              {t.detail && !hidden && <span className="mt-0.5 block text-small text-muted">{t.detail}</span>}
            </>
          );
          return (
            <li key={t.id}>
              {path ? (
                <button
                  type="button"
                  data-path={path}
                  onClick={() => show(path, null, t.label)}
                  className="flex h-full w-full flex-col items-start rounded-tile bg-surface p-4 text-left ring-1 ring-line transition hover:shadow-card hover:ring-brand/40"
                >
                  {inner}
                  <span className="mt-auto block pt-2 text-caption text-accent">Show in the contract</span>
                </button>
              ) : (
                <div className="h-full rounded-tile bg-sunken/70 p-4 ring-1 ring-line">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>

      {numbers > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-surface p-5 ring-1 ring-line">
          <div>
            <h3 className="text-body font-semibold tracking-tight">How the numbers were checked</h3>
            <p className="num mt-1 text-small text-muted">
              {count("confirmed").toLocaleString("en-US")} of {numbers.toLocaleString("en-US")} match the PDF · {count("attested")} confirmed by a person
              {count("conflict") + count("ungrounded") > 0 && ` · ${count("conflict") + count("ungrounded")} still need you`}
              {` · ${proofread} proofread by someone`}
            </p>
          </div>
          {!version.byHand && version.status !== "superseded" && (
            <Link href={`/studies/${study.id}/proofread`} className={btnCls("secondary", "sm")}>
              Proofread
            </Link>
          )}
        </section>
      )}
    </div>
  );
}

/** Excel for billing systems; a printable summary (save as PDF) for people. */
function ExportMenu({ study, version }: { study: StudyDetailDto; version: number }) {
  const by = useActingAs();
  const [open, setOpen] = useState(false);
  const xlsx = useMutation({ mutationFn: () => api.exportXlsx(study.id, version, by!) });
  const item = "flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-sunken";
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Button aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <Download className="size-4" strokeWidth={1.75} /> Export <ChevronDown className="size-4" strokeWidth={2} />
      </Button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-30 mt-2 w-72 rounded-tile bg-surface p-1.5 shadow-raised ring-1 ring-ink/[0.08]">
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              if (!by) return askForPerson();
              xlsx.mutate();
            }}
          >
            <FileSpreadsheet className="mt-0.5 size-[18px] shrink-0 text-ok" strokeWidth={1.75} />
            <span>
              <span className="block text-body font-medium">Excel spreadsheet</span>
              <span className="block text-small text-muted">Budget grid, fees and terms, one sheet each</span>
            </span>
          </button>
          <a role="menuitem" href={`/studies/${study.id}/print?v=${version}`} target="_blank" rel="noreferrer" className={item} onClick={() => setOpen(false)}>
            <Printer className="mt-0.5 size-[18px] shrink-0 text-muted" strokeWidth={1.75} />
            <span>
              <span className="block text-body font-medium">PDF summary</span>
              <span className="block text-small text-muted">Key terms and rates, ready to print or save</span>
            </span>
          </a>
        </div>
      )}
      <ErrorNote error={xlsx.error} />
    </div>
  );
}

function VersionsTab({ study }: { study: StudyDetailDto }) {
  const vs = [...study.versions].sort((a, b) => b.version - a.version);
  const comparable = vs.filter((v) => v.status !== "failed" && v.status !== "extracting");
  const [to, setTo] = useState<number | null>(comparable[0]?.version ?? null);
  const [from, setFrom] = useState<number | null>(comparable[1]?.version ?? null);
  const diff = useDiff(study.id, to, from);
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-sunken text-left">
            <tr>
              {["Version", "Stage", "Created", "Approved", "Applies from", ""].map((h) => (
                <th key={h} scope="col" className="eyebrow px-4 py-2.5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vs.map((v, i) => (
              <tr key={v.version} className="border-t border-line">
                <td className="num px-4 py-2.5">Version {v.version}</td>
                <td className="px-4 py-2.5">
                  <Badge dot tone={v.status === "signed" ? "ok" : v.status === "draft" ? "warn" : v.status === "failed" ? "danger" : "neutral"}>
                    {VERSION_LABEL[v.status]}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{formatDateTime(v.createdAt)}</td>
                <td className="px-4 py-2.5">{v.signedBy ? `${v.signedBy} · ${formatDate(v.signedAt)}` : <span className="text-faint">—</span>}</td>
                <td className="px-4 py-2.5">{formatDate(v.appliesFrom)}</td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {v.status === "draft" && (
                    <Link href={`/studies/${study.id}/review?v=${v.version}`} className="text-accent hover:underline">
                      Answer questions
                    </Link>
                  )}
                  {vs[i + 1] && comparable.some((c) => c.version === v.version) && (
                    <button type="button" className="ml-3 text-accent hover:underline" onClick={() => (setTo(v.version), setFrom(comparable.find((c) => c.version < v.version)?.version ?? null))}>
                      Changes vs previous
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div>
        <h2 className="mb-3 text-lg">Compare versions</h2>
        {comparable.length < 2 ? (
          <p className="text-[13px] text-muted">There is only one version so far. Changes show here once an amendment has been read.</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
              <VersionSelect label="From" value={from} onChange={setFrom} options={comparable} />
              <span className="text-faint">→</span>
              <VersionSelect label="To" value={to} onChange={setTo} options={comparable} />
            </div>
            {from === to ? (
              <p className="text-[13px] text-muted">Pick two different versions.</p>
            ) : diff.data ? (
              <DiffView entries={diff.data} title={`Version ${from} → ${to}`} />
            ) : diff.error ? (
              <ErrorNote error={diff.error} />
            ) : (
              <Spinner />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function VersionSelect({ label, value, onChange, options }: { label: string; value: number | null; onChange: (n: number) => void; options: VersionSummaryDto[] }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <select className={cx(inputBase, "w-auto py-1.5")} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => (
          <option key={o.version} value={o.version}>
            Version {o.version} · {VERSION_LABEL[o.status]}
          </option>
        ))}
      </select>
    </label>
  );
}
