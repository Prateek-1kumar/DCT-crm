"use client";

import type { Question } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { recall, remember } from "@/lib/remembered";
import { ContractPane } from "@/components/decisions/ContractPane";
import { OptionCards } from "@/components/decisions/OptionCards";
import { StartReading } from "@/components/study/StartReading";
import { Badge, Button, btnCls, Card, cx, ErrorNote, LoadError, pageCls, ProgressBar } from "@/components/ui";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { useMounted } from "@/lib/use-mounted";
import { answerers, answeredByMe, kindLabel, newQuestions, nextOpenWrapping, walkOrder, when } from "./questions";
import { useVersion } from "./useVersion";

const DONE = "done";

const LOCKED: Record<string, string> = {
  approved: "This rulebook is live, so its decisions can't be answered or changed.",
  superseded: "A newer version replaced this one, so its decisions can't be answered or changed.",
};

const readingNames = ["First reading", "Second reading"];

/** COMPONENT: a keyboard-hint chip (Kbd) from the owner's component library. */
const Kbd = ({ children }: { children: ReactNode }) => <kbd className="rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-sans text-small text-ink-2 shadow-button">{children}</kbd>;

/** Moving between questions is by keys too, so no hint is the only way: every key has a button. */
const Hints = () => (
  <p className="hidden items-center gap-x-4 gap-y-1 text-small text-muted lg:flex lg:flex-wrap" aria-hidden>
    <span>
      <Kbd>1</Kbd>–<Kbd>9</Kbd> pick
    </span>
    <span>
      <Kbd>Enter</Kbd> use this answer
    </span>
    <span>
      <Kbd>←</Kbd> <Kbd>K</Kbd> back
    </span>
    <span>
      <Kbd>→</Kbd> <Kbd>J</Kbd> next
    </span>
  </p>
);

/** The shape of the split, so nothing jumps when the real screen arrives. */
function Loading() {
  return (
    <div role="status" aria-label="Loading the decisions" className={cx("mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 py-4", `min-[1100px]:grid min-[1100px]:grid-cols-[minmax(380px,2fr)_minmax(0,3fr)] min-[1100px]:px-6`)}>
      <div className="h-[60vh] animate-pulse rounded-tile bg-sunken min-[1100px]:order-2" />
      <div className="flex flex-col gap-4 rounded-card p-2 min-[1100px]:order-1">
        <div className="h-2 w-full animate-pulse rounded-full bg-sunken" />
        <div className="h-7 w-3/4 animate-pulse rounded-field bg-sunken" />
        <div className="h-24 animate-pulse rounded-tile bg-sunken" />
        <div className="h-40 animate-pulse rounded-tile bg-sunken" />
      </div>
    </div>
  );
}

