"use client";

import type { BudgetGrid, Rulebook, RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { blankHoldback, blankInvoiceable, blankProcedure, blankScreenFail, blankSiteFee, blankVisit, nextVisitCode } from "@/lib/byhand";
import { ENUM_OPTIONS, fieldKey, inferKind } from "@/lib/format";
import { centsToInput, parseDollars } from "@/lib/money";
import { getAt } from "@/lib/pointer";
import { keys } from "@/lib/queries";
import { NeedsPerson } from "./AppHeader";
import { PageViewer } from "./PageViewer";
import { Button, ErrorNote, cx, inputBase } from "./ui";

type Form = { rb: Rulebook; typed: Set<string>; save: (path: string, value: unknown) => Promise<void>; disabled: boolean };

/**
 * The invoicing master as an entry form, for a contract that couldn't be read. Every field starts empty; each value is
 * saved when you leave the field and counts as typed by a person. The budget grid takes rows and visits.
 */
export function ByHandForm({ study, version }: { study: StudyDetailDto; version: RulebookVersionDto }) {
  const by = useActingAs();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form: Form = {
    rb: version.rulebook!,
    typed: new Set(version.evidence.map((e) => e.path)),
    disabled: !by,
    save: async (path, value) => {
      setError(null);
      try {
        qc.setQueryData(keys.version(study.id, version.version), await api.typeValue(study.id, version.version, { path, value, by: by! }));
      } catch (e) {
        setError(e);
      }
    },
  };
  const rb = form.rb;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,4fr)_8fr]">
      <aside aria-label="Contract pages" className="h-[60vh] overflow-hidden rounded-card border border-line bg-surface shadow-card lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)]">
        <PageViewer documents={study.documents} target={null} />
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        {!by && <NeedsPerson />}
        <ErrorNote error={error} />
        <Section title="Study">
          <F form={form} label="Sponsor" path="/study/sponsor/value" empty="" />
          <F form={form} label="Paying agent / CRO" path="/study/payingAgent/value" />
          <F form={form} label="Protocol" path="/study/protocol/value" empty="" />
          <F form={form} label="Site" path="/study/siteName/value" empty="" />
          <F form={form} label="Principal investigator" path="/study/investigator/value" empty="" />
          <F form={form} label="Effective date" path="/study/effectiveDate/value" />
        </Section>
        <Section title="Payment">
          <F form={form} label="Visit payments" path="/payment/visitPayment/value" />
          <F form={form} label="Frequency" path="/payment/frequency/value" />
          <F form={form} label="Net days" path="/payment/netDays/value" />
          <F form={form} label="Net days counted from" path="/payment/netDaysFrom/value" />
          <F form={form} label="Invoice address" path="/payment/invoiceAddress/value" />
        </Section>
        <Section title="Overhead">
          <F form={form} label="Overhead %" path="/overhead/pct/value" />
          <F form={form} label="Applies to" path="/overhead/appliesTo/value" />
        </Section>
        <Section title="Budget grid">{rb.budgetGrids.length ? <GridEditor form={form} gi={0} /> : null}</Section>
        <Section title="Invoiceables">
          <ListEditor form={form} at="/invoiceables" blank={blankInvoiceable} cols={[["name", "Item", ""], ["amountCents", "Amount"], ["amountWithOverheadCents", "With overhead"], ["frequency", "How often", ""]]} />
        </Section>
        <Section title="Site fees">
          <ListEditor form={form} at="/siteFees" blank={blankSiteFee} cols={[["name", "Fee", ""], ["amountCents", "Amount"], ["trigger", "When"], ["dueDays", "Due (days)"]]} />
        </Section>
        <Section title="Screen fail">
          {rb.screenFail ? <F form={form} label="Amount" path="/screenFail/amountCents" /> : <AddButton form={form} onClick={() => form.save("/screenFail", blankScreenFail())}>Add screen-fail terms</AddButton>}
        </Section>
        <Section title="Holdback">
          {rb.holdback ? <F form={form} label="Holdback %" path="/holdback/pct" /> : <AddButton form={form} onClick={() => form.save("/holdback", blankHoldback())}>Add a holdback</AddButton>}
        </Section>
        <Section title="Rounding">
          <F form={form} label="Rounding" path="/rounding/value" />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h3 className="eyebrow mb-2">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function AddButton({ form, onClick, children }: { form: Form; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" className="self-start" disabled={form.disabled} onClick={onClick}>
      + {children}
    </Button>
  );
}

