"use client";

import { useSyncExternalStore } from "react";

/**
 * Collapsed or expanded sidebar, remembered per browser in two slots: one for contract screens (wide
 * tables and page images, so they start collapsed) and one for everything else (starts expanded).
 */

export type ScreenKind = "contract" | "other";

/** Add a pattern here to make another screen count as a contract screen. */
const CONTRACT_SCREENS = [/^\/versions\/[^/]+\/proof\/?$/, /^\/versions\/[^/]+\/questions\/?$/];

export const screenKind = (path: string | null | undefined): ScreenKind => (path && CONTRACT_SCREENS.some((re) => re.test(path)) ? "contract" : "other");
export const isContractScreen = (path: string | null | undefined) => screenKind(path) === "contract";

export const DEFAULT_COLLAPSED: Record<ScreenKind, boolean> = { contract: true, other: false };

const KEYS: Record<ScreenKind, string> = { contract: "dct.sidebar.contract", other: "dct.sidebar.other" };
const listeners = new Set<() => void>();
// Storage can be blocked (private mode); the choice then lasts until the page is reloaded.
const memory: Partial<Record<ScreenKind, boolean>> = {};

function read(kind: ScreenKind): boolean {
  try {
    const v = localStorage.getItem(KEYS[kind]);
    if (v === "collapsed") return true;
    if (v === "expanded") return false;
  } catch {
    /* blocked: use the in-page choice below */
  }
  return memory[kind] ?? DEFAULT_COLLAPSED[kind];
}

export function setCollapsed(kind: ScreenKind, collapsed: boolean) {
  try {
    localStorage.setItem(KEYS[kind], collapsed ? "collapsed" : "expanded");
    delete memory[kind];
  } catch {
    memory[kind] = collapsed;
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    // A change in another tab: forget our in-page choice so the stored one wins.
    if (e.key && Object.values(KEYS).includes(e.key)) {
      delete memory[screenKindOfKey(e.key)];
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
const screenKindOfKey = (key: string): ScreenKind => (key === KEYS.contract ? "contract" : "other");

/**
 * The server and the first client render use the route's default (no storage on the server); React then
 * switches to the remembered choice without a hydration mismatch. Toggling changes the preference for
 * the kind of screen the person is on.
 */
export function useSidebarCollapsed(path: string | null | undefined): { collapsed: boolean; toggle: () => void } {
  const kind = screenKind(path);
  const collapsed = useSyncExternalStore(subscribe, () => read(kind), () => DEFAULT_COLLAPSED[kind]);
  return { collapsed, toggle: () => setCollapsed(kind, !collapsed) };
}
