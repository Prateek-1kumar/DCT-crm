"use client";

import { BadgeCheck, MessageCircleQuestion, ScanText, ShieldCheck, Stamp, Upload, type LucideIcon } from "lucide-react";
import { useSettings } from "@/lib/queries";
import { Badge, Button, Dialog } from "./ui";

type Step = { icon: LucideIcon; title: string; happens: string; you: string; time: string };

/** The pipeline in plain words, opened from the sidebar or ⌘K. */
export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const secondPerson = useSettings().data?.makerChecker ?? false;
  const steps: Step[] = [
    {
      icon: Upload,
      title: "Upload",
      happens: "You add the signed contract, scanned or the DocuSign copy. A DocuSign copy's numbers are checked against its own text, so fewer come to you.",
      you: "Drop the PDF and confirm the sponsor, study and site.",
      time: "2 min",
    },
    {
      icon: ScanText,
      title: "Reading",
      happens: "Every page is read: the budget table, fees, payment terms, holdback and deadlines. Together they become the invoicing master.",
      you: "Nothing. You can leave the page while it works.",
      time: "A few minutes",
    },
    {
      icon: ShieldCheck,
      title: "Checking",
      happens: "Each number is matched to the exact spot where the PDF prints it, and every page is searched for money terms we didn't pick up.",
      you: "Nothing. Anything that doesn't match becomes a question for you.",
      time: "Seconds",
    },
    {
      icon: MessageCircleQuestion,
      title: "Needs you",
      happens: "A short list of questions, one at a time, next to the highlighted page.",
      you: "Type what the page says. We don't show our reading first, so a wrong number can't slip past.",
      time: "Usually 5–15 min",
    },
    {
      icon: Stamp,
      title: "Approve",
      happens: secondPerson
        ? "A second person, not the one who answered, checks the summary and approves."
        : "Someone checks the summary and approves. (Settings can require a second person.)",
      you: "Read the summary and approve. Nothing is billed before this step.",
      time: "2 min",
    },
    {
      icon: BadgeCheck,
      title: "Live",
      happens: "The approved invoicing master is locked, and billing is checked against it.",
      you: "If a number ever looks wrong, click it and choose “This looks wrong”. The current version stays in use until the fix is approved.",
      time: "",
    },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="How DCT Finance works" width="w-[min(720px,95vw)]">
      <p className="text-lead text-muted">Every signed contract goes through the same six steps before anything is billed from it.</p>

      <ol className="mt-7 flex flex-col">
        {steps.map((s, i) => (
          <li key={s.title} className="relative flex gap-5 pb-7 last:pb-0">
            {i < steps.length - 1 && <span aria-hidden className="absolute top-12 bottom-1 left-[21px] w-px bg-line-strong" />}
            <span className="relative grid size-11 shrink-0 place-items-center rounded-tile bg-brand-soft text-accent">
              <s.icon className="size-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h3 className="text-title font-semibold tracking-tight">
                  <span className="num mr-2 text-faint">{i + 1}</span>
                  {s.title}
                </h3>
                {s.time && <span className="text-small text-faint">{s.time}</span>}
              </div>
              <p className="mt-1 text-body text-ink-2">{s.happens}</p>
              <p className="mt-2 text-body">
                <span className="font-medium">What you do: </span>
                <span className="text-muted">{s.you}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-8 rounded-tile bg-sunken p-5">
        <p className="text-body font-medium">What the colored dots mean</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="ok" dot>
            Matches the PDF
          </Badge>
          <Badge tone="info" dot>
            Confirmed by a person
          </Badge>
          <Badge tone="warn" dot>
            Needs you
          </Badge>
          <Badge tone="danger" dot>
            Problem in the contract
          </Badge>
        </div>
      </div>

      <div className="mt-7 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      </div>
    </Dialog>
  );
}