/** A labelled field. */
function F({ form, label, path, empty }: { form: Form; label: string; path: string; empty?: string }) {
  return (
    <label className="grid grid-cols-[minmax(8rem,13rem)_1fr] items-center gap-x-3 border-b border-line py-1.5 last:border-0">
      <span className="text-[13px] text-muted">{label}</span>
      <HandInput form={form} path={path} empty={empty} label={label} />
    </label>
  );
}

/**
 * One empty-until-typed input, saved on leaving it. Numbers show only once typed (the blank master holds placeholders).
 * `empty`: what an emptied field saves ("" for names, otherwise null). `commit` overrides the save (grid cells).
 */
function HandInput({ form, path, empty, label, commit }: { form: Form; path: string; empty?: string; label: string; commit?: (value: unknown) => Promise<void> }) {
  const value = getAt(form.rb, path);
  // Remount when the value or its typed-ness changes, e.g. after a row above is removed.
  return <Input key={`${JSON.stringify(value) ?? ""}|${form.typed.has(path)}`} form={form} path={path} value={value} empty={empty} label={label} commit={commit} />;
}

function Input({ form, path, value, empty = undefined, label, commit }: { form: Form; path: string; value: unknown; empty?: string; label: string; commit?: (value: unknown) => Promise<void> }) {
  const kind = inferKind(path, value);
  const shown = typeof value === "number" && !form.typed.has(path) ? null : value;
  const [raw, setRaw] = useState(() => (shown === null || shown === undefined ? "" : kind === "money" || kind === "cell" ? centsToInput(shown as number) : Array.isArray(shown) ? shown.join(", ") : String(shown)));
  const [err, setErr] = useState<string | null>(null);
  const save = (v: unknown) => (commit ?? ((x: unknown) => form.save(path, x)))(v);

  if (kind === "enum")
    return (
      <select aria-label={label} disabled={form.disabled} className={cx(inputBase, "w-auto py-1.5")} value={String(value)} onChange={(e) => void save(e.target.value)}>
        {Object.entries(ENUM_OPTIONS[fieldKey(path)] ?? {}).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    );

  function parse(t: string): { v: unknown } | { e: string } {
    if (t === "") return { v: kind === "cell" ? null : (empty ?? null) };
    if (kind === "money" || kind === "cell") {
      const c = parseDollars(t);
      return c === null || Number.isNaN(c) ? { e: "Type a dollar amount, like 1,234.56" } : { v: c };
    }
    if (kind === "int" || kind === "number") {
      const n = Number(t.replace(/[,%\s]/g, ""));
      return Number.isFinite(n) && (kind === "number" || Number.isInteger(n)) ? { v: n } : { e: kind === "int" ? "Type a whole number" : "Type a number" };
    }
    if (kind === "list") return { v: t.split(",").map((x) => x.trim()).filter(Boolean) };
    return { v: t };
  }
  const money = kind === "money" || kind === "cell";
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cx("relative", money ? "w-36" : kind === "int" || kind === "number" ? "w-28" : kind === "date" ? "w-44" : "w-full")}>
        {money && <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted">$</span>}
        <input
          aria-label={label}
          type={kind === "date" ? "date" : "text"}
          inputMode={money || kind === "number" ? "decimal" : kind === "int" ? "numeric" : undefined}
          disabled={form.disabled}
          autoComplete="off"
          value={raw}
          onChange={(e) => (setRaw(e.target.value), setErr(null))}
          onBlur={() => {
            const p = parse(raw.trim());
            if ("e" in p) return setErr(p.e);
            const before = shown === undefined ? (kind === "cell" ? null : undefined) : shown;
            if (JSON.stringify(p.v) !== JSON.stringify(before ?? (empty ?? null))) void save(p.v);
          }}
          className={cx(inputBase, "num w-full py-1.5", money && "pl-6", err && "border-danger")}
        />
      </span>
      {err && <span className="text-xs text-danger">{err}</span>}
    </span>
  );
}

