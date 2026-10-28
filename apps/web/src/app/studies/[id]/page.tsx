"use client";

import type { ReviewItem, RulebookVersionDto, StudyDetailDto, VersionSummaryDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { ByHandForm } from "@/components/ByHandForm";
import { DiffView } from "@/components/DiffView";
import { RulebookView } from "@/components/RulebookView";
import { DocList } from "@/components/UploadDocs";
import { Badge, Button, Card, Dialog, ErrorNote, Field, PageTitle, pageCls, Spinner, StagePill, Stepper, btnCls, cx, inputBase, inputCls } from "@/components/ui";
import { Workspace } from "@/components/Workspace";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { formatDate, formatDateTime } from "@/lib/format";
import { keys, useDiff, useInvalidateStudy, useSettings, useStudy, useVersion } from "@/lib/queries";
import { approveState, KIND_LABEL, minutesFor, needsYou, pdfCheckLine, versionStage, type StageState } from "@/lib/review";

type Tab = "master" | "versions" | "files";

const VERSION_LABEL: Record<VersionSummaryDto["status"], string> = { extracting: "Reading", draft: "Draft", signed: "Live", superseded: "Replaced", failed: "Couldn't read" };

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const [tab, setTab] = useState<Tab>("master");
  const invalidate = useInvalidateStudy();
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

      <div role="tablist" aria-label="Contract" className="mt-7 mb-4 flex gap-0.5 border-b border-line">
        {(
          [
            ["master", "Invoicing master"],
            ["versions", `Versions (${s.versions.length})`],
            ["files", `Files (${s.documents.length})`],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px border-b-2 px-3.5 py-2.5 text-[14px]", tab === k ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "master" && <MasterTab study={s} />}
      {tab === "versions" && <VersionsTab study={s} />}
      {tab === "files" && (
        <div className="max-w-3xl">
          <DocList docs={s.documents} onChange={() => void invalidate(s.id)} />
          <p className="mt-2 text-xs text-muted">Changing a file&apos;s kind affects the next reading, not approved versions.</p>
        </div>
      )}
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

function Tile({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="rounded-card border border-line px-4 py-3.5">
      <p className={cx("num text-[26px] font-light", tone)}>{n}</p>
      <p className="text-[12.5px] text-ink-2">{label}</p>
    </div>
  );
}

function ApproveCard({ study, draft }: { study: StudyDetailDto; draft: RulebookVersionDto }) {
  const by = useActingAs();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const gate = approveState(draft, settings.data, by);
  const ev = (st: string) => draft.evidence.filter((e) => e.status === st).length;
  const cant = draft.review.filter((i) => i.outcome === "cant_tell");
  const byHand = draft.review.filter((i) => i.kind === "unclassified");
  const live = study.liveVersion;
  return (
    <Card className="flex flex-col gap-5 p-6">
      <CheckLine draft={draft} />
      <div>
        <p className="eyebrow mb-1">Approve</p>
        <h2 className="text-lg">Check the summary, then approve</h2>
        <p className="mt-1 text-[13px] text-muted">Approving makes this the invoicing master everyone bills from. It&apos;s then locked; later changes go through a new version.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {draft.byHand ? (
          <>
            <Tile n={ev("attested")} label="values typed by hand" tone="text-accent" />
            <Tile n={draft.review.filter((i) => i.reason === "spot_check" && i.outcome === "matched").length} label="re-typed blind and matched" tone="text-ok" />
          </>
        ) : (
          <>
            <Tile n={ev("confirmed")} label={draft.pdfCheck ? "numbers match the PDF" : "numbers add up in the contract's own totals"} tone="text-ok" />
            <Tile n={ev("attested")} label="numbers confirmed by people" tone="text-accent" />
          </>
        )}
        <Tile n={cant.length} label="couldn't tell" tone={cant.length ? "text-warn" : undefined} />
        <Tile n={byHand.length} label={byHand.length === 1 ? "term to bill by hand" : "terms to bill by hand"} />
      </div>
      {cant.length > 0 && (
        <ItemList title="Couldn't tell">
          {cant.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {i.question} {i.blocking && <Badge tone="warn">needed to approve</Badge>}
              </span>
              <Link href={`/studies/${study.id}/review?item=${encodeURIComponent(i.id)}`} className="text-accent hover:underline">
                Answer now
              </Link>
            </li>
          ))}
        </ItemList>
      )}
      {byHand.length > 0 && (
        <ItemList title="To bill by hand">
          {byHand.map((i) => (
            <li key={i.id}>{i.question.replace(/ The invoicing master has no place.*$/, "")}</li>
          ))}
        </ItemList>
      )}
      {live && live < draft.version && <AmendmentChanges study={study} version={draft.version} against={live} />}
      {settings.data?.makerChecker && draft.editors.length > 0 && !gate.reasons.some((r) => r.startsWith("Maker-checker")) && (
        <p className="text-[13px] text-muted">Maker-checker is on: {draft.editors.join(", ")} answered questions here, so someone else has to approve.</p>
      )}
      {!gate.allowed && <p id="approve-why" className="text-[13px] text-warn">Can&apos;t approve yet: {gate.reasons.join(" ")}</p>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!gate.allowed} onClick={() => setOpen(true)} aria-describedby={gate.allowed ? undefined : "approve-why"}>
          Approve invoicing master
        </Button>
      </div>
      <ApproveDialog open={open} onClose={() => setOpen(false)} study={study} draft={draft} />
    </Card>
  );
}

function ItemList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="eyebrow mb-2">{title}</h3>
      <ul className="flex flex-col gap-2 rounded-[10px] bg-sunken px-4 py-3 text-[13px]">{children}</ul>
    </div>
  );
}

