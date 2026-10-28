"use client";

import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Spinner } from "./ui";

/** Answering questions, proofreading and the printable summary are focus mode: no sidebar or sheet, the whole window for the task. */
const isFocus = (path: string) => /^\/studies\/[^/]+\/(review|proofread|print)/.test(path);

export function AppFrame({ children }: { children: ReactNode }) {
  const focus = isFocus(usePathname());
  const page = (
    <Suspense
      fallback={
        <div className="p-8">
          <Spinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
  if (focus)
    return (
      <>
        <Suspense>
          <Sidebar bare />
        </Suspense>
        <main className="min-h-screen bg-surface">{page}</main>
      </>
    );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[252px_minmax(0,1fr)]">
      {/* First thing Tab reaches: past the sidebar to the page. */}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:font-medium focus:shadow-raised">
        Skip to the page
      </a>
      <Suspense fallback={<aside />}>
        <Sidebar />
      </Suspense>
      {/* The work area is a white sheet resting on the off-white frame the sidebar uses. */}
      <div className="flex min-w-0 flex-col lg:py-2 lg:pr-2">
        <main id="main" className="flex flex-1 flex-col bg-surface lg:min-h-[calc(100vh-1rem)] lg:rounded-[20px] lg:shadow-sheet lg:ring-1 lg:ring-ink/[0.05]">{page}</main>
      </div>
    </div>
  );
}
