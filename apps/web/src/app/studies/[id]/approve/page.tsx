"use client";

import { settled, type ReviewItem, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BadgeCheck, Check, CircleHelp, Eye, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { DiffView } from "@/components/DiffView";
import { initials, NeedsPerson } from "@/components/Sidebar";
import { SpotView, DEFAULT_ZOOM } from "@/components/SpotView";
import { Badge, Button, btnCls, cx, Dialog, ErrorNote, fieldCls, inputCls, PageTitle, pageCls, Spinner, Stepper } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { keyTerms, type KeyTerm } from "@/lib/approve";
import { formatValue, relativeTime } from "@/lib/format";
import { keys, useDiff, useInvalidateStudy, useSettings, useStudy, useVersion } from "@/lib/queries";
import { approveState, formatAnswer, queueOrder, versionStage } from "@/lib/review";

export default function ApprovePage() {
  const { id } = useParams<{ id: string }>();
  const study = useStudy(id);
  const draft = study.data ? [...study.data.versions].sort((a, b) => b.version - a.version).find((v) => v.status === "draft") : undefined;
  const version = useVersion(id, draft?.version ?? null);

  if (study.error || version.error)
    return (
      <div className={pageCls}>
        <ErrorNote error={study.error ?? version.error} />
      </div>
    );
  if (!study.data || (draft && !version.data))
    return (
      <div className={pageCls}>
        <Spinner />
      </div>
    );
  if (!draft || !version.data?.rulebook)
    return (
      <div className={`${pageCls} max-w-[720px]`}>
        <div className="flex flex-col items-start gap-4 rounded-card bg-surface p-8 shadow-card ring-1 ring-ink/[0.05]">
          <p className="text-title font-semibold tracking-tight">Nothing waiting for approval</p>
          <p className="text-body text-muted">{study.data.liveVersion ? `Version ${study.data.liveVersion} is live and in use.` : "This contract hasn't been read and checked yet."}</p>
          <Link href={`/studies/${id}`} className={btnCls("primary")}>
            Back to the contract
          </Link>
        </div>
      </div>
    );
  return <Approve key={`${id}/${draft.version}`} study={study.data} version={version.data} />;
}

type Step = 1 | 2 | 3;

function Approve({ study, version }: { study: StudyDetailDto; version: RulebookVersionDto }) {
  const by = useActingAs();
  const settings = useSettings();
  const rb = version.rulebook!;
  const terms = useMemo(() => keyTerms(rb, version.evidence), [rb, version.evidence]);
  const order = useMemo(() => queueOrder(version.review), [version.review]);
  const open = order.filter((i) => i.blocking && !settled(i));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>(open.length ? 1 : 2);
  const [approved, setApproved] = useState<number | null>(null);
  const answersOk = open.length === 0;
  const termsOk = ticked.size === terms.length;
  const done: Record<Step, boolean> = { 1: answersOk, 2: termsOk, 3: approved !== null };

  if (approved !== null) return <Approved study={study} version={approved} />;

  return (
    <div className={pageCls}>
      <Link href={`/studies/${study.id}`} className="mb-5 inline-flex items-center gap-1.5 text-small text-muted hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={2} /> {study.protocol}
      </Link>
      <PageTitle
        eyebrow={[study.sponsor, study.siteName].filter(Boolean).join(" · ")}
        title="Review and approve"
        sub="Approving makes this the invoicing master everyone bills from. After that it's locked: changes go through a correction or an amendment."
      />
      <Stepper state={versionStage(version, version)} className="mb-9" />

      <div className="grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
          <nav aria-label="Approval steps" className="flex flex-col gap-1">
            {(
              [
                [1, "Check the answers", answersOk ? `${order.length} answered` : `${open.length} still open`],
                [2, "Check the key terms", `${ticked.size} of ${terms.length} ticked`],
                [3, "Approve", answersOk && termsOk ? "Ready" : "After steps 1 and 2"],
              ] as [Step, string, string][]
            ).map(([n, label, sub]) => (
              <button
                key={n}
                type="button"
                onClick={() => setStep(n)}
                aria-current={step === n ? "step" : undefined}
                className={cx("flex items-center gap-3 rounded-tile px-3 py-2.5 text-left transition-colors", step === n ? "bg-surface shadow-card ring-1 ring-ink/[0.06]" : "hover:bg-ink/[0.04]")}
              >
                <span
                  className={cx(
                    "grid size-7 shrink-0 place-items-center rounded-full text-small font-semibold",
                    done[n] ? "bg-ok-soft text-ok" : step === n ? "bg-primary text-on-primary" : "bg-ink/[0.06] text-faint",
                  )}
                >
                  {done[n] ? <Check className="size-3.5" strokeWidth={2.5} /> : n}
                </span>
                <span>
                  <span className={cx("block text-body", step === n ? "font-medium text-ink" : "text-ink-2")}>{label}</span>
                  <span className="block text-small text-faint">{sub}</span>
                </span>
              </button>
            ))}
          </nav>
          <Summary version={version} />
        </aside>

        <section className="min-w-0 rounded-card bg-surface p-7 shadow-card ring-1 ring-ink/[0.05]">
          {step === 1 && <Answers study={study} version={version} order={order} open={open} onNext={() => setStep(2)} />}
          {step === 2 && (
            <Terms
              study={study}
              terms={terms}
              ticked={ticked}
              onTick={(id) => setTicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <Sign
              study={study}
              version={version}
              ready={answersOk && termsOk}
              missing={[!answersOk && "answer the open questions (step 1)", !termsOk && "tick every key term (step 2)"].filter(Boolean) as string[]}
              gate={approveState(version, settings.data, by)}
              makerChecker={!!settings.data?.makerChecker}
              ticked={terms.filter((t) => ticked.has(t.id)).map((t) => t.label)}
              onApproved={setApproved}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function StepHead({ n, title, sub }: { n: number; title: string; sub: ReactNode }) {
  return (
    <div className="mb-6">
      <p className="eyebrow mb-1.5">Step {n} of 3</p>
      <h2 className="text-heading font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-[66ch] text-body text-muted">{sub}</p>
    </div>
  );
}

/** "What you're approving": the money at a glance, and how it was checked. */
function Summary({ version }: { version: RulebookVersionDto }) {
  const rb = version.rulebook!;
  const ev = (s: string) => version.evidence.filter((e) => e.status === s).length;
  const checked = version.evidence.filter((e) => e.status === "confirmed").length;
  const proofed = (version.proofread ?? []).length;
  const people = [...new Set(version.review.flatMap((i) => (i.answer ? [i.answer.by] : [])))];
  const handBilled = version.review.filter((i) => i.kind === "unclassified").length;
  const g = rb.budgetGrids.find((x) => !rb.governingGridId || x.id === rb.governingGridId);
  const perPatient = g?.perPatientTotals[0]?.cents ?? g?.visits.reduce((n, v) => n + v.totalCents, 0) ?? null;
  const rows: [string, ReactNode][] = [
    ...(version.pdfCheck ? ([["Matched the PDF", <span key="m" className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-ok" />{ev("confirmed").toLocaleString("en-US")}</span>]] as [string, ReactNode][]) : []),
    ["Confirmed by people", <span key="c" className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-info" />{ev("attested")}</span>],
    ["Proofread", `${proofed.toLocaleString("en-US")} of ${checked.toLocaleString("en-US")}`],
    ["To bill by hand", String(handBilled)],
  ];
  return (
    <div className="rounded-card bg-sunken p-5">
      <p className="eyebrow">What you&apos;re approving</p>
      {perPatient !== null && (
        <div className="mt-3">
          <p className="num text-figure font-semibold tracking-tight">{formatValue("/x/amountCents", perPatient)}</p>
          <p className="text-small text-muted">per patient · {g!.label}</p>
        </div>
      )}
      <dl className="mt-4 flex flex-col divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 py-2 text-small">
            <dt className="text-muted">{k}</dt>
            <dd className="num font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {people.length > 0 && <p className="mt-3 text-small text-faint">Answered by {people.join(", ")}</p>}
    </div>
  );
}

const outcomeText = (i: ReviewItem) => {
  const a = i.answer;
  const v = a?.optionId ? i.options.find((o) => o.id === a.optionId)?.label : a?.value !== undefined ? formatAnswer(i.input, a.value) : null;
  if (i.outcome === "matched") return { tone: "ok" as const, text: `${v} · matches the contract` };
  if (i.outcome === "chosen") return { tone: "info" as const, text: v ? `Decided: ${v}` : "Decided" };
  if (i.outcome === "cant_tell") return { tone: "warn" as const, text: "Couldn't tell" };
  if (i.outcome === "differs") return { tone: "danger" as const, text: "Picking the right value" };
  return { tone: "warn" as const, text: i.sentBack ? "Sent back, not answered yet" : "Not answered yet" };
};

function Answers({ study, version, order, open, onNext }: { study: StudyDetailDto; version: RulebookVersionDto; order: ReviewItem[]; open: ReviewItem[]; onNext: () => void }) {
  const by = useActingAs();
  const qc = useQueryClient();
  const invalidate = useInvalidateStudy();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api.sendBack(study.id, version.version, { itemIds: [...picked], note: note.trim(), by: by! }),
    onSuccess: (dto) => {
      qc.setQueryData(keys.version(study.id, version.version), dto);
      void invalidate(study.id);
      setPicked(new Set());
      setDialog(false);
      setNote("");
    },
  });
  const review = (i: ReviewItem) => `/studies/${study.id}/review?item=${encodeURIComponent(i.id)}&return=approve`;

  if (!order.length)
    return (
      <>
        <StepHead n={1} title="Check the answers" sub="Nothing on this contract needed a person: every number matched the PDF." />
        <div className="flex justify-end">
          <Button variant="primary" size="lg" onClick={onNext}>
            Next: key terms <ArrowRight className="size-[18px]" strokeWidth={2} />
          </Button>
        </div>
      </>
    );

  return (
    <>
      <StepHead
        n={1}
        title="Check the answers"
        sub="Every question a person answered, and who answered it. If one looks wrong, send it back with a note, or change it yourself."
      />
      {open.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 rounded-tile bg-warn-soft p-5">
          <p className="text-body font-medium text-ink">
            {open.length} {open.length === 1 ? "question needs" : "questions need"} an answer before approval
          </p>
          <ul className="flex flex-col gap-2">
            {open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 text-small">
                <span className="max-w-[60ch] text-ink-2">{i.question}</span>
                <Link href={review(i)} className={btnCls("primary", "sm")}>
                  Answer now
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-tile ring-1 ring-line">
        {order
          .filter((i) => i.outcome !== null)
          .map((i) => {
            const o = outcomeText(i);
            const on = picked.has(i.id);
            return (
              <li key={i.id} className={cx("flex items-start gap-4 px-4 py-3.5 transition-colors", on && "bg-brand-soft/50")}>
                <input
                  type="checkbox"
                  aria-label={`Send back: ${i.question}`}
                  checked={on}
                  onChange={() => setPicked((s) => (s.has(i.id) ? new Set([...s].filter((x) => x !== i.id)) : new Set([...s, i.id])))}
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-body text-ink">{i.question}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
                    <Badge tone={o.tone}>{o.text}</Badge>
                    {i.answer && (
                      <span className="text-faint">
                        {i.answer.by} · {relativeTime(i.answer.at)}
                      </span>
                    )}
                  </p>
                  {i.answer?.note && <p className="mt-1 text-small text-muted">“{i.answer.note}”</p>}
                </div>
                <Link href={review(i)} className={btnCls("ghost", "sm")}>
                  Change
                </Link>
              </li>
            );
          })}
      </ul>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button disabled={!picked.size || !by} onClick={() => setDialog(true)}>
          <Undo2 className="size-4" strokeWidth={1.75} /> {picked.size ? `Send ${picked.size} back` : "Send back"}
        </Button>
        <Button variant="primary" size="lg" disabled={open.length > 0} onClick={onNext}>
          Next: key terms <ArrowRight className="size-[18px]" strokeWidth={2} />
        </Button>
      </div>
      {!by && (
        <div className="mt-3">
          <NeedsPerson />
        </div>
      )}
      <Dialog open={dialog} onClose={() => setDialog(false)} title={`Send ${picked.size} ${picked.size === 1 ? "answer" : "answers"} back`}>
        <p className="text-body text-muted">They&apos;re reopened and answered again, blind. The contract goes back to Needs you, and whoever answered sees your note.</p>
        <label htmlFor="sb-note" className="mt-5 block text-small font-medium text-ink-2">
          What should they look at again?
        </label>
        <textarea id="sb-note" rows={3} className={cx("mt-2 w-full py-2.5 text-body", fieldCls)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Page 9 prints $45.00 for this visit, not $25.00" />
        <ErrorNote error={send.error} />
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="ghost" onClick={() => setDialog(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!note.trim() || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? "Sending…" : "Send back"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function Terms({ study, terms, ticked, onTick, onNext }: { study: StudyDetailDto; terms: KeyTerm[]; ticked: Set<string>; onTick: (id: string) => void; onNext: () => void }) {
  const [look, setLook] = useState<KeyTerm | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  return (
    <>
      <StepHead n={2} title="Check the key terms" sub="These decide most of the money. Tick each one when it's what the contract says; open it in the contract to look." />
      <ul className="flex flex-col gap-2.5">
        {terms.map((t) => {
          const on = ticked.has(t.id);
          return (
            <li key={t.id} className={cx("flex items-start gap-4 rounded-tile px-4 py-4 ring-1 transition-colors", on ? "bg-ok-soft/50 ring-ok/30" : "ring-line hover:ring-line-strong")}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`${t.label}: ${t.value}`}
                onClick={() => onTick(t.id)}
                className={cx("mt-0.5 grid size-6 shrink-0 place-items-center rounded-[8px] ring-1 transition-colors", on ? "bg-ok text-on-primary ring-ok" : "bg-surface ring-line-strong hover:ring-ink/30")}
              >
                {on && <Check className="size-4" strokeWidth={3} />}
              </button>
              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onTick(t.id)}>
                <p className="eyebrow">{t.label}</p>
                <p className="num mt-0.5 text-title font-semibold tracking-tight">{t.value}</p>
                {t.detail && <p className="text-small text-muted">{t.detail}</p>}
                {t.quote && <p className="mt-1.5 text-small text-ink-2 italic">“{t.quote}”</p>}
              </div>
              {t.where && (
                <Button size="sm" variant="ghost" onClick={() => setLook(t)}>
                  <Eye className="size-4" strokeWidth={1.75} /> Show in contract
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="num text-small text-muted">
          {ticked.size} of {terms.length} ticked
        </p>
        <Button variant="primary" size="lg" disabled={ticked.size < terms.length} onClick={onNext}>
          Next: approve <ArrowRight className="size-[18px]" strokeWidth={2} />
        </Button>
      </div>
      <Dialog open={!!look} onClose={() => setLook(null)} title={look ? `${look.label}: ${look.value}` : ""} width="w-[min(960px,95vw)]">
        {look?.where && (
          <div className="h-[62vh]">
            <SpotView documents={study.documents} spot={look.where} zoom={zoom} onZoom={setZoom} />
          </div>
        )}
      </Dialog>
    </>
  );
}

function Sign(p: {
  study: StudyDetailDto;
  version: RulebookVersionDto;
  ready: boolean;
  missing: string[];
  gate: { allowed: boolean; reasons: string[] };
  makerChecker: boolean;
  ticked: string[];
  onApproved: (v: number) => void;
}) {
  const { study, version } = p;
  const by = useActingAs();
  const invalidate = useInvalidateStudy();
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const live = study.liveVersion;
  const diff = useDiff(study.id, live && live < version.version ? version.version : null, live);
  const want = by ? initials(by) : "";
  const signed = !!want && typed.trim().toUpperCase() === want;
  const checked = version.evidence.filter((e) => e.status === "confirmed").length;
  const proofed = (version.proofread ?? []).length;
  const handBilled = version.review.filter((i) => i.kind === "unclassified");
  const approve = useMutation({
    mutationFn: () => api.signOff(study.id, version.version, { by: by!, note: [`Key terms checked: ${p.ticked.join(", ")}.`, note.trim()].filter(Boolean).join(" ") }),
    onSuccess: async () => {
      await invalidate(study.id);
      p.onApproved(version.version);
    },
  });
  const blockers = [...p.missing.map((m) => `First, ${m}.`), ...p.gate.reasons];

  return (
    <>
      <StepHead n={3} title="Approve" sub={`You're approving version ${version.version} of ${study.protocol}. From now on, billing is checked against it.`} />
      <ul className="mb-6 flex flex-col gap-2.5 text-body text-ink-2">
        <li className="flex items-start gap-2.5">
          <Check className="mt-1 size-4 shrink-0 text-ok" strokeWidth={2.5} /> It&apos;s locked once approved. If a number ever looks wrong, “This looks wrong” opens a correction, and this version stays in use until that&apos;s approved.
        </li>
        <li className="flex items-start gap-2.5">
          <Check className="mt-1 size-4 shrink-0 text-ok" strokeWidth={2.5} />
          <span>
            Proofread: <span className="num font-medium text-ink">{proofed.toLocaleString("en-US")}</span> of <span className="num">{checked.toLocaleString("en-US")}</span> checked numbers
            {proofed < checked && (
              <>
                {" "}
                (optional,{" "}
                <Link href={`/studies/${study.id}/proofread`} className="text-accent hover:underline">
                  proofread now
                </Link>
                )
              </>
            )}
          </span>
        </li>
        {handBilled.length > 0 && (
          <li className="flex items-start gap-2.5">
            <CircleHelp className="mt-1 size-4 shrink-0 text-warn" strokeWidth={2} />
            <span>
              {handBilled.length} {handBilled.length === 1 ? "term is" : "terms are"} billed by hand: {handBilled.map((i) => i.question.replace(/ The invoicing master has no place.*$/, "")).join(" · ")}
            </span>
          </li>
        )}
      </ul>

      {diff.data && (
        <details className="mb-6 rounded-tile px-4 py-3 ring-1 ring-line">
          <summary className="cursor-pointer text-body font-medium">
            What changes compared with live version {live}
            <span className="num ml-2 font-normal text-muted">
              {(["changed", "added", "removed"] as const)
                .map((c) => [c, diff.data!.filter((e) => e.change === c).length] as const)
                .filter(([, n]) => n)
                .map(([c, n]) => `${n} ${c}`)
                .join(" · ")}
            </span>
          </summary>
          <div className="mt-3">
            <DiffView entries={diff.data} />
          </div>
        </details>
      )}

      <div className="flex flex-col gap-5 rounded-tile bg-sunken p-5">
        <div className="grid gap-5 sm:grid-cols-[1fr_200px]">
          <div className="flex flex-col gap-2">
            <label htmlFor="ap-note" className="text-small font-medium text-ink-2">
              Note (optional)
            </label>
            <textarea id="ap-note" rows={2} className={cx("w-full py-2.5 text-body", fieldCls)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the team should know about this contract" />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="ap-sign" className="text-small font-medium text-ink-2">
              {by ? `Type ${want} to sign as ${by}` : "Your initials"}
            </label>
            <input id="ap-sign" autoComplete="off" maxLength={4} className={cx(inputCls, "num text-center text-lead font-semibold tracking-[0.3em] uppercase")} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={want} disabled={!by} />
          </div>
        </div>
        {blockers.length > 0 && (
          <p id="ap-why" className="text-small text-warn">
            {blockers.join(" ")}
          </p>
        )}
        {p.makerChecker && version.editors.length > 0 && p.gate.allowed && <p className="text-small text-muted">A second person is required, and you didn&apos;t answer any question here, so you can approve.</p>}
        <ErrorNote error={approve.error} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!by && <NeedsPerson />}
          <Button variant="primary" size="lg" aria-describedby={blockers.length ? "ap-why" : undefined} disabled={!p.ready || !p.gate.allowed || !signed || approve.isPending} onClick={() => approve.mutate()}>
            <BadgeCheck className="size-[18px]" strokeWidth={1.75} />
            {approve.isPending ? "Approving…" : "Approve invoicing master"}
          </Button>
        </div>
      </div>
    </>
  );
}

function Approved({ study, version }: { study: StudyDetailDto; version: number }) {
  return (
    <div className={`${pageCls} grid min-h-[70vh] place-items-center`}>
      <div className="flex max-w-[560px] flex-col items-center gap-5 text-center">
        <span className="grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
          <BadgeCheck className="size-8" strokeWidth={1.75} />
        </span>
        <div>
          <h1 className="text-display font-semibold tracking-tight">Approved. Version {version} is live.</h1>
          <p className="mt-2 text-lead text-muted">Billing for {study.protocol} is checked against it from now on. If a number ever looks wrong, open it and choose “This looks wrong”.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Link href="/" className={btnCls()}>
            Back to contracts
          </Link>
          <Link href={`/studies/${study.id}`} className={btnCls("primary", "lg")}>
            Open the invoicing master <ArrowRight className="size-[18px]" strokeWidth={2} />
          </Link>
        </div>
      </div>
    </div>
  );
}
