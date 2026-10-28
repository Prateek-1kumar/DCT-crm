"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * Desktop alert when the tab is in the background (in the foreground the page itself shows the news).
 * Permission is asked from a button the person clicks, never on load.
 */
const supported = () => typeof Notification !== "undefined";

export function notify(title: string, body: string, href?: string) {
  if (!supported() || Notification.permission !== "granted" || !document.hidden) return;
  const n = new Notification(title, { body, icon: "/dct-mark.png" });
  n.onclick = () => {
    window.focus();
    if (href) window.location.assign(href);
    n.close();
  };
}

const noop = () => () => {};

/** Current permission ("unsupported" on the server / old browsers) and a function to ask for it. */
export function useNotifyPermission() {
  const initial = useSyncExternalStore(noop, () => (supported() ? Notification.permission : "unsupported"), () => "unsupported" as const);
  const [answered, setAnswered] = useState<NotificationPermission | null>(null);
  const ask = async () => setAnswered(await Notification.requestPermission());
  return { permission: answered ?? initial, ask };
}
