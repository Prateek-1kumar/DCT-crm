import { Check } from "lucide-react";
import { stepperStates, type StepInfo, type StepState } from "@/lib/steps";
import { cx } from "../ui";

const CIRCLE: Record<StepState, string> = {
  done: "border-brand bg-brand text-on-primary",
  current: "border-brand bg-surface text-brand ring-4 ring-brand/15",
  failed: "border-danger bg-surface text-danger ring-4 ring-danger/15",
  todo: "border-line-strong bg-surface text-faint",
};

/** The five steps as circles with a label and a status under each; stays five columns down to phone width. */
export function Stepper({ info }: { info: StepInfo }) {
  return (
    <ol aria-label="Where this contract is" className="grid grid-cols-5">
      {stepperStates(info).map(({ n, label, state, note }) => (
        <li key={n} aria-current={state === "current" || state === "failed" ? "step" : undefined} className="relative flex min-w-0 flex-col items-center gap-1.5 px-1 text-center">
          {n < 5 && <span aria-hidden className={cx("absolute top-4 left-1/2 h-0.5 w-full -translate-y-1/2", state === "done" ? "bg-brand" : "bg-line-strong")} />}
          <span className={cx("relative z-10 grid size-8 place-items-center rounded-full border-2 text-small font-semibold", CIRCLE[state])}>
            {state === "done" ? <Check aria-hidden className="size-4" strokeWidth={2.5} /> : n}
          </span>
          <span className={cx("text-small font-medium", state === "todo" ? "text-faint" : "text-ink")}>{label}</span>
          <span title={note} className={cx("line-clamp-2 min-h-[2.25rem] text-caption", state === "failed" ? "text-danger" : "text-muted")}>
            {note}
          </span>
        </li>
      ))}
    </ol>
  );
}
