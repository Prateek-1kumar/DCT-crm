"use client";

import "./globals.css";

/** The app frame itself crashed, so this draws its own page. A plain link reloads everything from scratch. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body className="grid min-h-screen place-items-center p-6">
        <title>DCT Finance</title>
        <main role="alert" className="flex max-w-[520px] flex-col items-center gap-3 rounded-card bg-surface px-8 py-12 text-center shadow-card">
          <h1 className="text-title font-semibold tracking-tight">DCT Finance ran into a problem</h1>
          <p className="text-body text-muted">Nothing you saved is lost. Try again, or reload the app. If it keeps happening, tell the team.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload, not a client navigation */}
            <a href="/" className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 font-medium text-ink shadow-button hover:bg-sunken">
              Reload the app
            </a>
            <button type="button" onClick={retry} className="inline-flex h-9 items-center rounded-full border border-primary bg-primary px-4 font-medium text-on-primary shadow-button hover:bg-primary-hover">
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
