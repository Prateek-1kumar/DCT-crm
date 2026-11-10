import { STEPS, type StepInfo } from "@/lib/steps";
import { cx } from "../ui";

/** Five dots: filled up to the step the contract is on, that one ringed (red when the read failed). */
export function StepDots({ info }: { info: StepInfo }) {
  return (
    <span aria-hidden className="flex items-center gap-1.5">
      {STEPS.map(({ n }) => (
        <span
          key={n}
          className={cx(
            "size-2 rounded-full",
            n < info.step || (n === info.step && info.step === 5) ? "bg-brand" : n === info.step ? (info.failed ? "bg-danger ring-4 ring-danger/20" : "bg-brand ring-4 ring-brand/20") : "bg-line-strong",
          )}
        />
      ))}
    </span>
  );
}
