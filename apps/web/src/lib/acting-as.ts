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

/** "Who's working today?" picker: opened from the sidebar, or once per visit by the first action that needs a name. */
const promptListeners = new Set<() => void>();
let promptOpen = false;
let prompted = false;

export function askForPerson(open = true) {
  promptOpen = open;
  promptListeners.forEach((l) => l());
}

export function askForPersonOnce() {
  if (prompted) return;
  prompted = true;
  askForPerson();
}

const subscribePrompt = (l: () => void) => {
  promptListeners.add(l);
  return () => {
    promptListeners.delete(l);
  };
};

export const usePersonPrompt = () => useSyncExternalStore(subscribePrompt, () => promptOpen, () => false);
