"use client";

import { Suspense, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Spinner } from "./ui";

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[252px_minmax(0,1fr)]">
      {/* First thing Tab reaches: past the sidebar to the page. */}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:font-medium focus:shadow-raised">
        Skip to the page
      </a>
      <Sidebar />
      {/* The work area is a white sheet resting on the off-white frame the sidebar uses. */}
      <div className="flex min-w-0 flex-col lg:py-2 lg:pr-2">
        <main id="main" className="flex flex-1 flex-col bg-surface lg:min-h-[calc(100vh-1rem)] lg:rounded-[20px] lg:shadow-sheet lg:ring-1 lg:ring-ink/[0.05]">
          <Suspense
            fallback={
              <div className="p-8">
                <Spinner />
              </div>
            }
          >
            {children}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
