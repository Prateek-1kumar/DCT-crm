"use client";

import type { ReactNode } from "react";
import { Badge, Button, Card, Field, inputCls, PageTitle, pageCls, ProgressBar, type Tone } from "@/components/ui";

/** Design system reference (not in the sidebar). Hex values mirror app/globals.css. */

const surfaces = [
  ["Canvas", "#F3F3F0", "bg-canvas", "App background"],
  ["Surface", "#FFFFFF", "bg-surface", "Cards"],
  ["Sunken", "#F7F7F4", "bg-sunken", "Wells, table headers"],
  ["Line", "#ECECE7", "bg-line", "Dividers inside cards"],
  ["Line strong", "#DDDDD6", "bg-line-strong", "Input borders"],
] as const;

const text = [
  ["Ink", "#161616", "text-ink", "Headings, values", "18.1:1"],
  ["Ink 2", "#3F3F3B", "text-ink-2", "Labels, strong body", "10.6:1"],
  ["Muted", "#5E5E5A", "text-muted", "Body, descriptions", "6.5:1"],
  ["Faint", "#6E6E68", "text-faint", "Hints, timestamps", "5.1:1"],
] as const;

const brand = [
  ["Brand", "#6487D7", "bg-brand", "Active menu item, focus, progress, highlights"],
  ["Button", "#4A6CC4", "bg-primary", "Main buttons (white text 5.0:1)"],
  ["Link", "#3F5FB0", "bg-accent", "Links and selected text (6.0:1)"],
  ["Brand soft", "#EEF2FC", "bg-brand-soft", "Selected rows, soft fills"],
  ["Look here", "#F5C451", "bg-highlight-strong", "The spot on the contract page"],
] as const;

const statuses: [string, Tone, string, string][] = [
  ["Matches the PDF", "ok", "#1E7A50 on #E7F6EE · 4.8:1", "The PDF's own text says the same number. Nothing to do."],
  ["Confirmed by a person", "info", "#5B3FC4 on #EFEBFC · 6.1:1", "Someone typed it from the page."],
  ["Needs you", "warn", "#9A5B00 on #FCF1DF · 4.9:1", "Waiting for a person to look."],
  ["Problem in the contract", "danger", "#B3261E on #FBE8E6 · 5.5:1", "The document itself doesn't add up."],
];

const typeScale = [
  ["Figure", "text-figure font-semibold tracking-tight", "34 / 40 · 600", "$1,245,020"],
  ["Display", "text-display font-semibold tracking-tight", "28 / 34 · 600", "Contracts"],
  ["Heading", "text-heading font-semibold tracking-tight", "22 / 28 · 600", "Check the summary, then approve"],
  ["Title", "text-title font-semibold tracking-tight", "17.5 / 25 · 600", "Northwind Pharma · NWP-418-02"],
  ["Lead", "text-lead text-muted", "15.5 / 24 · 400", "Each signed contract becomes an invoicing master."],
  ["Body", "text-body", "14 / 22 · 400", "What amount is printed for the Visit 4 total?"],
  ["Small", "text-small text-muted", "12.5 / 18 · 400", "Updated 6 days ago by Avery Chen"],
  ["Caption", "eyebrow", "11.5 / 16 · 500 caps", "Needs you"],
] as const;

const amounts = ["$1,245.20", "$98.00", "$12,000.00", "$717.40", "$1,050.20", "$4.50"];

const grid = [
  ["Informed consent", "99202", "$185.00", "ok", "$185.00", "ok", "—", null],
  ["Physical exam", "99213", "$142.00", "ok", "$142.00", "ok", "$142.00", "ok"],
  ["Spirometry", "94010", "$98.00", "ok", "$98.00", "info", "$98.00", "ok"],
  ["Blood draw", "36415", "$25.00", "ok", "$25.00", "warn", "$25.00", "ok"],
] as const;

const DOT: Record<string, string> = { ok: "bg-ok", info: "bg-info", warn: "bg-warn", danger: "bg-danger" };

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <Card className="p-8">
      <h2 className="text-title font-semibold tracking-tight">{title}</h2>
      {sub && <p className="mt-1 text-body text-muted">{sub}</p>}
      <div className="mt-6">{children}</div>
    </Card>
  );
}

