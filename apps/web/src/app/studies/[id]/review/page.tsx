"use client";

import { settled, type ReviewItem, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { PageViewer, type ViewerTarget } from "@/components/PageViewer";
import { Badge, Button, Card, ErrorNote, ProgressBar, Spinner, Stepper, btnCls, cx, inputBase, inputCls } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { useAnswerReview, useStudy, useVersion } from "@/lib/queries";
import { formatAnswer, KIND_LABEL, minutesFor, needsYou, parseAnswer, queueOrder, versionStage } from "@/lib/review";

type Body = { value?: unknown; optionId?: string; cantTell?: boolean; note?: string };

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const draft = study.data ? [...study.data.versions].sort((a, b) => b.version - a.version).find((v) => v.status === "draft") : undefined;
  const vnum = sp.get("v") ? Number(sp.get("v")) : (draft?.version ?? null);
  const version = useVersion(id, vnum);
  const item = sp.get("item");

  if (study.error || version.error) return <div className="p-6"><ErrorNote error={study.error ?? version.error} /></div>;
  if (!study.data || (vnum !== null && !version.data)) return <div className="p-6"><Spinner /></div>;
  if (!version.data || version.data.status !== "draft")
    return (
      <div className="p-8">
        <p className="mb-3">There are no questions to answer on this contract right now.</p>
        <Link href={`/studies/${id}`} className={btnCls()}>
          Back to the contract
        </Link>
      </div>
    );
  // Keyed so a link to another question (?item=) starts fresh even though Next keeps this page mounted.
  return <Queue key={`${id}/${vnum}/${item ?? ""}`} study={study.data} version={version.data} start={item} />;
}

