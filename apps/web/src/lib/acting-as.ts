"use client";

import { useSyncExternalStore } from "react";

/**
 * "Acting as" person. Signed in (UAT login): the name the sign-in set in the dct_user cookie, fixed. Otherwise a name
 * picked in this browser.
 * ponytail: the page asserts its own name to the API either way; real authentication takes it from the session.
 */

const KEY = "dct.actingAs";
const listeners = new Set<() => void>();

/** The display name the sign-in set, or null when nobody signed in. */
function signedIn(): string | null {
  const m = document.cookie.match(/(?:^|; )dct_user=([^;]*)/);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

function read(): string | null {
  const name = signedIn();
  if (name) return name;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActingAs(name: string | null) {
  if (signedIn()) return;
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

/** True when the name comes from a sign-in, so it can't be switched here. */
export const useSignedIn = () => useSyncExternalStore(subscribe, () => signedIn() !== null, () => false);

/** "Who's working today?" picker, opened from the sidebar. */
const promptListeners = new Set<() => void>();
let promptOpen = false;

export function askForPerson(open = true) {
  promptOpen = open;
  promptListeners.forEach((l) => l());
}

const subscribePrompt = (l: () => void) => {
  promptListeners.add(l);
  return () => {
    promptListeners.delete(l);
  };
};

export const usePersonPrompt = () => useSyncExternalStore(subscribePrompt, () => promptOpen, () => false);
