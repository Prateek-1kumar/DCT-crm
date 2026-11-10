import type { StudyRow } from "./types";

/** The five steps every contract goes through, and the only ones. */
export const STEPS = [
  { n: 1, label: "Add files" },
  { n: 2, label: "Reading" },
  { n: 3, label: "Decisions" },
  { n: 4, label: "Approve" },
  { n: 5, label: "Live" },
] as const;
export type StepNumber = (typeof STEPS)[number]["n"];

/** What the latest version of a contract is doing; the workspace banner and the list's button both read it. */
export type Phase = "add" | "ready" | "reading" | "failed" | "decisions" | "approve" | "live";

export type ListTab = "all" | "needs-you" | "waiting" | "live" | "failed";
export const LIST_TABS: { id: ListTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "waiting", label: "Waiting for approval" },
  { id: "live", label: "Live" },
  { id: "failed", label: "Couldn't read" },
];

export interface NextAction {
  label: string;
  href: string;
  disabled: boolean;
  /** Why the button is off, in words for the person who sees it. */
  reason: string | null;
}

export interface StepInfo {
  phase: Phase;
  step: StepNumber;
  status: string;
  tab: ListTab;
  failed: boolean;
  /** A live contract with a newer reading or draft. */
  newVersion: boolean;
  next: NextAction;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Which step a contract is on, from its latest version, and what the person using the app does next. */
export function stepInfo(row: StudyRow, me: string | null): StepInfo {
  const home = `/studies/${row.id}`;
  const v = row.latestVersion;
  const live = row.liveVersion !== null;
  const go = (label: string, href: string): NextAction => ({ label, href, disabled: false, reason: null });
  const base = { newVersion: row.newVersionInProgress, failed: false };

  let info: Omit<StepInfo, "tab">;
  if (!v && !row.firstDocument) info = { ...base, phase: "add", step: 1, status: "No files yet", next: go("Add files", `${home}?tab=documents`) };
  else if (!v || v.status === "superseded") info = { ...base, phase: "ready", step: 2, status: "Ready to read", next: go("Start reading", home) };
  else if (v.status === "reading") info = { ...base, phase: "reading", step: 2, status: "Reading", next: go("See progress", home) };
  else if (v.status === "failed") info = { ...base, phase: "failed", step: 3, status: "Couldn't read", failed: true, next: go("Start again", home) };
  else if (v.status === "approved") info = { ...base, phase: "live", step: 5, status: `Live · version ${row.liveVersion ?? v.number}`, next: go("Open rulebook", `/versions/${v.id}`) };
  else if (row.openDecisions > 0) {
    const label = `Answer ${plural(row.openDecisions, "decision", "decisions")}`;
    info = { ...base, phase: "decisions", step: 3, status: `${plural(row.openDecisions, "decision", "decisions")} to make`, next: go(label, `/versions/${v.id}/questions`) };
  } else {
    // Maker-checker: whoever answered the decisions can't also approve them.
    const blocked = me !== null && row.answeredBy.some((n) => same(n, me));
    const next: NextAction = blocked
      ? { label: "Waiting for a colleague", href: `/versions/${v.id}/approve`, disabled: true, reason: `${row.answeredBy.join(", ")} answered the decisions, so someone else has to approve this.` }
      : go("Review and approve", `/versions/${v.id}/approve`);
    info = { ...base, phase: "approve", step: 4, status: "Ready to approve", next };
  }

  // A live contract stays under Live while its next version is being read or fixed; it moves to Needs you or Waiting only when a person has to act.
  const tab: ListTab =
    info.step === 3 && !info.failed ? "needs-you" : info.step === 4 ? "waiting" : info.step === 5 || live ? "live" : info.failed ? "failed" : "all";
  return { ...info, tab };
}

export const inTab = (info: StepInfo, tab: ListTab) => tab === "all" || info.tab === tab;

export function tabCounts(rows: StudyRow[], me: string | null): Record<ListTab, number> {
  const counts: Record<ListTab, number> = { all: rows.length, "needs-you": 0, waiting: 0, live: 0, failed: 0 };
  for (const r of rows) {
    const { tab } = stepInfo(r, me);
    if (tab !== "all") counts[tab]++;
  }
  return counts;
}

/** The search box and the ⌘K dialog: protocol, sponsor, CRO, site, doctor and first file name. Every word typed must match something. */
export function matchesQuery(row: StudyRow, query: string): boolean {
  const hay = [row.protocol, row.sponsor, row.payer, row.site, row.pi, row.firstDocument].filter(Boolean).join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export type StepState = "done" | "current" | "todo" | "failed";

/** One entry per step for the stepper: circle state and the line under the label. */
export function stepperStates(info: StepInfo): { n: StepNumber; label: string; state: StepState; note: string }[] {
  return STEPS.map(({ n, label }) => {
    if (n < info.step) return { n, label, state: "done", note: "Done" };
    if (n > info.step) return { n, label, state: "todo", note: "" };
    return { n, label, state: info.failed ? "failed" : info.step === 5 ? "done" : "current", note: info.status };
  });
}
