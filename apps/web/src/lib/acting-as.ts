"use client";

import { useSyncExternalStore } from "react";

/** "Acting as" person, remembered per browser. No login in Phase 1. */

const KEY = "dct.actingAs";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActingAs(name: string | null) {
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: fall through, listeners still update */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === KEY && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useActingAs(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
