import { notices, type RulebookVersionDto } from "@dct/shared";
import { AlertTriangle } from "lucide-react";
import { cx } from "./ui";

/**
 * What's worth knowing but asks nothing (ADR-003 C3): the reading's warnings, and the checks' notices (a grid header
 * naming another investigator, wording flagged as unclear where nothing holds the reading). Shown beside the questions,
 * after a read and at approval, so nothing is hidden and nobody clicks a "Yes" that checks nothing.
 */
export function Notices({ version, className }: { version: Pick<RulebookVersionDto, "warnings" | "anomalies" | "rulebook">; className?: string }) {
  const lines = [...version.warnings, ...notices(version.anomalies, version.rulebook).map((n) => (n.where[0] ? `${n.message} (page ${n.where[0].page})` : n.message))];
  if (!lines.length) return null;
  return (
    <div className={cx("flex items-start gap-2.5 rounded-tile bg-warn-soft/70 px-4 py-3 text-small text-ink-2", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-ink">Worth knowing</p>
        <ul className="flex flex-col gap-1">
          {lines.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