/** The thin bar, the "Question 2 of 5" line (announced as it changes) and one dot per question. */
function Progress({ list, index, go }: { list: Question[]; index: number; go: (id: string) => void }) {
  const open = list.filter((q) => q.state === "open").length;
  const answered = list.filter((q) => q.state === "answered").length;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p aria-live="polite" className="text-lead font-semibold">
          Question {index + 1} of {list.length}
        </p>
        <p className="text-small text-muted">
          {answered} answered · {open} to go
        </p>
      </div>
      <ProgressBar value={list.length ? (answered / list.length) * 100 : 0} label="Decisions made" />
      {list.length <= 20 && (
        <ol className="flex flex-wrap gap-1.5" aria-label="Questions">
          {list.map((q, i) => (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => go(q.id)}
                aria-label={`Go to question ${i + 1}, ${q.state === "answered" ? "answered" : "not answered yet"}`}
                aria-current={i === index ? "step" : undefined}
                className={cx("size-3 rounded-full border transition-colors", q.state === "answered" ? "border-brand bg-brand" : "border-line-strong bg-surface", i === index && "ring-2 ring-brand/40 ring-offset-2")}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Readings({ question }: { question: Question }) {
  if (question.kind !== "reading" || question.readings.length === 0) return null;
  return (
    <div>
      <h3 className="eyebrow mb-2">What each reading found</h3>
      <p className="mb-2 text-small text-muted">Pick the one that matches the page.</p>
      <div className="grid grid-cols-2 gap-3">
        {question.readings.map((r, i) => (
          <div key={i} className="min-w-0 rounded-tile border border-line-strong p-3">
            <p className="text-small font-medium text-muted">{readingNames[i] ?? `Reading ${i + 1}`}</p>
            <p className="mt-1 text-body break-words">{r.answer}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The context can run long, and the contract is what answers the question: keep it short until asked. (Long is judged by length, as the column's width isn't known here.) */
function Context({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 240;
  return (
    <div className="rounded-tile bg-sunken p-4">
      <h3 className="eyebrow mb-1.5">What the contract says and doesn&apos;t</h3>
      <p className={cx("text-body break-words text-ink-2", long && !more && "line-clamp-4")}>{text}</p>
      {long && (
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="mt-1.5 text-small font-medium text-accent hover:text-accent-hover">
          {more ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function LockedNote({ version }: { version: Version }) {
  const text = LOCKED[version.status];
  if (!text) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-field bg-sunken px-4 py-3 text-body text-ink-2">
      <p>{text}</p>
      <Link href={`/studies/${version.studyId}`} className="font-medium text-accent hover:text-accent-hover">
        Back to the contract
      </Link>
    </div>
  );
}

/** The question side of the split. Keyed by question, so a half-made choice never carries over. */
function Focus({
  version,
  list,
  index,
  notice,
  go,
  onAnswered,
}: {
  version: Version;
  list: Question[];
  index: number;
  notice: string | null;
  go: (id: string) => void;
  onAnswered: (v: Version, from: Question) => void;
}) {
  const qc = useQueryClient();
  const by = useActingAs();
  const question = list[index]!;
  const draft = version.status === "draft";
  const given = version.answers.find((a) => a.questionId === question.id);
  const locked = !draft || question.state !== "open";
  const [choice, setChoice] = useState<number | null>(given?.option ?? null);
  const box = useRef<HTMLDivElement>(null);

  const answer = useMutation({
    mutationFn: (option: number) => api.answer(version.id, question.id, option, by!),
    onSuccess: (v) => {
      qc.setQueryData(keys.version(v.id), v);
      void qc.invalidateQueries({ queryKey: keys.studies });
      void qc.invalidateQueries({ queryKey: keys.study(v.studyId) });
      onAnswered(v, question);
    },
  });

  // Keys reach the screen only while focus is on it, so put focus there when the question changes (never steal it from elsewhere on the page).
  useEffect(() => {
    const el = box.current;
    const at = document.activeElement;
    if (el && (at === document.body || el.contains(at))) el.focus({ preventScroll: true });
  }, [question.id]);

  // A question with no options is settled by reading again, not by an answer.
  const nothingToChoose = question.options.length === 0;
  const others = nextOpenWrapping(list, question.id);
  const next = list[index + 1];
  // Skipping an open question goes to the next open one; reviewing walks the list, and the end of a finished list is the summary.
  const forward = question.state === "open" && others ? others.id : next ? next.id : draft ? (others?.id ?? (list.some((q) => q.state === "open") ? undefined : DONE)) : undefined;
  const back = list[index - 1]?.id;

  const confirm = () => {
    if (choice === null || locked || answer.isPending) return;
    if (!by) return askForPerson();
    answer.mutate(choice);
  };

  // On this column only, not the contract beside it: the viewer uses arrows, +, - and [ ] for itself.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    const typing = t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["radio", "checkbox"].includes((t as HTMLInputElement).type));
    if (typing) return;
    const key = e.key.toLowerCase();
    if (/^[1-9]$/.test(key)) {
      if (!locked && Number(key) <= question.options.length) setChoice(Number(key) - 1);
    } else if (key === "enter") {
      // a focused button or link keeps its own Enter
      if (t.tagName === "BUTTON" || t.tagName === "A") return;
      confirm();
    } else if (key === "arrowleft" || key === "k") {
      if (back) go(back);
    } else if (key === "arrowright" || key === "j") {
      if (forward) go(forward);
    } else return;
    e.preventDefault();
  };

  return (
    <Card className={cx("flex min-h-0 flex-col", `min-[1100px]:h-full`)}>
      <div ref={box} tabIndex={-1} onKeyDown={onKey} className="flex min-h-0 flex-1 flex-col outline-none">
        <div className="shrink-0 border-b border-line px-5 py-4">
          <Progress list={list} index={index} go={go} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 p-5 min-[1100px]:overflow-y-auto">
          <LockedNote version={version} />
          {notice && (
            <p role="status" className="rounded-field bg-info-soft px-4 py-3 text-body text-info">
              {notice}
            </p>
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone={question.blocking ? "warn" : "neutral"}>{kindLabel(question)}</Badge>
              {question.state === "answered" && <Badge tone="info">Answered</Badge>}
            </div>
            <h2 className="mt-3 text-heading font-semibold tracking-tight break-words">{question.question}</h2>
            {!question.blocking && <p className="mt-2 text-body text-muted">This isn&apos;t holding up approval.</p>}
          </div>
          {question.context && <Context text={question.context} />}
          <Readings question={question} />
          {nothingToChoose ? (
            <div className="flex flex-col items-start gap-3 rounded-tile bg-sunken p-4">
              <p className="text-body text-ink-2">There&apos;s nothing to choose here. This part of the read needs to run again, and this can&apos;t be approved until it has. The pages already read are kept.</p>
              {draft && <StartReading studyId={version.studyId} label="Start again" />}
            </div>
          ) : (
            <OptionCards question={question} choice={choice} locked={locked} onChoose={setChoice} />
          )}
          {given && (
            <p className="text-small text-muted">
              Answered by {given.by} on {when(given.at)}.
            </p>
          )}
          <ErrorNote error={answer.error} />
        </div>

        {/* Pinned: the answer buttons must never scroll out of reach of the question they belong to. */}
        <div className="sticky bottom-0 z-10 flex shrink-0 flex-col gap-3 rounded-b-card border-t border-line bg-surface px-5 py-4">
          <Hints />
          <div className="flex flex-wrap items-center gap-2.5">
            <Button onClick={() => back && go(back)} disabled={!back}>
              Back
            </Button>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
              {!locked && others && <Button onClick={() => go(others.id)}>Skip for now</Button>}
              {!locked && !nothingToChoose && (
                <Button variant="primary" size="lg" onClick={confirm} disabled={choice === null || answer.isPending}>
                  {answer.isPending ? "Saving…" : "Use this answer"}
                </Button>
              )}
              {locked && (
                <Button onClick={() => forward && go(forward)} disabled={!forward}>
                  Next
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Question on the left (about 40%), contract on the right (about 60%), together exactly the height under the header so the
 * page itself never scrolls. Below 1100 px the contract comes first in a panel that folds away, then the question.
 */
function Split({ version, list, index, notice, go, onAnswered }: { version: Version; list: Question[]; index: number; notice: string | null; go: (id: string) => void; onAnswered: (v: Version, from: Question) => void }) {
  // Drawn only after mount (see QuestionsView), so reading the screen width here can't disagree with the server's HTML.
  const [open, setOpen] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 640px)").matches);
  const question = list[index]!;
  return (
    <div className={cx("mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 py-4", `min-[1100px]:grid min-[1100px]:h-[calc(100dvh-12rem)] min-[1100px]:min-h-[520px] min-[1100px]:grid-cols-[minmax(380px,2fr)_minmax(0,3fr)] min-[1100px]:gap-5 min-[1100px]:px-6 min-[1100px]:py-3`)}>
      <section aria-label="The contract" className={cx("flex min-h-0 flex-col gap-2", `min-[1100px]:order-2 min-[1100px]:h-full`)}>
        <button type="button" aria-expanded={open} aria-controls="contract-panel" onClick={() => setOpen(!open)} className={cx("flex w-full items-center justify-between rounded-field border border-line-strong bg-surface px-4 py-2.5 text-body font-medium shadow-button", `min-[1100px]:hidden`)}>
          Contract
          {open ? <ChevronUp aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
        </button>
        <div id="contract-panel" className={cx("min-h-0 flex-col", open ? "flex h-[60vh]" : "hidden", `min-[1100px]:flex min-[1100px]:h-auto min-[1100px]:flex-1`)}>
          <ContractPane version={version} question={question} />
        </div>
      </section>
      <div className={cx("min-h-0", `min-[1100px]:order-1 min-[1100px]:h-full`)}>
        <Focus key={`${version.id}:${question.id}`} version={version} list={list} index={index} notice={notice} go={go} onAnswered={onAnswered} />
      </div>
    </div>
  );
}

/** Nothing left to answer: the way on, or why this person can't be the one to approve. */
function AllMade({ version, review }: { version: Version; review?: () => void }) {
  const me = useActingAs();
  const mine = answeredByMe(version, me);
  const names = answerers(version).join(", ");
  return (
    <Card className="mx-auto flex max-w-[640px] flex-col items-start gap-3 p-8">
      <h2 className="text-title font-semibold tracking-tight">All decisions made</h2>
      <p className="text-body text-muted">Nothing is waiting for your answer. The next step is to review the rulebook and approve it.</p>
      {mine && <p className="text-body text-ink-2">{names} answered these decisions, so a colleague has to approve this version.</p>}
      <div className="mt-2 flex flex-wrap gap-2.5">
        {mine ? (
          <Button variant="primary" size="lg" disabled>
            Waiting for a colleague
          </Button>
        ) : (
          <Link href={`/versions/${version.id}/approve`} className={btnCls("primary", "lg")}>
            Review and approve
          </Link>
        )}
        {review && <Button size="lg" onClick={review}>Review the answers</Button>}
      </div>
    </Card>
  );
}

/** Checks that fail with no question to answer: only reading again can change them. */
function Problems({ version, review }: { version: Version; review?: () => void }) {
  return (
    <Card className="mx-auto flex max-w-[720px] flex-col items-start gap-3 p-8">
      <h2 className="text-title font-semibold tracking-tight">Some checks still fail</h2>
      <p className="text-body text-muted">There&apos;s nothing for you to answer, but this can&apos;t be approved while these are open. Reading the contract again is the way to fix them.</p>
      <ul className="flex w-full flex-col gap-2">
        {version.problems.map((p, i) => (
          <li key={i} className="rounded-tile bg-warn-soft px-4 py-3 text-body break-words text-warn">
            {p.message}
            {p.doc && <span className="block text-small opacity-80">{p.doc}{p.page ? ` · page ${p.page}` : ""}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-start gap-2.5">
        <StartReading studyId={version.studyId} label="Start the read again" />
        {review && <Button size="lg" onClick={review}>Review the answers</Button>}
      </div>
    </Card>
  );
}

function Screen({ version }: { version: Version }) {
  const draft = version.status === "draft";
  const list = walkOrder(version.rulebook?.questions ?? []);
  const open = list.filter((q) => q.state === "open");
  // The question this person last had open on this version, while it is still unanswered: coming back carries on from it.
  const resumeKey = `dct.resume.decisions.${version.id}`;
  const [at, setAt] = useState<string | undefined>(() => {
    const last = recall(resumeKey);
    return list.some((q) => q.id === last && q.state === "open") ? last! : undefined;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const found = list.findIndex((q) => q.id === at);
  const settled = draft && open.length === 0 && found < 0;
  const index = found >= 0 ? found : draft ? list.findIndex((q) => q.state === "open") : 0;
  const go = (id: string) => {
    remember(resumeKey, id);
    setAt(id);
    setNotice(null);
  };
  const review = list.length ? () => go(list[0]!.id) : undefined;

  const onAnswered = (v: Version, from: Question) => {
    const after = walkOrder(v.rulebook?.questions ?? []);
    const more = newQuestions(list, after);
    setNotice(`Answer saved.${more > 0 ? ` ${more === 1 ? "One more came" : `${more} more came`} up after that answer.` : ""}`);
    setAt(nextOpenWrapping(after, from.id)?.id ?? DONE);
  };

  if (!settled && index >= 0 && list[index]) return <Split version={version} list={list} index={index} notice={notice} go={go} onAnswered={onAnswered} />;

  const locked = LOCKED[version.status];
  return (
    <div className={pageCls}>
      {locked && (
        <div className="mb-6">
          <LockedNote version={version} />
        </div>
      )}
      {settled ? (
        version.problems.length > 0 ? (
          <Problems version={version} review={review} />
        ) : (
          <AllMade version={version} review={review} />
        )
      ) : (
        !locked && <p className="text-body text-muted">This version has no decisions to look at.</p>
      )}
    </div>
  );
}

export function QuestionsView({ versionId }: { versionId: string }) {
  const v = useVersion(versionId);
  // The sidebar may already have filled the cache: wait for mount so the first client render matches the server's.
  const mounted = useMounted();
  if (!mounted || v.isPending) return <Loading />;
  if (v.isError) return <LoadError error={v.error} retry={() => void v.refetch()} what="the decisions" back={{ href: "/", label: "Back to contracts" }} />;
  return <Screen version={v.data} />;
}
