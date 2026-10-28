"use client";

import { type ReviewItem, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleHelp, CornerDownLeft, Flag, Info, ListChecks, PartyPopper, Undo2, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { DEFAULT_ZOOM, SpotView, spotQuery } from "@/components/SpotView";
import { Badge, Button, btnCls, cx, ErrorNote, fieldCls, inputBase, inputCls, LoadError, ProgressBar, Sheet, Spinner } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { relativeTime } from "@/lib/format";
import { useAnswerReview, useStudy, useVersion } from "@/lib/queries";
import { formatAnswer, itemStatus, KIND_LABEL, minutesFor, needsYou, parseAnswer, queueOrder, whyLine } from "@/lib/review";

type Body = { value?: unknown; optionId?: string; cantTell?: boolean; note?: string };

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const draft = study.data ? [...study.data.versions].sort((a, b) => b.version - a.version).find((v) => v.status === "draft") : undefined;
  const vnum = sp.get("v") ? Number(sp.get("v")) : (draft?.version ?? null);
  const version = useVersion(id, vnum);
  const item = sp.get("item");
  // Opened from the approval page: leaving goes back there.
  const back = sp.get("return") === "approve" ? `/studies/${id}/approve` : `/studies/${id}`;

  const failed = (!study.data && study.error) || (!version.data && version.error);
  if (failed)
    return (
      <LoadError
        error={failed}
        what={study.data ? "the questions" : "this contract"}
        retry={() => void (study.error ? study.refetch() : version.refetch())}
        back={study.data ? { href: `/studies/${id}`, label: "Back to the contract" } : undefined}
      />
    );
  if (!study.data || (vnum !== null && !version.data))
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  if (!version.data || version.data.status !== "draft")
    return (
      <div className="grid min-h-screen place-items-center p-8">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <p className="text-title font-semibold tracking-tight">Nothing to answer here right now</p>
          <p className="text-body text-muted">This contract has no open questions. Open it to see where it stands.</p>
          <Link href={`/studies/${id}`} className={btnCls("primary")}>
            Back to the contract
          </Link>
        </div>
      </div>
    );
  // Keyed so a link to another question (?item=) starts fresh even though Next keeps this page mounted.
  return <Focus key={`${id}/${vnum}/${item ?? ""}`} study={study.data} version={version.data} start={item} back={back} />;
}

const STATUS_ICON = {
  todo: <span className="size-3.5 rounded-full ring-[1.5px] ring-line-strong" />,
  done: (
    <span className="grid size-4 place-items-center rounded-full bg-ok text-on-primary">
      <Check className="size-2.5" strokeWidth={3.5} />
    </span>
  ),
  differs: (
    <span className="grid size-4 place-items-center rounded-full bg-danger text-on-primary">
      <span className="text-[10px] leading-none font-bold">!</span>
    </span>
  ),
  cant_tell: (
    <span className="grid size-4 place-items-center rounded-full bg-warn-soft text-warn ring-1 ring-warn/30">
      <span className="text-[10px] leading-none font-bold">?</span>
    </span>
  ),
};

