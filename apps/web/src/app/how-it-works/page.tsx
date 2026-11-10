import Link from "next/link";
import { Card, PageTitle, pageCls } from "@/components/ui";
import { STEPS } from "@/lib/steps";

const WORDS: Record<(typeof STEPS)[number]["n"], string> = {
  1: "Add the signed contract and any amendments as PDFs. Scanned pages are fine; they just take longer to read.",
  2: "We read every page and build the rulebook: every way the site gets paid and every rule that changes money. You can leave while we read; it carries on without you.",
  3: "If we can't settle something ourselves, we ask you, one question at a time, with the page beside the options. Nothing here is guessed.",
  4: "When nothing is left to decide, look over the key terms and approve. The person who answered the decisions can't also approve; a colleague has to.",
  5: "The approved rulebook is live and can't be changed. If the contract changes, a new version is read and approved, and the old one stays on record.",
};

export default function HowItWorks() {
  return (
    <div className={pageCls}>
      <PageTitle title="How it works" sub="Every contract goes through the same five steps. The contract list and each contract's page show where it is." />
      <ol className="flex max-w-[720px] flex-col gap-4">
        {STEPS.map(({ n, label }) => (
          <li key={n}>
            <Card className="flex items-start gap-4 p-5">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-small font-semibold text-accent">
                {n}
              </span>
              <div className="min-w-0">
                <h2 className="text-title font-semibold tracking-tight">{label}</h2>
                <p className="mt-1 text-body text-muted">{WORDS[n]}</p>
              </div>
            </Card>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-body text-muted">
        Ready? <Link href="/studies/new" className="font-medium text-accent hover:underline">Add a contract</Link>.
      </p>
    </div>
  );
}