function AmendmentChanges({ study, version, against }: { study: StudyDetailDto; version: number; against: number }) {
  const diff = useDiff(study.id, version, against);
  return (
    <details className="rounded-[10px] border border-line px-4 py-3">
      <summary className="cursor-pointer text-[13px]">What changes compared with live version {against}</summary>
      <div className="mt-3">{diff.data ? <DiffView entries={diff.data} /> : diff.error ? <ErrorNote error={diff.error} /> : <Spinner />}</div>
    </details>
  );
}

function ApproveDialog({ open, onClose, study, draft }: { open: boolean; onClose: () => void; study: StudyDetailDto; draft: RulebookVersionDto }) {
  const by = useActingAs();
  const router = useRouter();
  const invalidate = useInvalidateStudy();
  const [note, setNote] = useState("");
  const approve = useMutation({
    mutationFn: () => api.signOff(study.id, draft.version, { by: by!, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async () => {
      await invalidate(study.id);
      onClose();
      router.replace(`/studies/${study.id}?approved=${draft.version}`);
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Approve ${study.protocol ?? "this contract"}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          approve.mutate();
        }}
      >
        <p className="text-[13px] text-muted">
          {by} approves version {draft.version} as the invoicing master for {study.sponsor}. Your name, the time and your note go in the activity log.
        </p>
        <Field label="Note (optional)" htmlFor="ap-note">
          <textarea id="ap-note" rows={3} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the next person should know" />
        </Field>
        <ErrorNote error={approve.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={approve.isPending}>
            {approve.isPending ? "Approving…" : "Approve and make live"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The live version, or the draft until one is approved. */
function MasterTab({ study }: { study: StudyDetailDto }) {
  const withMaster = study.versions.filter((v) => v.status !== "failed" && v.status !== "extracting").sort((a, b) => b.version - a.version);
  const [picked, setPicked] = useState<number | null>(null);
  const v = picked ?? study.liveVersion ?? withMaster[0]?.version ?? null;
  const version = useVersion(study.id, v);
  if (v === null) return <p className="text-[13px] text-muted">The invoicing master appears here once the contract has been read.</p>;
  if (!version.data) return version.error ? <ErrorNote error={version.error} /> : <Spinner />;
  const meta = study.versions.find((x) => x.version === v);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-2">
          <span className="text-muted">Version</span>
          <select className={cx(inputBase, "w-auto py-1.5")} value={v} onChange={(e) => setPicked(Number(e.target.value))}>
            {withMaster.map((x) => (
              <option key={x.version} value={x.version}>
                Version {x.version} · {VERSION_LABEL[x.status]}
              </option>
            ))}
          </select>
        </label>
        {meta?.signedBy && (
          <span className="text-muted">
            Approved by {meta.signedBy} · {formatDateTime(meta.signedAt)}
          </span>
        )}
        {meta?.appliesFrom && <span className="text-muted">Applies from {formatDate(meta.appliesFrom)}</span>}
        {meta?.status === "draft" && <span className="text-muted">Draft, not approved yet. Values with an open question show “needs you”.</span>}
      </div>
      {version.data.byHand && version.data.status === "draft" && !version.data.review.length ? (
        <ByHandForm study={study} version={version.data} />
      ) : (
        <Workspace study={study} version={version.data} report>
          <RulebookView />
        </Workspace>
      )}
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