function Focus({ study, version, start, back }: { study: StudyDetailDto; version: RulebookVersionDto; start: string | null; back: string }) {
  const by = useActingAs();
  const qc = useQueryClient();
  const answer = useAnswerReview(study.id, version.version);
  const order = useMemo(() => queueOrder(version.review), [version.review]);
  const [pick, setPick] = useState<string | null>(start);
  const [changing, setChanging] = useState<string | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [spotAt, setSpotAt] = useState<{ item: string; i: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const open = (i: ReviewItem) => itemStatus(i) === "todo" || itemStatus(i) === "differs";
  const current = (pick ? order.find((i) => i.id === pick) : undefined) ?? order.find(open) ?? null;
  const spotIdx = spotAt && spotAt.item === current?.id ? spotAt.i : 0;
  const spot = current?.where[spotIdx];
  const done = order.filter((i) => itemStatus(i) === "done").length;
  const left = needsYou(order).length;
  // Hand-typed values must be re-typed by someone who didn't type them.
  const typist = version.byHand && !!by && version.editors.includes(by);

  const say = (msg: string) => {
    setToast(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  };
  const go = (id: string | null) => {
    setPick(id);
    setChanging(null);
    setListOpen(false);
  };

  const send = (item: ReviewItem, body: Body) =>
    answer.mutate(
      { itemId: item.id, body: { ...body, by: by! } },
      {
        onSuccess: (dto) => {
          const it = dto.review.find((i) => i.id === item.id)!;
          setChanging(null);
          if (it.outcome === "differs") return setPick(it.id);
          say(it.outcome === "matched" ? "Saved · it matches the contract" : it.outcome === "cant_tell" ? "Left for the approver" : "Saved");
          // Next open question after this one, wrapping round; then prefetch its page so it appears at once.
          const q = queueOrder(dto.review);
          const at = q.findIndex((i) => i.id === item.id);
          const next = [...q.slice(at + 1), ...q.slice(0, at)].find(open) ?? null;
          setPick(next?.id ?? "__done");
          const w = next?.where[0];
          if (w) void qc.prefetchQuery(spotQuery(w.documentId, w.page));
        },
      },
    );

  const finished = pick === "__done" || !current;
  const groups = [...new Set(order.map((i) => i.kind))].map((k) => ({ kind: k, items: order.filter((i) => i.kind === k) }));

  const list = (
    <nav aria-label="Questions" className="flex flex-col gap-5 p-4">
      <div className="flex items-center justify-between px-2">
        <p className="text-body font-semibold">Questions</p>
        <p className="num text-small text-muted">
          {done} of {order.length} done
        </p>
      </div>
      {groups.map((g) => (
        <div key={g.kind} className="flex flex-col gap-0.5">
          <p className="eyebrow px-2 pb-1.5">
            {KIND_LABEL[g.kind]} · {g.items.length}
          </p>
          {g.items.map((i) => {
            const active = !finished && i.id === current?.id;
            return (
              <button
                key={i.id}
                type="button"
                onClick={() => go(i.id)}
                aria-current={active ? "true" : undefined}
                className={cx(
                  "flex items-start gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors",
                  active ? "bg-surface shadow-card ring-1 ring-ink/[0.06]" : "hover:bg-ink/[0.04]",
                )}
              >
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center">{STATUS_ICON[itemStatus(i)]}</span>
                <span className={cx("line-clamp-2 text-small", active ? "font-medium text-ink" : itemStatus(i) === "done" ? "text-faint" : "text-ink-2")}>{i.question}</span>
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
          <span className="hidden truncate text-small text-muted sm:inline">{study.sponsor}</span>
        </Link>
        <div className="mx-auto hidden items-center gap-3 md:flex">
          <span className="num text-small text-ink-2">
            {done} of {order.length} answered
          </span>
          <span className="w-44">
            <ProgressBar value={order.length ? (done / order.length) * 100 : 100} label="Questions answered" />
          </span>
          {left > 0 && <span className="text-small text-faint">about {minutesFor(left)} min left</span>}
        </div>
        <Button size="sm" className="xl:hidden" aria-label="Questions" onClick={() => setListOpen(true)}>
          <ListChecks className="size-4" strokeWidth={1.75} /> <span className="hidden sm:inline">Questions</span>
        </Button>
        <Link href={back} className={cx(btnCls("secondary", "sm"), "md:ml-0")}>
          Save and exit
        </Link>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[264px_minmax(0,1fr)_420px]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-line bg-canvas/60 xl:block">{list}</aside>

        {finished ? (
          <section className="grid place-items-center p-8 lg:col-span-2">
            <Finished study={study} version={version} onRevisit={go} />
          </section>
        ) : (
          <>
            <section aria-label="The spot in the contract" className="flex h-[48vh] min-h-0 flex-col gap-3 p-4 lg:h-auto lg:p-5">
              {current.where.length > 1 && (
                <div role="group" aria-label="Places in the contract" className="flex flex-wrap gap-1.5">
                  {current.where.map((w, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={i === spotIdx}
                      onClick={() => setSpotAt({ item: current.id, i })}
                      className={cx("h-8 rounded-full px-3 text-small font-medium transition-colors", i === spotIdx ? "bg-ink text-surface" : "bg-ink/[0.05] text-ink-2 hover:bg-ink/[0.08]")}
                    >
                      Page {w.page}
                    </button>
                  ))}
                </div>
              )}
              {spot ? (
                <div className="min-h-0 flex-1">
                  <SpotView documents={study.documents} spot={spot} zoom={zoom} onZoom={setZoom} />
                </div>
              ) : (
                <div className="grid flex-1 place-items-center rounded-card bg-sunken text-body text-muted">This question isn&apos;t about one spot on a page.</div>
              )}
            </section>

            <section aria-label="Question" className="min-h-0 overflow-y-auto border-t border-line px-6 py-6 lg:border-t-0 lg:border-l">
              {itemStatus(current) === "differs" ? (
                <Mismatch key={current.id} item={current} byHand={version.byHand} busy={answer.isPending} canAnswer={!!by} error={answer.error} onAnswer={(b) => send(current, b)} />
              ) : (itemStatus(current) === "done" || itemStatus(current) === "cant_tell") && changing !== current.id ? (
                <Answered item={current} onChange={() => setChanging(current.id)} onNext={() => go(order.find(open)?.id ?? "__done")} />
              ) : (
                <Question
                  key={`${current.id}:${changing ?? ""}`}
                  item={current}
                  index={order.indexOf(current)}
                  total={order.length}
                  busy={answer.isPending}
                  canAnswer={!!by && !(typist && current.reason === "spot_check")}
                  error={answer.error}
                  onAnswer={(b) => send(current, b)}
                  onCancel={changing === current.id ? () => setChanging(null) : undefined}
                />
              )}
              {typist && current.reason === "spot_check" && (
                <p className="mt-4 rounded-tile bg-warn-soft px-4 py-3 text-small text-warn">You typed this contract in, so someone else has to re-type these values. Switch to another person first.</p>
              )}
              {!by && (
                <div className="mt-4">
                  <NeedsPerson />
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Sheet open={listOpen} onClose={() => setListOpen(false)} label="Questions">
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

/** The server blanks figures in a note while its value is being typed blind; say so, so "•••" isn't a mystery. */
const hidden = (note: string) => note.includes("•••") && <span className="block text-faint">Figures are hidden until it&apos;s answered, so they can&apos;t steer you.</span>;

function Heading({ item, index, total }: { item: ReviewItem; index?: number; total?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.kind === "contract_problem" ? "danger" : item.kind === "confirm_value" ? "warn" : "accent"}>{KIND_LABEL[item.kind]}</Badge>
        {item.reason === "spot_check" && <Badge tone="info">Random spot check</Badge>}
        {!item.blocking && <Badge>Not needed to approve</Badge>}
        {index !== undefined && (
          <span className="num ml-auto text-small text-faint">
            {index + 1} of {total}
          </span>
        )}
      </div>
      <h1 id={`q-${item.id}`} className="text-title font-semibold tracking-tight text-balance">
        {item.question}
      </h1>
      <p className="flex items-start gap-2 text-small text-muted">
        <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
        {whyLine(item)}
      </p>
      {item.reported && (
        <p className="flex items-start gap-2.5 rounded-tile bg-warn-soft px-4 py-3 text-small text-ink-2">
          <Flag className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
          <span>
            <span className="font-medium text-ink">Reported by {item.reported.by}:</span> “{item.reported.note}”{hidden(item.reported.note)}
          </span>
        </p>
      )}
      {item.sentBack && (
        <p className="flex items-start gap-2.5 rounded-tile bg-brand-soft px-4 py-3 text-small text-ink-2">
          <Undo2 className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={2} />
          <span>
            <span className="font-medium text-ink">Sent back by {item.sentBack.by}:</span> “{item.sentBack.note}”{hidden(item.sentBack.note)}
          </span>
        </p>
      )}
    </div>
  );
}

const CANT_REASONS = ["The print is too faint", "It's not on this page", "I'm not sure what's meant"];

function Question(props: { item: ReviewItem; index: number; total: number; onAnswer: (b: Body) => void; onCancel?: () => void; busy: boolean; canAnswer: boolean; error: unknown }) {
  const { item, onAnswer, busy, canAnswer, error, onCancel } = props;
  const [raw, setRaw] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cant, setCant] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (item.options.length) {
      if (!choice) return setMsg("Pick one of the answers, or choose “Can't tell”.");
      return onAnswer({ optionId: choice });
    }
    const p = parseAnswer(item.input ?? "text", raw);
    if ("error" in p) return setMsg(p.error);
    onAnswer({ value: p.value });
  }

  if (cant)
    return (
      <div className="flex flex-col gap-6">
        <Heading item={item} />
        <div className="flex flex-col gap-3 rounded-tile bg-sunken p-5">
          <p className="text-body font-medium">What&apos;s stopping you?</p>
          <div className="flex flex-wrap gap-2">
            {CANT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={why === r}
                onClick={() => setWhy(why === r ? null : r)}
                className={cx("h-8 rounded-full px-3.5 text-small font-medium ring-1 transition-colors", why === r ? "bg-brand-soft text-accent ring-brand/40" : "bg-surface text-ink-2 ring-line-strong hover:ring-ink/20")}
              >
                {r}
              </button>
            ))}
          </div>
          <textarea rows={2} className={cx("w-full py-2.5 text-body", fieldCls)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else the approver should know (optional)" aria-label="Note for the approver" />
          <p className="text-small text-faint">The approver sees this question and answers it before approving.</p>
        </div>
        <ErrorNote error={error} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setCant(false)}>
            Back to the question
          </Button>
          <Button variant="primary" disabled={busy || !canAnswer} onClick={() => onAnswer({ cantTell: true, note: [why, note.trim()].filter(Boolean).join(". ") || undefined })}>
            {busy ? "Saving…" : "Leave it for the approver"}
          </Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" aria-labelledby={`q-${item.id}`}>
      <Heading item={item} index={props.index} total={props.total} />

      {item.options.length > 0 ? (
        <fieldset className="flex flex-col gap-2.5">
          <legend className="sr-only">Your answer</legend>
          {item.options.map((o, i) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-start gap-3 rounded-tile px-4 py-3.5 text-body ring-1 ring-line-strong transition-colors hover:bg-sunken has-checked:bg-brand-soft has-checked:ring-2 has-checked:ring-brand"
            >
              <input type="radio" name={`opt-${item.id}`} value={o.id} checked={choice === o.id} onChange={() => (setChoice(o.id), setMsg(null))} autoFocus={i === 0} className="mt-1 accent-[var(--color-primary)]" />
              {o.label}
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`a-${item.id}`} className="text-small font-medium text-ink-2">
            What the contract says
          </label>
          <AnswerInput id={`a-${item.id}`} input={item.input ?? "text"} value={raw} onChange={(v) => (setRaw(v), setMsg(null))} />
          <p className="text-small text-faint">{item.input === "money" ? "Type the amount exactly as it's printed." : "Type it exactly as it's printed."} We don&apos;t show our reading, so it can&apos;t steer you.</p>
        </div>
      )}

      {msg && <ErrorNote>{msg}</ErrorNote>}
      <ErrorNote error={error} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Keep my earlier answer
          </Button>
        ) : (
          <Button variant="ghost" disabled={busy || !canAnswer} onClick={() => setCant(true)}>
            <CircleHelp className="size-4" strokeWidth={1.75} /> Can&apos;t tell
          </Button>
        )}
        <Button type="submit" variant="primary" size="lg" disabled={busy || !canAnswer}>
          {busy ? "Saving…" : "Save and next"}
          {!busy && <CornerDownLeft className="size-4 opacity-80" strokeWidth={2} />}
        </Button>
      </div>
    </form>
  );
}

/**
 * After a typed value (or a pick) differs: pick the one the page shows. Where the PDF's text has the value, keeping your
 * own over it needs a note saying why. Where it doesn't (a scan, a number the check couldn't find, a pick), either one
 * needs a note saying where the page prints it: nothing else backs the answer, so the approver checks it against that.
 */
function Mismatch(props: { item: ReviewItem; byHand: boolean; onAnswer: (b: Body) => void; busy: boolean; canAnswer: boolean; error: unknown }) {
  const { item, byHand, onAnswer, busy, canAnswer, error } = props;
  const c = item.compare!;
  const input = item.input ?? "text";
  const pick = item.options.length > 0;
  const shown = (v: unknown) => (pick ? (item.options.find((o) => o.id === String(v))?.label ?? formatAnswer(null, v)) : formatAnswer(input, v));
  // read as the server reads it: a full stop or comma after the number isn't part of it
  const text = !pick && c.printed !== null ? parseAnswer(input, c.printed.trim().replace(/[.,;:]+$/, "")) : null;
  const pdf = text && "value" in text ? text : null;
  const other = pdf
    ? { label: "The PDF text says", hint: "The text stored inside the PDF file at this spot", value: pdf.value, shown: c.printed!.trim() }
    : byHand
      ? { label: "Typed in by hand", hint: "What was typed in when this contract was entered by hand", value: c.read, shown: shown(c.read) }
      : { label: "We read", hint: "What our reading of the page picked up", value: c.read, shown: shown(c.read) };
  const [pickedOwn, setPickedOwn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const needsNote = pickedOwn !== null && (!pdf || pickedOwn);
  const why = pdf ? "Add a short note saying why the PDF text is wrong here." : "Add a short note saying where the page prints this value.";

  const options = [
    { own: true, label: pick ? "You picked" : "You typed", hint: "What you just entered from the close-up", shown: shown(c.typed) },
    { own: false, ...other },
  ];

  function save() {
    if (pickedOwn === null) return setMsg("Pick the value the page shows.");
    if (needsNote && !note.trim()) return setMsg(why);
    const value = pickedOwn ? c.typed : other.value;
    onAnswer({ ...(pick ? { optionId: String(value) } : { value }), ...(note.trim() ? { note: note.trim() } : {}) });
  }

  return (
    <div className="flex flex-col gap-6">
      <Heading item={item} />
      <div className="flex items-start gap-2.5 rounded-tile bg-warn-soft px-4 py-3 text-body text-ink-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
        {pdf ? (
          <p>
            <span className="font-medium">Look at the close-up again.</span> What you typed is different from the PDF&apos;s own text. Which one does the page show?
          </p>
        ) : (
          <p>
            <span className="font-medium">Look at the close-up again.</span> What you {pick ? "picked" : "typed"} is different from {byHand ? "what was typed in by hand" : "what we read"}.{" "}
            {item.reason === "SCAN_VALUE"
              ? "This contract is a scan, so"
              : byHand
                ? "This contract was typed in by hand, so"
                : pick
                  ? "A choice like this isn't in the PDF's text, so"
                  : "This number isn't in the PDF's text, so"}{" "}
            only the page itself can say which is right. Pick the one it shows, and say where it&apos;s printed.
          </p>
        )}
      </div>
      <div role="radiogroup" aria-label="Which value is right" className="flex flex-col gap-2.5">
        {options.map((o) => (
          <button
            key={String(o.own)}
            type="button"
            role="radio"
            aria-checked={pickedOwn === o.own}
            onClick={() => (setPickedOwn(o.own), setMsg(null))}
            className={cx(
              "flex items-center justify-between gap-4 rounded-tile px-4 py-4 text-left ring-1 transition-colors",
              pickedOwn === o.own ? "bg-brand-soft ring-2 ring-brand" : "ring-line-strong hover:bg-sunken",
            )}
          >
            <span>
              <span className="block text-body text-ink-2">{o.label}</span>
              <span className="block text-small text-faint">{o.hint}</span>
            </span>
            <span className="num text-title font-semibold tracking-tight">{o.shown}</span>
          </button>
        ))}
      </div>
      {needsNote && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`n-${item.id}`} className="text-small font-medium text-ink-2">
            {pdf ? "Why is the PDF text wrong here?" : "Where on the page is it printed?"}
          </label>
          <textarea
            id={`n-${item.id}`}
            rows={2}
            className={cx("w-full py-2.5 text-body", fieldCls)}
            value={note}
            onChange={(e) => (setNote(e.target.value), setMsg(null))}
            placeholder={pdf ? "e.g. The page clearly prints $98.00" : "e.g. Page 9, Week 4 column, Spirometry row"}
            aria-describedby={`nh-${item.id}`}
          />
          <p id={`nh-${item.id}`} className="text-small text-faint">
            {pdf ? "The approver reads your note before approving." : "Nothing in the PDF's text can confirm either value, so the approver checks your answer against this note. Name the page and where on it."}
          </p>
        </div>
      )}
      {msg && <ErrorNote>{msg}</ErrorNote>}
      <ErrorNote error={error} />
      <div className="flex justify-end border-t border-line pt-5">
        <Button variant="primary" size="lg" disabled={busy || !canAnswer} onClick={save}>
          {busy ? "Saving…" : "Save and next"}
        </Button>
      </div>
    </div>
  );
}

/** A settled question opened from the list: what was answered, by whom, and a way to change it. */
function Answered({ item, onChange, onNext }: { item: ReviewItem; onChange: () => void; onNext: () => void }) {
  const a = item.answer;
  const st = itemStatus(item);
  const shown = a?.optionId ? item.options.find((o) => o.id === a.optionId)?.label : a?.value !== undefined ? formatAnswer(item.input, a.value) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <Heading item={item} />
      <div className={cx("flex flex-col gap-2 rounded-tile p-5", st === "done" ? "bg-ok-soft" : "bg-warn-soft")}>
        <p className={cx("flex items-center gap-2 text-body font-medium", st === "done" ? "text-ok" : "text-warn")}>
          {st === "done" ? <CheckCircle2 className="size-4" strokeWidth={2} /> : <CircleHelp className="size-4" strokeWidth={2} />}
          {item.outcome === "matched" ? "Matches the contract" : item.outcome === "chosen" ? "Decided" : "Left for the approver"}
        </p>
        {shown && <p className="num text-heading font-semibold tracking-tight">{shown}</p>}
        {a?.note && <p className="text-small text-ink-2">“{a.note}”</p>}
        {a?.noPdfText && <p className="text-small text-muted">Not in the PDF text, so the approver checks this one against your note.</p>}
        {a && (
          <p className="text-small text-muted">
            {a.by} · {relativeTime(a.at)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <Button onClick={onChange}>{st === "cant_tell" ? "Answer it now" : "Change answer"}</Button>
        <Button variant="primary" onClick={onNext}>
          Next question <ArrowRight className="size-4" strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}

function Finished({ study, version, onRevisit }: { study: StudyDetailDto; version: RulebookVersionDto; onRevisit: (id: string) => void }) {
  const count = (o: ReviewItem["outcome"]) => version.review.filter((i) => i.outcome === o).length;
  const cant = queueOrder(version.review.filter((i) => i.outcome === "cant_tell"));
  const open = needsYou(version.review);
  return (
    <div className="flex w-full max-w-[560px] flex-col items-center gap-6 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
        <PartyPopper className="size-7" strokeWidth={1.75} />
      </span>
      <div>
        <h1 className="text-display font-semibold tracking-tight">{open.length ? "Almost done" : "Every question has an answer"}</h1>
        <p className="mt-2 text-lead text-muted">
          {count("matched")} matched the contract · {count("chosen")} decided · {cant.length} left for the approver
        </p>
      </div>
      {open.length > 0 && (
        <p className="rounded-tile bg-warn-soft px-4 py-3 text-body text-ink-2">
          {open.length} {open.length === 1 ? "question still needs" : "questions still need"} an answer before approval. The approver can answer {open.length === 1 ? "it" : "them"}, or you can now.
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2.5">
        {cant.length > 0 && <Button onClick={() => onRevisit(cant[0]!.id)}>Look at the &quot;can&apos;t tell&quot; ones</Button>}
        <Link href={`/studies/${study.id}/approve`} className={btnCls("primary", "lg")}>
          Go to approval <ArrowRight className="size-[18px]" strokeWidth={2} />
        </Link>
      </div>
      <p className="text-small text-faint">You can change any answer from the list on the left until the contract is approved.</p>
    </div>
  );
}

/** Empty input of the item's kind. Never pre-filled: the tool's reading stays hidden until you answer. */
function AnswerInput({ id, input, value, onChange }: { id: string; input: NonNullable<ReviewItem["input"]>; value: string; onChange: (v: string) => void }) {
  const common = { id, value, autoFocus: true, autoComplete: "off", onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  if (input === "date") return <input {...common} type="date" className={cx(inputBase, "w-56")} />;
  if (input === "text") return <input {...common} className={inputCls} />;
  const affix = input === "money" ? "$" : input === "percent" ? "%" : null;
  return (
    <div className="relative w-64">
      {affix && <span className={cx("pointer-events-none absolute top-1/2 -translate-y-1/2 text-lead text-muted", affix === "$" ? "left-4" : "right-4")}>{affix}</span>}
      <input {...common} inputMode="decimal" placeholder={input === "money" ? "0.00" : ""} className={cx("num h-12 w-full text-lead", fieldCls, affix === "$" && "pl-8", affix === "%" && "pr-9")} />
    </div>
  );
}
