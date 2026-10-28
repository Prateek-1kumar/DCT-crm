"use client";

import { AlertTriangle, Check } from "lucide-react";
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { stageLabel, stageWords, stepsFor, type StageState } from "@/lib/review";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-on-primary border-primary shadow-button hover:bg-primary-hover hover:border-primary-hover",
  secondary: "bg-surface text-ink border-line-strong shadow-button hover:bg-sunken",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-ink/5",
  danger: "bg-danger text-on-primary border-danger shadow-button hover:opacity-90",
};

/** "icon" / "icon-sm": square, for a lone icon (pass aria-label). Sizes are set here, not by overriding classes, which Tailwind can't order. */
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm";
const SIZE: Record<Size, string> = {
  sm: "h-8 px-3.5 text-small",
  md: "h-9 px-4 text-body",
  lg: "h-11 px-5 text-body",
  icon: "size-9",
  "icon-sm": "size-8",
};

export const btnCls = (variant: Variant = "secondary", size: Size = "md") =>
  cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-full border font-medium whitespace-nowrap transition-colors duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none [&_svg]:shrink-0",
    SIZE[size],
    VARIANT[variant],
  );

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  function Button({ variant = "secondary", size = "md", className, type = "button", ...props }, ref) {
    return <button ref={ref} type={type} className={cx(btnCls(variant, size), className)} {...props} />;
  },
);

/** neutral · accent (brand) · ok = matches the PDF · info = confirmed by a person · warn = needs you · danger = problem */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-ink/[0.06] text-ink-2",
  accent: "bg-brand-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, className, title, dot }: { tone?: Tone; children: ReactNode; className?: string; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-small font-medium whitespace-nowrap", TONE[tone], className)}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STAGE_TONE: Record<StageState["stage"], Tone> = { Upload: "neutral", Reading: "info", Checking: "info", "Needs you": "warn", Approve: "accent", Live: "ok" };
export function StagePill({ state }: { state: StageState }) {
  return (
    <Badge tone={state.failed ? "danger" : STAGE_TONE[state.stage]} dot>
      {stageLabel(state)}
    </Badge>
  );
}

/** What the current step says under its name. */
const NOW: Record<StageState["stage"], string> = {
  Upload: "Add the files",
  Reading: "In progress",
  Checking: "In progress",
  "Needs you": "Your turn",
  Approve: "Ready to approve",
  Live: "In use",
};

/**
 * Upload → Reading → Checking → Needs you → Approve → Live ("Typed by hand" replaces Reading and Checking).
 * Done steps get a check, the current one is filled; narrow screens get the compact dot track.
 */
