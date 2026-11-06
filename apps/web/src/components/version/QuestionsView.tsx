"use client";

import type { Question } from "@dct/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { PageView, type Box } from "@/components/PageView";
import { Badge, Button, btnCls, Card, cx, Empty, ErrorNote, pageCls, Spinner } from "@/components/ui";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { nextOpen, walkOrder, when } from "./questions";
import { useVersion } from "./useVersion";

const END = "end";

const LOCKED: Record<string, string> = {
  approved: "This rulebook is live, so its answers can't be changed.",
  superseded: "A newer version replaced this one, so its answers can't be changed.",
};

function SourcePane({ version, question }: { version: Version; question: Question }) {
  const { doc: name, page, quote, region } = question.source;
  const doc = version.documents.find((d) => d.name === name);
  const found = useQuery({ queryKey: keys.find(doc?.id ?? "", page, quote), queryFn: () => api.find(doc!.id, page, quote), enabled: !!doc && quote !== "" });
  const words = found.data?.boxes;
  const boxes = useMemo<Box[]>(
    () => [
      ...(words ?? []).map((box) => ({ box, mark: "highlight" as const, label: "The words this question is about" })),
      ...(region ? [{ box: region, mark: "highlight" as const, label: "The part of the page this question is about" }] : []),
    ],
    [words, region],
  );
  const focus = boxes[0]?.box;
  const missed = found.isError || (found.isSuccess && words?.length === 0);

  return (
    <div data-page-scroller className="flex flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
      <p className="text-small font-medium text-ink-2">
        {name} · page {page}
      </p>
      {missed && <p className="rounded-field bg-warn-soft px-4 py-3 text-small text-warn">We couldn&apos;t highlight the exact words on this page.</p>}
      {doc ? (
        <PageView documentId={doc.id} page={page} boxes={boxes} focus={focus} alt={`Page ${page} of ${name}`} />
      ) : (
        <ErrorNote>We couldn&apos;t find this document, so the page can&apos;t be shown.</ErrorNote>
      )}
    </div>
  );
}

const readingNames = ["First reading", "Second reading"];

