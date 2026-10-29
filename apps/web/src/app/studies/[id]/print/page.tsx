"use client";

import { billedGrids } from "@dct/shared";
import { Printer } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { formatCap } from "@/components/RulebookView";
import { Button, LoadError, Spinner } from "@/components/ui";
import { keyTerms } from "@/lib/approve";
import { ENUM_OPTIONS, formatDate, formatValue } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { useStudy, useVersion } from "@/lib/queries";

const th = "border-b border-ink/20 px-2 py-1.5 text-left font-semibold";
const td = "border-b border-ink/10 px-2 py-1.5 align-top";

/** A printable summary of an approved invoicing master (the browser saves it as PDF). Every rate is in the Excel export. */
export default function PrintSummary() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const v = Number(sp.get("v")) || study.data?.liveVersion || null;
  const version = useVersion(id, v);
  const printed = useRef(false);
  const ready = !!study.data && !!version.data?.rulebook && (version.data.status === "signed" || version.data.status === "superseded");

  useEffect(() => {
    if (!ready || printed.current) return;
    printed.current = true;
    // Let the layout settle before the print dialog takes its snapshot.
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [ready]);

  const failed = (!study.data && study.error) || (!version.data && version.error);
  if (failed) return <LoadError error={failed} retry={() => void (study.error ? study.refetch() : version.refetch())} back={{ href: `/studies/${id}`, label: "Back to the contract" }} />;
  if (!study.data || !version.data) return <div className="p-8"><Spinner label="Preparing the summary" /></div>;
  if (!ready) return <p className="p-8 text-body text-muted">Only an approved version has a summary to print.</p>;

  const s = study.data;
  const ver = version.data;
  const rb = ver.rulebook!;
  const terms = keyTerms(rb, ver.evidence);
  // each arm's chosen grid, and every grid of an arm with no choice
  const grids = billedGrids(rb);

  return (
    <div className="mx-auto max-w-[900px] px-8 py-8 text-small text-ink print:max-w-none print:p-0">
      <div className="mb-8 flex items-center justify-between gap-3 print:hidden">
        <Link href={`/studies/${s.id}`} className="text-small text-muted hover:text-ink">
          ← Back to the contract
        </Link>
        <Button variant="primary" onClick={() => window.print()}>
          <Printer className="size-4" strokeWidth={1.75} /> Print or save as PDF
        </Button>
      </div>

      <header className="mb-6 border-b-2 border-ink pb-4">
        <p className="text-caption tracking-wide text-muted uppercase">Invoicing master · summary</p>
        <h1 className="text-display font-semibold tracking-tight">{s.protocol ?? "Contract"}</h1>
        <p className="mt-1 text-body">
          {[s.sponsor, s.siteName, s.investigator].filter(Boolean).join(" · ")}
        </p>
        <p className="mt-1 text-muted">
          Version {ver.version} · {ver.status === "signed" ? "live" : "replaced by a later version"} · approved by {ver.signedBy} on {formatDate(ver.signedAt)}
          {rb.appliesFrom.value && ` · applies from ${formatDate(rb.appliesFrom.value)}`}
        </p>
      </header>

      <Part title="Key terms">
        <dl className="grid grid-cols-2 gap-x-8">
          {terms.map((t) => (
            <div key={t.id} className="flex break-inside-avoid justify-between gap-4 border-b border-ink/10 py-1.5">
              <dt className="text-muted">{t.label}</dt>
              <dd className="text-right">
                <span className="num font-medium">{t.value}</span>
                {t.detail && <span className="block text-caption text-muted">{t.detail}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </Part>

      {grids.map((g) => {
        const visits = [...g.visits].sort((a, b) => a.order - b.order);
        return (
          <Part key={g.id} title={`Budget: ${g.label}${g.arm ? ` · ${g.arm}` : ""}`}>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Procedure</th>
                  <th className={th}>Code</th>
                  <th className={`${th} text-right`}>Unit price</th>
                </tr>
              </thead>
              <tbody>
                {g.procedures.map((p, i) => (
                  <tr key={i} className="break-inside-avoid">
                    <td className={td}>{p.name}</td>
                    <td className={td}>{p.code ?? ""}</td>
                    <td className={`${td} num text-right`}>{formatCents(p.unitCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="mt-4 w-full">
              <thead>
                <tr>
                  <th className={th}>Visit</th>
                  <th className={`${th} text-right`}>Visit total</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((x) => (
                  <tr key={x.code} className="break-inside-avoid">
                    <td className={td}>
                      {x.code} · {x.name}
                      {x.autopay === false && <span className="text-muted"> (invoice)</span>}
                    </td>
                    <td className={`${td} num text-right`}>{formatCents(x.totalCents)}</td>
                  </tr>
                ))}
                {g.perPatientTotals.map((t, i) => (
                  <tr key={`t${i}`} className="font-semibold">
                    <td className={td}>{t.label}</td>
                    <td className={`${td} num text-right`}>{formatCents(t.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Part>
        );
      })}

      {rb.siteFees.length > 0 && (
        <Part title="Site fees">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Fee</th>
                <th className={th}>When</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rb.siteFees.map((f, i) => (
                <tr key={i} className="break-inside-avoid">
                  <td className={td}>{f.name}</td>
                  <td className={td}>
                    {ENUM_OPTIONS.trigger?.[f.trigger] ?? f.trigger}
                    {f.dueDays !== null && `, due in ${f.dueDays} days`}
                  </td>
                  <td className={`${td} num text-right`}>{formatCents(f.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Part>
      )}

      {rb.invoiceables.length > 0 && (
        <Part title="Invoiceables">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Item</th>
                <th className={th}>Frequency · cap</th>
                <th className={th}>Needs</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rb.invoiceables.map((x, i) => (
                <tr key={i} className="break-inside-avoid">
                  <td className={td}>
                    {x.name}
                    {x.requiresPreApproval && <span className="block text-caption text-muted">Needs pre-approval</span>}
                  </td>
                  <td className={td}>
                    {x.frequency} · {formatCap(x.cap)}
                  </td>
                  <td className={td}>{x.requiredDocs.join(", ") || "—"}</td>
                  <td className={`${td} num text-right`}>{formatCents(x.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Part>
      )}

      <Part title="Bill by hand">
        {rb.unclassified.length ? (
          <>
            <p className="mb-2 text-muted">These money terms have no place in the invoicing master, so nothing bills them automatically. Bill each one by hand, from the contract&apos;s own words.</p>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>What the contract says</th>
                  <th className={th}>Page</th>
                  <th className={`${th} text-right`}>Amounts</th>
                </tr>
              </thead>
              <tbody>
                {rb.unclassified.map((u, i) => (
                  <tr key={i} className="break-inside-avoid">
                    <td className={td}>
                      {u.quote ? `“${u.quote}”` : u.label}
                      {u.note && <span className="block text-caption text-muted">{u.note}</span>}
                    </td>
                    <td className={td}>{u.page}</td>
                    <td className={`${td} num text-right`}>{u.amounts.map((c) => formatCents(c)).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="text-muted">Nothing: every money term the contract has is in the invoicing master.</p>
        )}
      </Part>

      <Part title="Payment terms">
        <dl>
          {(
            [
              ["Every invoice must show", "/payment/requiredReferences/value", rb.payment.requiredReferences.value],
              ["Paid only when", "/payment/paymentConditions/value", rb.payment.paymentConditions.value],
              ["Invoice address", "/payment/invoiceAddress/value", rb.payment.invoiceAddress.value],
              ["Rounding", "/rounding/value", rb.rounding.value],
            ] as [string, string, unknown][]
          ).map(([label, path, value]) => (
            <div key={label} className="flex break-inside-avoid justify-between gap-6 border-b border-ink/10 py-1.5">
              <dt className="text-muted">{label}</dt>
              <dd className="text-right">{formatValue(path, value)}</dd>
            </div>
          ))}
          {rb.deadlines.map((d, i) => (
            <div key={i} className="flex break-inside-avoid justify-between gap-6 border-b border-ink/10 py-1.5">
              <dt className="text-muted">{(ENUM_OPTIONS.kind?.[d.kind] ?? d.kind).replace("N", String(d.value))}</dt>
              <dd className="text-right">{d.consequence}</dd>
            </div>
          ))}
        </dl>
      </Part>

      <p className="mt-8 text-caption text-muted">
        Printed {formatDate(new Date().toISOString())} from DCT Finance. Every rate per visit is in the Excel export.
      </p>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7 break-inside-avoid-page">
      <h2 className="mb-2 text-title font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
