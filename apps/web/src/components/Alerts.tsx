"use client";

import type { AlertDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";
import { notify, useNotifyPermission } from "@/lib/notify";
import { useAlerts } from "@/lib/queries";
import { Button, cx, ErrorNote } from "./ui";

/** What an alert says, and where it takes you. */
function alertText(a: AlertDto): { title: string; sub: string; href: string } {
  const name = a.protocol ?? "A new contract";
  const who = a.by === "system" ? null : a.by;
  switch (a.kind) {
    case "questions_ready":
      return {
        title: `${name} has ${a.count ?? "some"} ${a.count === 1 ? "question" : "questions"} to answer`,
        sub: who ? `Added by ${who}` : "Reading finished",
        href: `/studies/${a.studyId}/review`,
      };
    case "ready_for_approval":
      return { title: `${name} is ready for approval`, sub: who ? `${who} answered the last question` : "Nothing needs answering", href: `/studies/${a.studyId}/approve` };
    case "sent_back":
      return {
        title: `${name}: ${a.count ?? "some"} ${a.count === 1 ? "answer" : "answers"} sent back`,
        sub: `${who ?? "The approver"}${a.note ? `: “${a.note}”` : ""}`,
        href: `/studies/${a.studyId}/review`,
      };
    case "couldnt_read":
      return { title: `${name} couldn't be read`, sub: "Read it again, or type it in by hand", href: `/studies/${a.studyId}` };
    case "sample_missed":
      return {
        title: `${name}: a random spot check found a wrong number`,
        sub: `${who ? `Found by ${who}. ` : ""}${a.count ?? "Some"} ${a.count === 1 ? "value" : "values"} of that kind to proofread before approval`,
        href: `/studies/${a.studyId}/proofread`,
      };
  }
}

const DOT: Record<AlertDto["kind"], string> = { questions_ready: "bg-warn", ready_for_approval: "bg-brand", sent_back: "bg-warn", couldnt_read: "bg-danger", sample_missed: "bg-danger" };

function useMarkRead() {
  const by = useActingAs();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.readAlerts({ by: by!, ...(ids ? { ids } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

/** The bell next to Search: unread count, and the recent alerts in a panel. */
export function AlertBell() {
  const by = useActingAs();
  const alerts = useAlerts(by);
  // Where the open panel goes: on <body>, as the sticky sidebar is its own stacking context, which would put the panel
  // under the page; in the small-screen menu (a modal dialog, which makes the rest of the page inert), in that dialog.
  const [host, setHost] = useState<Element | null>(null);
  const open = host !== null;
  const bell = useRef<HTMLButtonElement>(null);
  const unread = alerts.data?.pages[0]?.unread ?? 0;
  // Escape and the close button hand focus back to the bell; clicking elsewhere or opening an alert leaves it there.
  const close = (refocus: boolean) => {
    setHost(null);
    if (refocus) bell.current?.focus();
  };
  return (
    <>
      <Button
        ref={bell}
        variant="ghost"
        size="icon"
        aria-label={unread ? `Alerts, ${unread} unread` : "Alerts"}
        aria-expanded={open}
        onClick={(e) => (!by ? askForPerson() : setHost(open ? null : (e.currentTarget.closest("dialog") ?? document.body)))}
        data-alert-bell
        className="relative shrink-0"
      >
        <Bell className="size-[18px]" strokeWidth={1.75} />
        {unread > 0 && (
          <span className="num absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[10.5px] leading-none font-semibold text-surface ring-2 ring-canvas">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Button>
      {host && by && createPortal(<AlertPanel person={by} onClose={close} />, host)}
    </>
  );
}

/** Not modal: it takes focus when it opens, Tab moves through it, and it closes once focus or a click goes elsewhere. */
function AlertPanel({ person, onClose }: { person: string; onClose: (refocus: boolean) => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const alerts = useAlerts(person);
  const read = useMarkRead();
  const desktop = useNotifyPermission();
  const items = alerts.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = alerts.data?.pages[0]?.unread ?? 0;

  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest("[data-alert-bell]")) onClose(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const go = (a: AlertDto) => {
    if (!a.read) read.mutate([a.id]);
    onClose(false);
    router.push(alertText(a).href);
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Alerts"
      tabIndex={-1}
      onBlur={(e) => e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && !e.relatedTarget.closest("[data-alert-bell]") && onClose(false)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Only the panel: not the small-screen menu it may sit in.
        e.preventDefault();
        onClose(true);
      }}
      className="fixed inset-x-2 top-16 z-50 flex max-h-[min(560px,calc(100vh-5rem))] flex-col overflow-hidden rounded-card bg-surface text-ink shadow-raised ring-1 ring-ink/[0.08] lg:inset-x-auto lg:top-[70px] lg:left-[262px] lg:w-[400px]"
    >
      <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="flex-1 text-title font-semibold tracking-tight">Alerts</h2>
        {unread > 0 && (
          <Button size="sm" variant="ghost" disabled={read.isPending} onClick={() => read.mutate(undefined)}>
            Mark all read
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => onClose(true)}>
          <X className="size-4" strokeWidth={2} />
        </Button>
      </header>

      {desktop.permission === "default" && (
        <div className="flex items-center gap-3 border-b border-line bg-sunken/70 px-5 py-3 text-small">
          <BellRing className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
          <span className="flex-1 text-muted">Get a desktop alert when this tab is in the background.</span>
          <Button size="sm" onClick={() => void desktop.ask()}>
            Turn on
          </Button>
        </div>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {alerts.isPending && <li className="px-4 py-8 text-center text-small text-muted">Loading…</li>}
        {alerts.error && !alerts.data && (
          <li className="p-2">
            <ErrorNote error={alerts.error} retry={() => void alerts.refetch()} />
          </li>
        )}
        {alerts.data && !items.length && (
          <li className="px-6 py-10 text-center text-small text-muted">Nothing yet. Alerts show here when a contract needs someone.</li>
        )}
        {items.map((a) => {
          const t = alertText(a);
          return (
            <li key={a.id}>
              <button type="button" onClick={() => go(a)} className="flex w-full items-start gap-3 rounded-[12px] px-3.5 py-3 text-left hover:bg-sunken">
                <span aria-hidden className={cx("mt-1.5 size-2 shrink-0 rounded-full", a.read ? "bg-transparent" : DOT[a.kind])} />
                <span className="min-w-0 flex-1">
                  <span className={cx("block text-body", a.read ? "text-ink-2" : "font-medium text-ink")}>{t.title}</span>
                  <span className="block truncate text-small text-muted">{t.sub}</span>
                </span>
                <span className="shrink-0 text-caption text-faint" title={formatDateTime(a.at)}>
                  {relativeTime(a.at)}
                </span>
                {!a.read && <span className="sr-only">Unread</span>}
              </button>
            </li>
          );
        })}
        {alerts.hasNextPage && (
          <li className="p-2">
            <Button size="sm" variant="secondary" className="w-full justify-center" disabled={alerts.isFetchingNextPage} onClick={() => void alerts.fetchNextPage()}>
              {alerts.isFetchingNextPage ? "Loading…" : "Show older"}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Watches for new alerts while any page is open, focus mode included: a pop-up in the corner, and a desktop
 * notification when the tab is in the background (if allowed). Alerts already there when the page opened stay quiet.
 * Mount it with `key` = the person, so switching names starts a fresh baseline.
 */
export function AlertWatcher() {
  const by = useActingAs();
  const alerts = useAlerts(by);
  const read = useMarkRead();
  const router = useRouter();
  const seen = useRef<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pop, setPop] = useState<{ a: AlertDto; more: number } | null>(null);
  const latest = alerts.data?.pages[0]?.items;

  useEffect(() => {
    if (!latest) return;
    if (!seen.current) {
      seen.current = new Set(latest.map((a) => a.id));
      return;
    }
    const fresh = latest.filter((a) => !seen.current!.has(a.id) && !a.read);
    for (const a of latest) seen.current.add(a.id);
    if (!fresh.length) return;
    for (const a of fresh.slice(0, 3)) {
      const t = alertText(a);
      notify(t.title, t.sub, t.href, `study-${a.studyId}`);
    }
    setPop({ a: fresh[0]!, more: fresh.length - 1 });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPop(null), 8000);
  }, [latest]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!pop) return null;
  const t = alertText(pop.a);
  return (
    <div role="status" className="fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] items-start gap-3 rounded-tile bg-ink p-4 text-surface shadow-raised">
      <BellRing aria-hidden className="mt-0.5 size-[18px] shrink-0 text-brand-soft" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{t.title}</p>
        <p className="truncate text-small text-surface/70">
          {t.sub}
          {pop.more > 0 && ` · and ${pop.more} more`}
        </p>
        <button
          type="button"
          className="mt-2 text-small font-medium text-brand-soft underline underline-offset-2"
          onClick={() => {
            read.mutate([pop.a.id]);
            setPop(null);
            router.push(t.href);
          }}
        >
          Open
        </button>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => setPop(null)} className="text-surface/60 hover:text-surface">
        <X className="size-4" strokeWidth={2} />
      </button>
    </div>
  );
}
