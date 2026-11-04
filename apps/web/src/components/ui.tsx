"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { ApiError } from "@/lib/api";

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

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2.5 text-body text-muted">
      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
      {label}…
    </span>
  );
}

const SERVER_TROUBLE = "Something went wrong on the server. Try again; if it keeps happening, tell the team.";

/**
 * What a failed request or a crash says on screen, in plain words. The API's 4xx messages are written for people; its
 * 5xx message carries a reference for the team. Anything else (a proxy error, a bug's message) is never shown as is.
 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!(error instanceof ApiError)) return "Something went wrong on this page. Reload it and try again.";
  if (error.status === 0) return "Can't reach DCT Finance right now. Check your connection, then try again.";
  if (error.status >= 500) return error.message.startsWith("Something went wrong") ? error.message : error.requestId ? `${SERVER_TROUBLE} (ref ${error.requestId})` : SERVER_TROUBLE;
  if (error.status === 404) return "We couldn't find this. It may have been removed, or the link is out of date.";
  // A schema error's prettified issues ("✖ … → at note") come from a malformed request, not from anything typed.
  if (/✖|→ at|\n/.test(error.message)) return "That didn't go through. Check what you entered, then try again.";
  return error.message;
}

/** A load that failed with 404, or 400 (a malformed id or version in the URL): the thing isn't there. */
const isMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);

/** `retry`: for a failed load inside a screen, a "Try again" after the message. */
export function ErrorNote({ error, children, retry }: { error?: unknown; children?: ReactNode; retry?: () => void }) {
  if (!error && !children) return null;
  return (
    <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
      {children ?? errorText(error)}
      {retry && (
        <button type="button" onClick={retry} className="ml-3 font-medium underline underline-offset-2">
          Try again
        </button>
      )}
    </p>
  );
}

/**
 * A screen whose data couldn't load: what happened and a way on. Missing things lead back to the list; anything else
 * can be tried again.
 */
export function LoadError({ error, retry, what = "this contract", back = { href: "/", label: "Back to contracts" } }: { error: unknown; retry?: () => void; what?: string; back?: { href: string; label: string } }) {
  const missing = isMissing(error);
  return (
    <div role="alert" className="mx-auto flex max-w-[560px] flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle aria-hidden className="size-5" strokeWidth={2} />
      </span>
      <h1 className="text-title font-semibold tracking-tight">{missing ? `We can't find ${what}` : `${what[0]!.toUpperCase()}${what.slice(1)} didn't load`}</h1>
      <p className="text-body text-muted">{missing ? "The link may be wrong, or it was removed." : errorText(error)}</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2.5">
        <Link href={back.href} className={btnCls(missing ? "primary" : "secondary")}>
          {back.label}
        </Link>
        {!missing && retry && (
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card bg-surface px-6 py-16 text-center shadow-card">
      <h2 className="text-title font-semibold tracking-tight">{title}</h2>
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
 * A native modal <dialog>: the browser keeps focus inside it, closes it on Escape and puts focus back where it was.
 * Showing it focuses its first control, or the one marked `data-autofocus` (React's autoFocus runs while the dialog is
 * still closed). It closes itself when the route is hidden by Next's <Activity> (cacheComponents), otherwise a top-layer
 * modal would stay on screen.
 */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  useLayoutEffect(() => {
    const d = ref.current;
    return () => d?.close();
  }, []);
  return ref;
}

export function Dialog({ open, onClose, title, children, wide, width }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; width?: string }) {
  const ref = useModal(open);
  const titleId = useId();
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

/** A panel sliding over the left edge on small screens (the menu): a modal <dialog> like Dialog. */
export function Sheet({ open, onClose, label, children, width = "w-[320px] max-w-[88vw]" }: { open: boolean; onClose: () => void; label: string; children: ReactNode; width?: string }) {
  const ref = useModal(open);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={label}
      className={cx("fixed inset-y-0 left-0 m-0 h-full max-h-none overflow-y-auto bg-canvas p-0 text-ink shadow-raised", width)}
    >
      {open && children}
    </dialog>
  );
}

/**
 * Keyboard for a role="tablist": arrow keys, Home and End move to a tab and select it. Each tab sets
 * tabIndex={selected ? 0 : -1}, so Tab enters the list once and moves on to the panel.
 */
export function onTabKeys(e: KeyboardEvent<HTMLElement>) {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[e.key];
  if (i < 0 || to === undefined) return;
  e.preventDefault();
  const tab = tabs[(to + tabs.length) % tabs.length]!;
  tab.focus();
  tab.click();
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