function QuestionCard({
  version,
  question,
  index,
  total,
  readOnly,
  onBack,
  onForward,
  onAnswered,
}: {
  version: Version;
  question: Question;
  index: number;
  total: number;
  readOnly: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onAnswered: (v: Version) => void;
}) {
  const qc = useQueryClient();
  const by = useActingAs();
  const given = version.answers.find((a) => a.questionId === question.id);
  const [choice, setChoice] = useState<number | null>(given?.option ?? null);
  const answer = useMutation({
    mutationFn: (option: number) => api.answer(version.id, question.id, option, by!),
    onSuccess: (v) => {
      qc.setQueryData(keys.version(v.id), v);
      void qc.invalidateQueries({ queryKey: keys.version(v.id) });
      onAnswered(v);
    },
  });
  const locked = readOnly || question.state !== "open";
  // a read that wasn't reviewed is settled by reading again, not by an answer
  const nothingToChoose = question.options.length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (choice === null || locked) return;
    if (!by) return askForPerson();
    answer.mutate(choice);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="eyebrow">
            Question {index + 1} of {total}
          </p>
          {question.state === "answered" ? <Badge tone="info">Answered</Badge> : question.blocking ? <Badge tone="warn">Must answer</Badge> : <Badge>Worth a look</Badge>}
        </div>
        <h2 className="mt-2 text-heading font-semibold tracking-tight">{question.question}</h2>
        {!question.blocking && question.state === "open" && <p className="mt-2 text-body text-muted">You can approve without answering this.</p>}
      </div>

      {question.context && !nothingToChoose && (
        <div className="rounded-tile bg-sunken p-5">
          <h3 className="eyebrow mb-1.5">What the contract says and doesn&apos;t</h3>
          <p className="text-body text-ink-2">{question.context}</p>
        </div>
      )}

      {question.kind === "reading" && question.readings.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">What each reading found</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {question.readings.map((r, i) => (
              <div key={i} className="rounded-tile border border-line-strong p-4">
                <p className="text-small font-medium text-muted">{readingNames[i] ?? `Reading ${i + 1}`}</p>
                <p className="mt-1 text-body">{r.answer}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {nothingToChoose ? (
        <p className="rounded-tile bg-sunken p-5 text-body text-ink-2">
          {question.context && `${question.context} `}There&apos;s nothing to choose here: start the read again. This can&apos;t be approved until then.
        </p>
      ) : (
        <fieldset disabled={locked} className="flex flex-col gap-2.5">
          <legend className="mb-2 text-small font-medium text-ink-2">{locked ? "The answer" : "Your answer"}</legend>
          {question.options.map((o, i) => (
            <label
              key={i}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-tile border p-4 transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/20 has-disabled:cursor-default",
                choice === i ? "border-brand bg-brand-soft" : "border-line-strong hover:bg-sunken",
              )}
            >
              <input type="radio" name="option" className="mt-1 size-4 accent-primary" checked={choice === i} onChange={() => setChoice(i)} autoFocus={!locked && i === 0} />
              <span className="flex-1 text-body font-medium">{o.label}</span>
              {question.suggestion?.option === i && <Badge tone="accent">We suggest this</Badge>}
            </label>
          ))}
        </fieldset>
      )}
      {question.suggestion && !locked && <p className="-mt-3 text-small text-muted">Why we suggest it: {question.suggestion.reason}</p>}

      {given && (
        <p className="text-small text-muted">
          Answered by {given.by} on {when(given.at)}.
        </p>
      )}
      {readOnly && LOCKED[version.status] && <p className="text-small text-muted">{LOCKED[version.status]}</p>}
      <ErrorNote error={answer.error} />

      <div className="flex flex-wrap items-center gap-2.5">
        <Button onClick={onBack} disabled={!onBack}>
          Back
        </Button>
        {locked ? (
          <Button onClick={onForward} disabled={!onForward}>
            Next
          </Button>
        ) : (
          <>
            <Button onClick={onForward}>Skip</Button>
            {!nothingToChoose && (
              <Button type="submit" variant="primary" disabled={choice === null || answer.isPending}>
                Answer
              </Button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

function Walk({ version }: { version: Version }) {
  const draft = version.status === "draft";
  const list = useMemo(() => walkOrder(version.rulebook!.questions), [version]);
  const [at, setAt] = useState<string>();
  const firstOpen = list.findIndex((q) => q.state === "open");
  const found = list.findIndex((q) => q.id === at);
  const index = at === END ? list.length : found >= 0 ? found : draft && firstOpen >= 0 ? firstOpen : draft ? list.length : 0;
  const question = list[index];
  const left = list.filter((q) => q.state === "open");
  const to = (q: Question | undefined) => setAt(q?.id ?? END);
  const skipping = draft && question?.state === "open";
  const forward = skipping ? () => to(nextOpen(list, question!.id)) : draft || index < list.length - 1 ? () => to(list[index + 1]) : undefined;

  if (!question)
    return (
      <Card className="flex flex-col items-start gap-3 p-8">
        <h2 className="text-heading font-semibold tracking-tight">{left.length ? `${left.length} still to answer` : "All questions answered"}</h2>
        <p className="text-body text-muted">{left.length ? "You skipped these. Go back to them when you're ready." : "Next, check the rulebook against the contract pages."}</p>
        <div className="flex flex-wrap gap-2.5">
          {left.length > 0 ? (
            <Button variant="primary" onClick={() => to(left[0])}>
              Go to the first one
            </Button>
          ) : (
            <Link href={`/versions/${version.id}/proof`} className={btnCls("primary")}>
              Next: check the proof
            </Link>
          )}
          {list.length > 0 && <Button onClick={() => to(list[0])}>Review answers</Button>}
        </div>
      </Card>
    );

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <Fragment key={question.id}>
        <QuestionCard
          version={version}
          question={question}
          index={index}
          total={list.length}
          readOnly={!draft}
          onBack={index > 0 ? () => to(list[index - 1]) : undefined}
          onForward={forward}
          onAnswered={(v) => to(nextOpen(walkOrder(v.rulebook!.questions), question.id))}
        />
        <SourcePane version={version} question={question} />
      </Fragment>
    </div>
  );
}

export function QuestionsView({ versionId }: { versionId: string }) {
  const { data: version } = useVersion(versionId);
  return (
    <div className={pageCls}>
      {!version ? <Spinner /> : version.rulebook?.questions.length ? <Walk version={version} /> : <Empty title="No questions">This version has nothing for you to answer.</Empty>}
    </div>
  );
}