function Swatch({ name, hex, cls, use, ratio }: { name: string; hex: string; cls: string; use: string; ratio?: string }) {
  return (
    <div className="flex items-center gap-4">
      <span className={`size-12 shrink-0 rounded-tile ring-1 ring-ink/10 ${cls}`} />
      <div className="min-w-0">
        <p className="text-body font-medium">
          {name} <span className="num ml-1 text-small text-faint">{hex}</span>
        </p>
        <p className="text-small text-muted">
          {use}
          {ratio && <span className="num"> · {ratio} on white</span>}
        </p>
      </div>
    </div>
  );
}

export default function DesignPage() {
  return (
    <div className={pageCls}>
      <PageTitle eyebrow="DCT Finance" title="Design system" sub="The pieces every screen is built from. Soft premium, light mode, Inter at 14px. Every text color passes the 4.5:1 readability minimum." />

      <div className="grid gap-6">
        <Section title="Main button color" sub="Your color #6487D7 is lovely as a fill, but white text on it reads at 3.5:1, below the 4.5:1 minimum for button text. The same blue one step deeper keeps the look and stays readable.">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col items-start gap-3 rounded-tile bg-sunken p-6">
              <button type="button" className="inline-flex h-10 items-center rounded-full bg-brand px-5 font-medium text-white shadow-button">
                Approve invoicing master
              </button>
              <p className="text-small text-muted">
                <span className="num font-medium text-ink">#6487D7</span> · white text 3.5:1 · too faint for button text
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 rounded-tile bg-sunken p-6">
              <Button variant="primary">Approve invoicing master</Button>
              <p className="text-small text-muted">
                <span className="num font-medium text-ink">#4A6CC4</span> · white text 5.0:1 · recommended for buttons; #6487D7 stays the brand color
              </p>
            </div>
          </div>
        </Section>

        <Section title="Color">
          <div className="grid gap-10 lg:grid-cols-3">
            <div className="grid content-start gap-5">
              <p className="eyebrow">Surfaces</p>
              {surfaces.map(([n, h, c, u]) => (
                <Swatch key={n} name={n} hex={h} cls={c} use={u} />
              ))}
            </div>
            <div className="grid content-start gap-5">
              <p className="eyebrow">Text</p>
              {text.map(([n, h, c, u, r]) => (
                <div key={n} className="flex items-center gap-4">
                  <span className={`grid size-12 shrink-0 place-items-center rounded-tile bg-sunken text-title font-semibold ${c}`}>Aa</span>
                  <div>
                    <p className="text-body font-medium">
                      {n} <span className="num ml-1 text-small text-faint">{h}</span>
                    </p>
                    <p className="text-small text-muted">
                      {u} <span className="num">· {r} on white</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid content-start gap-5">
              <p className="eyebrow">Brand</p>
              {brand.map(([n, h, c, u]) => (
                <Swatch key={n} name={n} hex={h} cls={c} use={u} />
              ))}
            </div>
          </div>
        </Section>

        <Section title="Status" sub="Four colors, one meaning each, used the same way on every screen. Blue is kept for buttons and links, so 'confirmed by a person' is violet.">
          <div className="grid gap-4 md:grid-cols-2">
            {statuses.map(([label, tone, spec, meaning]) => (
              <div key={label} className="flex items-start gap-4 rounded-tile bg-sunken p-5">
                <Badge tone={tone} dot>
                  {label}
                </Badge>
                <div>
                  <p className="text-body">{meaning}</p>
                  <p className="num text-small text-faint">{spec}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type" sub="Inter. Headings are semibold and set tight; body text is regular. All numbers use tabular digits, so amounts line up.">
          <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
            <div className="divide-y divide-line">
              {typeScale.map(([name, cls, spec, sample]) => (
                <div key={name} className="grid grid-cols-[110px_1fr] items-baseline gap-4 py-4 first:pt-0">
                  <div>
                    <p className="text-small font-medium">{name}</p>
                    <p className="num text-caption text-faint">{spec}</p>
                  </div>
                  <p className={`${cls} truncate`}>{sample}</p>
                </div>
              ))}
            </div>
            <div className="rounded-tile bg-sunken p-5">
              <p className="eyebrow mb-3">Digits line up</p>
              <ul className="num grid gap-1.5 text-right text-lead">
                {amounts.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          </div>
        </Section>

        <Section title="Shape and depth" sub="Big soft corners and quiet shadows instead of hard borders.">
          <div className="grid gap-6 sm:grid-cols-4">
            {[
              ["Card", "rounded-card shadow-card", "22px · soft shadow"],
              ["Tile", "rounded-tile shadow-card", "16px"],
              ["Field", "rounded-field ring-1 ring-line-strong", "14px · hairline"],
              ["Raised", "rounded-card shadow-raised", "Dialogs, menus"],
            ].map(([n, cls, spec]) => (
              <div key={n} className="flex flex-col gap-3">
                <div className={`h-28 bg-surface ${cls}`} />
                <p className="text-body font-medium">
                  {n} <span className="text-small font-normal text-faint">{spec}</span>
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg">
              Start answering →
            </Button>
            <Button variant="primary">Approve</Button>
            <Button>Read it again</Button>
            <Button variant="ghost">Can&apos;t tell</Button>
            <Button variant="danger">Remove file</Button>
            <Button variant="primary" disabled>
              Approve
            </Button>
            <Button size="sm">This looks wrong</Button>
          </div>
        </Section>

        <Section title="Inputs" sub="Empty until a person types: never pre-filled with the tool's reading.">
          <div className="grid gap-6 md:grid-cols-3">
            <Field label="What the contract says" htmlFor="d-empty" hint="Type the amount exactly as printed.">
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted">$</span>
                <input id="d-empty" className={`${inputCls} num pl-7`} placeholder="0.00" />
              </div>
            </Field>
            <Field label="Focused" htmlFor="d-focus">
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted">$</span>
                <input id="d-focus" className={`${inputCls} num border-brand pl-7 ring-4 ring-brand/20`} defaultValue="1,245.20" />
              </div>
            </Field>
            <Field label="Short note" htmlFor="d-err" hint={<span className="text-danger">A note is needed when your value differs.</span>}>
              <input id="d-err" aria-invalid className={inputCls} placeholder="e.g. Page 9 clearly prints $98.00" />
            </Field>
          </div>
        </Section>

        <Section title="In use" sub="A contract card and a budget table, built only from the pieces above.">
          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <div className="flex flex-col gap-5 rounded-card bg-surface p-6 shadow-raised">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-small text-muted">Northwind Pharma</p>
                  <p className="text-title font-semibold tracking-tight">NWP-418-02</p>
                </div>
                <Badge tone="warn" dot>
                  Needs you
                </Badge>
              </div>
              <div>
                <p className="num text-figure font-semibold tracking-tight">7</p>
                <p className="text-body text-muted">things need you · about 14 min</p>
              </div>
              <ProgressBar value={42} label="Checked so far" />
              <p className="num text-small text-muted">1,212 of 1,219 numbers match the contract PDF</p>
              <Button variant="primary" className="self-start">
                Start answering →
              </Button>
            </div>
            <div className="overflow-hidden rounded-card bg-surface shadow-card">
              <table className="w-full text-left text-body">
                <thead className="bg-sunken text-small text-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Procedure</th>
                    <th className="px-5 py-3 text-right font-medium">Unit</th>
                    <th className="px-5 py-3 text-right font-medium">Screening</th>
                    <th className="px-5 py-3 text-right font-medium">Week 4</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {grid.map(([name, code, unit, u, a, at, b, bt]) => (
                    <tr key={code} className="h-12 hover:bg-brand-soft/50">
                      <td className="px-5">
                        <span className="font-medium">{name}</span> <span className="num text-small text-faint">{code}</span>
                      </td>
                      {[
                        [unit, u],
                        [a, at],
                        [b, bt],
                      ].map(([v, t], i) => (
                        <td key={i} className="num px-5 text-right">
                          {t && <span aria-hidden className={`mr-2 inline-block size-2 rounded-full ${DOT[t]}`} />}
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-5 border-t border-line px-5 py-3 text-small text-muted">
                {statuses.map(([label, tone]) => (
                  <span key={label} className="inline-flex items-center gap-2">
                    <span className={`size-2 rounded-full ${DOT[tone]}`} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