export function Stepper({ state, className, now }: { state: StageState; className?: string; now?: string }) {
  const steps = stepsFor(state);
  const live = state.stage === "Live";
  const at = live ? steps.length - 1 : steps.findIndex((x) => x.stage === state.stage);
  return (
    <div className={className}>
      <div className="sm:hidden">
        <StepTrack state={state} label={now} />
      </div>
      <ol aria-label="Where this contract is" className="hidden sm:flex">
        {steps.map(({ stage: s, label }, i) => {
          const done = i < at || live;
          const current = i === at && !live;
          const failed = current && state.failed;
          const sub = failed ? "Couldn't read" : current ? (s === "Needs you" && state.needs ? `${state.needs} to answer` : NOW[s]) : done ? "Done" : "";
          return (
            <li key={s} aria-current={current ? "step" : undefined} className="flex min-w-0 flex-1 flex-col gap-2.5 last:flex-none">
              <div className="flex items-center">
                <span
                  className={cx(
                    "grid size-7 shrink-0 place-items-center rounded-full text-small font-semibold transition-colors",
                    failed
                      ? "bg-danger text-on-primary ring-4 ring-danger/15"
                      : current
                        ? "bg-primary text-on-primary ring-4 ring-primary/15"
                        : done
                          ? "bg-ok-soft text-ok"
                          : "bg-surface text-faint ring-1 ring-line-strong",
                  )}
                >
                  {failed ? <AlertTriangle className="size-3.5" strokeWidth={2.25} /> : done ? <Check className="size-3.5" strokeWidth={2.5} /> : i + 1}
                </span>
                {i < steps.length - 1 && <span aria-hidden className={cx("mx-2.5 h-0.5 flex-1 rounded-full", i < at || live ? "bg-ok/40" : "bg-line-strong")} />}
              </div>
              <div className="min-w-0 pr-3">
                <p className={cx("truncate text-small font-medium", current ? "text-ink" : done ? "text-ink-2" : "text-faint")}>{label}</p>
                {sub && <p className={cx("truncate text-caption", failed ? "text-danger" : current ? "text-accent" : "text-faint")}>{sub}</p>}
                <span className="sr-only">{done ? " (done)" : current ? " (now)" : " (to do)"}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The current step's dot, halo and label color: needs you amber, approval blue, live green, couldn't read red. */
const stepTone = (s: StageState): [string, string] =>
  s.failed
    ? ["bg-danger ring-danger/15", "text-danger"]
    : s.stage === "Live"
      ? ["bg-ok ring-ok/15", "text-ok"]
      : s.stage === "Needs you"
        ? ["bg-warn ring-warn/15", "text-warn"]
        : s.stage === "Approve"
          ? ["bg-primary ring-primary/15", "text-accent"]
          : ["bg-brand ring-brand/20", "text-ink-2"];

/** Six dots (done · current · to do) and the step in words: "Needs you · step 4 of 6". */
/** `label` overrides the step's words, e.g. "Add the files" while uploading. */
export function StepTrack({ state, label: override }: { state: StageState; label?: string }) {
  const steps = stepsFor(state);
  const words = stageWords(state);
  const { step, of } = words;
  const label = override ?? words.label;
  const live = state.stage === "Live";
  const [dot, text] = stepTone(state);
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="flex items-center gap-1.5">
        {steps.map((x, i) => (
          <span
            key={x.stage}
            className={cx("rounded-full", !live && i === step - 1 ? cx("size-2.5 ring-4", dot) : cx("size-2", live ? "bg-ok" : i < step - 1 ? "bg-ink/45" : "bg-ink/12"))}
          />
        ))}
      </span>
      <span className="text-small">
        <span className={cx("font-medium", text)}>{label}</span>
        <span className="text-faint">{live ? " · all steps done" : ` · step ${step} of ${of}`}</span>
      </span>
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2.5 text-body text-muted">
      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
      {label}…
    </span>
  );
}

export function ErrorNote({ error, children }: { error?: unknown; children?: ReactNode }) {
  if (!error && !children) return null;
  const msg = children ?? (error instanceof Error ? error.message : String(error));
  return (
    <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
      {msg}
    </p>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card bg-surface px-6 py-16 text-center shadow-card">
      <p className="text-title font-semibold tracking-tight">{title}</p>
      {children && <p className="max-w-md text-body text-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-card bg-surface shadow-card ring-1 ring-ink/[0.05]", className)}>{children}</section>;
}

/**
 * fieldCls: the field look with no height, font size or width, for textareas and large inputs (two classes setting the
 * same property can't be ordered reliably). inputBase adds the standard height and size; inputCls is full-width.
 */
export const fieldCls =
  "rounded-field border border-line-strong bg-surface px-3.5 text-ink shadow-button transition-[border-color,box-shadow] placeholder:text-faint/70 focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none aria-invalid:border-danger aria-invalid:ring-danger/15";
export const inputBase = `h-10 text-body ${fieldCls}`;
export const inputCls = `w-full ${inputBase}`;

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-small font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-small text-faint">{hint}</p>}
    </div>
  );
}

/**
 * Native modal <dialog>. Closes itself when the route is hidden by Next's <Activity>
 * (cacheComponents), otherwise a top-layer modal would stay on screen.
 */
export function Dialog({ open, onClose, title, children, wide, width }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; width?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useLayoutEffect(() => {
    const d = ref.current;
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby={titleId}
      className={cx("m-auto max-h-[90vh] rounded-card bg-surface p-0 text-ink shadow-raised", width ?? (wide ? "w-[min(1200px,95vw)]" : "w-[min(560px,95vw)]"))}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <header className="flex items-center justify-between px-7 pt-6">
            <h2 id={titleId} className="text-title font-semibold tracking-tight">
              {title}
            </h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          </header>
          <div className="overflow-auto px-7 pt-3 pb-7">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} className="h-2 w-full overflow-hidden rounded-full bg-brand/15">
      <div className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function PageTitle({ eyebrow, title, sub, actions }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="text-display font-semibold tracking-[-0.025em]">{title}</h1>
        {sub && <div className="mt-2 max-w-[68ch] text-lead text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex gap-2.5">{actions}</div>}
    </div>
  );
}

/** Content column used by every page. */
export const pageCls = "mx-auto w-full max-w-[1280px] px-6 py-8 lg:px-10";
