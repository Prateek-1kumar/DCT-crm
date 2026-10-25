import type { ContractAnomaly, RulebookVersionDto, SettingsDto } from "@dct/shared";

export const SEVERITIES = ["blocker", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function settleProgress(anomalies: ContractAnomaly[]) {
  const settled = anomalies.filter((a) => a.resolution).length;
  return { settled, total: anomalies.length, open: anomalies.length - settled };
}

/** Open first, then by severity; stable otherwise. */
export function groupBySeverity(anomalies: ContractAnomaly[]): { severity: Severity; items: ContractAnomaly[] }[] {
  return SEVERITIES.map((severity) => ({
    severity,
    items: anomalies
      .filter((a) => a.severity === severity)
      .sort((a, b) => Number(!!a.resolution) - Number(!!b.resolution)),
  })).filter((g) => g.items.length > 0);
}

/**
 * Mirrors the API's sign-off rules so the button can explain itself before the 409.
 * The API stays the source of truth.
 */
export function signOffState(
  version: Pick<RulebookVersionDto, "status" | "anomalies" | "editors" | "rulebook">,
  settings: Pick<SettingsDto, "makerChecker"> | undefined,
  by: string | null,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (version.status !== "draft") reasons.push(`This version is ${version.status}; only drafts can be signed off.`);
  if (!version.rulebook) reasons.push("There is no rulebook to sign off yet.");
  const { open } = settleProgress(version.anomalies);
  if (open > 0) reasons.push(`${open} ${open === 1 ? "anomaly is" : "anomalies are"} not settled yet.`);
  if (!by) reasons.push("Choose who you are acting as (top right).");
  else if (settings?.makerChecker && version.editors.includes(by))
    reasons.push(`Maker-checker is on and ${by} corrected values in this version; someone else must sign off.`);
  return { allowed: reasons.length === 0, reasons };
}
