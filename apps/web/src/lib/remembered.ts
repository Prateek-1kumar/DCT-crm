"use client";

import { useSyncExternalStore } from "react";

/** Small choices remembered per browser (how a list is sorted, where someone left off). Storage can be blocked: the choice then lasts until the page is reloaded. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The server and the first client render use `fallback` (no storage on the server); React then switches to the remembered value without a hydration mismatch. */
export function useRemembered(key: string, fallback: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(subscribe, () => recall(key) ?? fallback, () => fallback);
  return [value, (v) => remember(key, v)];
}