function Queue({ study, version, start }: { study: StudyDetailDto; version: RulebookVersionDto; start: string | null }) {
  const by = useActingAs();
  const answer = useAnswerReview(study.id, version.version);
  const order = useMemo(() => queueOrder(version.review), [version.review]);
  const [pick, setPick] = useState<string | null>(start);
  const [place, setPlace] = useState<{ item: string; idx: number } | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const current = (pick ? order.find((i) => i.id === pick && !settled(i)) : undefined) ?? order.find((i) => i.outcome === null || i.outcome === "differs") ?? null;
  const idx = place && place.item === current?.id ? place.idx : 0;
  const target = useMemo<ViewerTarget | null>(() => {
    const w = current?.where[idx];
    return w && current ? { source: { documentId: w.documentId, page: w.page }, box: w.box, label: KIND_LABEL[current.kind], nonce: 0 } : null;
  }, [current, idx]);
  const remaining = needsYou(order).length;
  // Hand-typed values must be re-typed by someone who didn't type them.
  const typist = version.byHand && !!by && version.editors.includes(by);

  const send = (item: ReviewItem, body: Body) =>
    answer.mutate(
      { itemId: item.id, body: { ...body, by: by! } },
      {
        onSuccess: (dto) => {
          const it = dto.review.find((i) => i.id === item.id)!;
          setPick(it.outcome === "differs" ? it.id : null);
          setLast(it.outcome === "differs" ? null : it.outcome === "matched" ? "✓ That matches the contract." : it.outcome === "cant_tell" ? "Left for the approver to decide." : "✓ Saved.");
        },
      },
    );

  return (
    <div className="flex flex-col lg:h-[calc(100vh-3.5rem)]">
      {/* Above the split, so the stepper stays on one line. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-6 py-3">
        <Link href={`/studies/${study.id}`} className="text-[13px] text-muted hover:text-ink">
          ← {study.protocol} · {study.sponsor}
        </Link>
        <Stepper state={versionStage(version, version)} />
      </div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(400px,0.85fr)] lg:grid-rows-[minmax(0,1fr)]">
      <aside aria-label="Contract pages" className="h-[55vh] min-h-0 border-b border-line bg-surface lg:h-full lg:border-r lg:border-b-0">
        <PageViewer documents={study.documents} target={target} />
      </aside>
      <section className="flex min-w-0 flex-col gap-5 overflow-auto px-6 py-6">
        {last && (
          <p role="status" className="rounded-[10px] bg-ok-soft px-3 py-2 text-[13px] text-ok">
            {last}
          </p>
        )}
        {current ? (
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3 text-[13px]">
              <span className="num">
                <strong className="font-medium">{order.indexOf(current) + 1}</strong> of {order.length}
                <span className="text-muted"> · about {minutesFor(remaining)} min</span>
              </span>
              <span className="w-28">
                <ProgressBar value={((order.length - remaining) / order.length) * 100} label="Questions answered" />
              </span>
            </div>
            {current.where.length > 1 && (
              <div role="group" aria-label="Places in the contract" className="mb-4 flex flex-wrap gap-1.5">
                {current.where.map((w, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={i === idx}
                    onClick={() => setPlace({ item: current.id, idx: i })}
                    className={cx("rounded-full border px-3 py-1 text-xs", i === idx ? "border-ink bg-ink text-surface" : "border-line-strong text-ink-2 hover:bg-sunken")}
                  >
                    {study.documents.find((d) => d.id === w.documentId)?.filename ?? "File"}, page {w.page}
                  </button>
                ))}
              </div>
            )}
            {typist && current.reason === "spot_check" && (
              <p className="mb-4 rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] text-warn">
                You typed this contract in, so someone else has to re-type these values. Switch “Acting as” to another person.
              </p>
            )}
            <Question
              key={`${current.id}:${current.outcome}`}
              item={current}
              busy={answer.isPending}
              canAnswer={!!by && !(typist && current.reason === "spot_check")}
              error={answer.error}
              onAnswer={(b) => send(current, b)}
            />
            {!by && (
              <div className="mt-3">
                <NeedsPerson />
              </div>
            )}
          </Card>
        ) : (
          <Done study={study} version={version} onRevisit={(itemId) => (setPick(itemId), setLast(null))} />
        )}
      </section>
    </div>
    </div>
  );
}

function Question({ item, onAnswer, busy, canAnswer, error }: { item: ReviewItem; onAnswer: (b: Body) => void; busy: boolean; canAnswer: boolean; error: unknown }) {
  const [raw, setRaw] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const differs = item.outcome === "differs" && item.compare;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (item.options.length) {
      if (!choice) return setMsg("Pick one of the answers, or choose “Can't tell”.");
      return onAnswer({ optionId: choice });
    }
    const p = parseAnswer(item.input ?? "text", raw);
    if ("error" in p) return setMsg(p.error);
    if (differs && !note.trim()) return setMsg("Add a short note saying why this is the right value.");
    onAnswer({ value: p.value, ...(differs ? { note: note.trim() } : {}) });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-labelledby={`q-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">{KIND_LABEL[item.kind]}</span>
        {item.reason === "spot_check" && <Badge tone="info">Random spot check</Badge>}
        {item.reason === "reported" && <Badge tone="warn">Reported as looking wrong</Badge>}
        {!item.blocking && <Badge>Not needed to approve</Badge>}
      </div>
      <p id={`q-${item.id}`} className="text-lg leading-snug">
        {item.question}
      </p>
      {item.reason === "spot_check" && <p className="-mt-2 text-xs text-muted">We pick a few numbers at random and ask a person to type them. It&apos;s how we know the checks work.</p>}

      {differs && (
        <div className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13px]">
          <p className="mb-1 font-medium text-warn">That&apos;s different from what we have. Look at the page again.</p>
          <p>
            You typed <b className="font-medium">{formatAnswer(item.input, item.compare!.typed)}</b>
            {item.compare!.printed !== null && (
              <>
                {" "}
                · the PDF text says <b className="font-medium">“{item.compare!.printed}”</b>
              </>
            )}{" "}
            · the tool read <b className="font-medium">{formatAnswer(item.input, item.compare!.read)}</b>
          </p>
        </div>
      )}

      {item.options.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Your answer</legend>
          {item.options.map((o, i) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-3 rounded-[12px] border border-line-strong px-4 py-3 text-[13.5px] hover:bg-sunken has-checked:border-ink has-checked:bg-accent-soft"
            >
              <input type="radio" name={`opt-${item.id}`} value={o.id} checked={choice === o.id} onChange={() => (setChoice(o.id), setMsg(null))} autoFocus={i === 0} className="accent-ink" />
              {o.label}
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`a-${item.id}`} className="text-xs text-muted">
            {differs ? "Final value" : "What the contract says"}
          </label>
          <AnswerInput id={`a-${item.id}`} input={item.input ?? "text"} value={raw} onChange={(v) => (setRaw(v), setMsg(null))} />
        </div>
      )}
      {differs && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`n-${item.id}`} className="text-xs text-muted">
            Short note (required)
          </label>
          <textarea id={`n-${item.id}`} rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Page 9 clearly prints $98.00; the tool misread it." />
        </div>
      )}
      {msg && <ErrorNote>{msg}</ErrorNote>}
      <ErrorNote error={error} />
      <div className="flex items-center justify-end gap-2">
        <Button disabled={busy || !canAnswer} onClick={() => onAnswer({ cantTell: true })}>
          Can&apos;t tell
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !canAnswer}>
          {busy ? "Saving…" : "Next →"}
        </Button>
      </div>
      <p className="text-right text-xs text-faint">Enter = Next</p>
    </form>
  );
}

/** Empty input of the item's kind. Never pre-filled: the tool's reading stays hidden until you answer. */
function AnswerInput({ id, input, value, onChange }: { id: string; input: NonNullable<ReviewItem["input"]>; value: string; onChange: (v: string) => void }) {
  const common = { id, value, autoFocus: true, autoComplete: "off", onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  if (input === "date") return <input {...common} type="date" className={cx(inputBase, "w-52")} />;
  if (input === "text") return <input {...common} className={inputCls} />;
  const affix = input === "money" ? "$" : input === "percent" ? "%" : null;
  return (
    <div className="relative w-52">
      {affix && <span className={cx("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted", affix === "$" ? "left-3" : "right-3")}>{affix}</span>}
      <input {...common} inputMode="decimal" placeholder={input === "money" ? "0.00" : ""} className={cx(inputCls, "num text-base", affix === "$" && "pl-7", affix === "%" && "pr-8")} />
    </div>
  );
}

function Done({ study, version, onRevisit }: { study: StudyDetailDto; version: RulebookVersionDto; onRevisit: (id: string) => void }) {
  const count = (o: ReviewItem["outcome"]) => version.review.filter((i) => i.outcome === o).length;
  const cant = queueOrder(version.review.filter((i) => i.outcome === "cant_tell"));
  const blockingCant = cant.filter((i) => i.blocking).length;
  return (
    <Card className="flex flex-col gap-4 p-6">
      <p className="eyebrow">Needs you</p>
      <h2 className="text-lg">{blockingCant ? "Almost there" : "Every question has an answer"}</h2>
      <p className="text-[13px] text-ink-2">
        {count("matched")} matched the contract · {count("chosen")} decided · {cant.length} couldn&apos;t tell
      </p>
      {blockingCant > 0 && (
        <p className="text-[13px] text-warn">
          {blockingCant} {blockingCant === 1 ? "question you couldn't tell is" : "questions you couldn't tell are"} needed before approval. The approver can answer
          {blockingCant === 1 ? " it" : " them"}, or you can try again now.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {cant.length > 0 && <Button onClick={() => onRevisit(cant[0]!.id)}>Answer the “Can&apos;t tell” ones</Button>}
        <Link href={`/studies/${study.id}`} className={btnCls("primary")}>
          Go to approval →
        </Link>
      </div>
    </Card>
  );
}