function ListEditor({ form, at, cols, blank }: { form: Form; at: string; cols: [key: string, label: string, empty?: string][]; blank: () => unknown }) {
  const items = (getAt(form.rb, at) as unknown[]) ?? [];
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left">
              {cols.map(([k, l]) => (
                <th key={k} className="eyebrow px-1 pb-1.5">
                  {l}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((_, i) => (
              <tr key={i} className="align-top">
                {cols.map(([k, l, empty]) => (
                  <td key={k} className="p-1">
                    <HandInput form={form} path={`${at}/${i}/${k}`} empty={empty} label={`${l}, row ${i + 1}`} />
                  </td>
                ))}
                <td className="p-1 text-right">
                  <Button size="sm" variant="ghost" disabled={form.disabled} aria-label={`Remove row ${i + 1}`} onClick={() => form.save(at, items.filter((__, j) => j !== i))}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AddButton form={form} onClick={() => form.save(at, [...items, blank()])}>
        Add a row
      </AddButton>
    </div>
  );
}

const omit = (cells: BudgetGrid["procedures"][number]["cells"], code: string) => Object.fromEntries(Object.entries(cells).filter(([k]) => k !== code));

/** Procedure × visit grid you type into: add and remove rows and visits. An empty cell means "not done at this visit". */
function GridEditor({ form, gi }: { form: Form; gi: number }) {
  const g = form.rb.budgetGrids[gi]!;
  const base = `/budgetGrids/${gi}`;
  const visits = [...g.visits].sort((a, b) => a.order - b.order);
  const removeVisit = async (code: string) => {
    await form.save(`${base}/visits`, g.visits.filter((v) => v.code !== code));
    await form.save(`${base}/procedures`, g.procedures.map((p) => ({ ...p, cells: omit(p.cells, code) })));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-[10px] border border-line">
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className="eyebrow min-w-52 border-b border-line bg-sunken px-2 py-2 text-left">Procedure</th>
              <th className="eyebrow border-b border-line bg-sunken px-2 py-2 text-left">Unit</th>
              {visits.map((v) => (
                <th key={v.code} className="min-w-36 border-b border-line bg-sunken px-2 py-2 text-left font-normal">
                  <span className="mb-1 flex items-center justify-between gap-1">
                    <span className="eyebrow">{v.code}</span>
                    <Button size="sm" variant="ghost" className="h-5 px-1.5" disabled={form.disabled || g.visits.length <= 1} aria-label={`Remove visit ${v.code}`} onClick={() => void removeVisit(v.code)}>
                      ✕
                    </Button>
                  </span>
                  <HandInput form={form} path={`${base}/visits/${g.visits.indexOf(v)}/name`} empty="" label={`Visit ${v.code} name`} />
                </th>
              ))}
              <th className="border-b border-line bg-sunken px-2 py-2">
                <Button size="sm" disabled={form.disabled} onClick={() => form.save(`${base}/visits`, [...g.visits, blankVisit(nextVisitCode(g), g.visits.length + 1)])}>
                  + Visit
                </Button>
              </th>
            </tr>
          </thead>
          <tbody>
            {g.procedures.map((p, pi) => (
              <tr key={pi}>
                <td className="border-b border-line p-1.5">
                  <HandInput form={form} path={`${base}/procedures/${pi}/name`} empty="" label={`Procedure, row ${pi + 1}`} />
                </td>
                <td className="border-b border-line p-1.5">
                  <HandInput form={form} path={`${base}/procedures/${pi}/unitCents`} label={`Unit price, row ${pi + 1}`} />
                </td>
                {visits.map((v) => (
                  <td key={v.code} className="border-b border-line p-1.5">
                    <HandInput
                      form={form}
                      path={`${base}/procedures/${pi}/cells/${v.code}`}
                      label={`Row ${pi + 1}, ${v.code}`}
                      commit={(x) => (x === null ? form.save(`${base}/procedures/${pi}/cells`, omit(p.cells, v.code)) : form.save(`${base}/procedures/${pi}/cells/${v.code}`, x))}
                    />
                  </td>
                ))}
                <td className="border-b border-line p-1.5 text-right">
                  <Button size="sm" variant="ghost" disabled={form.disabled || g.procedures.length <= 1} aria-label={`Remove row ${pi + 1}`} onClick={() => form.save(`${base}/procedures`, g.procedures.filter((_, j) => j !== pi))}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2} className="bg-sunken px-2 py-1.5 text-left font-medium">
                Visit total
              </th>
              {visits.map((v) => (
                <td key={v.code} className="bg-sunken p-1.5">
                  <HandInput form={form} path={`${base}/visits/${g.visits.indexOf(v)}/totalCents`} label={`Visit ${v.code} total`} />
                </td>
              ))}
              <td className="bg-sunken" />
            </tr>
          </tfoot>
        </table>
      </div>
      <AddButton form={form} onClick={() => form.save(`${base}/procedures`, [...g.procedures, blankProcedure()])}>
        Add a row
      </AddButton>
      <p className="text-xs text-muted">Leave a cell empty when the procedure isn&apos;t done at that visit.</p>
    </div>
  );
}
