"use client";

import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { stageLabel, stepsFor, type StageState } from "@/lib/review";

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
  md: "h-10 px-5 text-body",
  lg: "h-12 px-6 text-body",
  icon: "size-10",
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
    <span title={title} className={cx("inline-flex h-7 items-center gap-2 rounded-full px-3 text-small font-medium whitespace-nowrap", TONE[tone], className)}>
      {dot && <span aria-hidden className="size-2 rounded-full bg-current" />}
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

/** Upload → Reading → Checking → Needs you (n) → Approve → Live; "Typed by hand" replaces Reading and Checking. */
export function Stepper({ state, className }: { state: StageState; className?: string }) {
  const steps = stepsFor(state);
  const at = steps.findIndex((x) => x.stage === state.stage);
  return (
    <ol aria-label="Where this contract is" className={cx("flex flex-wrap items-center gap-x-1 gap-y-2", className)}>
      {steps.map(({ stage: s, label: name }, i) => {
        const done = i < at || (s === "Live" && at === i);
        const current = i === at && !done;
        const label = s === "Needs you" && state.needs && current ? `Needs you (${state.needs})` : name;
        return (
          <li key={s} aria-current={current ? "step" : undefined} className="flex items-center gap-1">
            <span
              className={cx(
                "flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-[13px]",
                current ? (state.failed ? "bg-danger-soft text-danger" : "bg-ink text-surface") : done ? "text-ink" : "text-faint",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "grid size-5 place-items-center rounded-full text-[11px]",
                  current ? "bg-surface/20" : done ? "bg-ok-soft text-ok" : "border border-line-strong",
                )}
              >
                {done ? "✓" : current && state.failed ? "!" : i + 1}
              </span>
              {state.failed && current ? "Couldn't read" : label}
              <span className="sr-only">{done ? " (done)" : current ? " (now)" : ""}</span>
            </span>
            {i < steps.length - 1 && <span aria-hidden className={cx("h-px w-4", i < at ? "bg-ok" : "bg-line-strong")} />}
          </li>
        );
      })}
    </ol>
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
  return <section className={cx("rounded-card bg-surface shadow-card", className)}>{children}</section>;
}

/** Use inputBase when setting your own width; inputCls is full-width. */
export const inputBase =
  "h-11 rounded-field border border-line-strong bg-surface px-3.5 text-body text-ink shadow-button transition-[border-color,box-shadow] placeholder:text-faint/70 focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none aria-invalid:border-danger aria-invalid:ring-danger/15";
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
export const pageCls = "mx-auto w-full max-w-[1320px] px-6 py-9 lg:px-10";
