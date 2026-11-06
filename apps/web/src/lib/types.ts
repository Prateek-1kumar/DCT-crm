import type { Region, Rulebook } from "@dct/shared";

export type PartyKind = "sponsor" | "cro" | "site";

export interface Party {
  id: string;
  kind: PartyKind;
  name: string;
  aliases: string[];
  createdAt: string;
  createdBy: string;
}

export type VersionStatus = "reading" | "draft" | "failed" | "approved" | "superseded";

export interface StudyRow {
  id: string;
  /** Empty until the contract has been read. */
  protocol: string | null;
  sponsorId: string | null;
  payerId: string | null;
  siteId: string | null;
  createdAt: string;
  createdBy: string;
  sponsor: string | null;
  payer: string | null;
  site: string | null;
  firstDocument: string | null;
  latestVersion: { number: number; status: VersionStatus } | null;
}

export interface StudyDocument {
  id: string;
  name: string;
  bytes: number;
  pageCount: number;
  scannedPages: number[];
}

export interface VersionSummary {
  id: string;
  number: number;
  status: VersionStatus;
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

export interface Study {
  id: string;
  protocol: string | null;
  createdAt: string;
  createdBy: string;
  sponsor: Party | null;
  payer: Party | null;
  site: Party | null;
  documents: StudyDocument[];
  versions: VersionSummary[];
}

export interface Uploaded {
  id: string;
  name: string;
  pages: number;
  scannedPages: number[];
  alreadyInStudy: boolean;
}

export type ReadStatus = "queued" | "running" | "done" | "failed";

export interface Read {
  id: string;
  versionId: string;
  status: ReadStatus;
  budgetUsd: number;
  spentUsd: number;
  /** Plain-English lines, oldest first: the live feed. */
  progress: string[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Problem {
  check: string;
  id?: string;
  doc?: string;
  page?: number;
  message: string;
}

export interface Version {
  id: string;
  studyId: string;
  number: number;
  status: VersionStatus;
  documentIds: string[];
  /** The documents this version was read from; the rulebook cites them by name. */
  documents: { id: string; name: string; pageCount: number }[];
  rulebook: Rulebook | null;
  problems: Problem[];
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  answers: { questionId: string; option: number; by: string; at: string }[];
  read: { id: string; status: ReadStatus } | null;
}

export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageText {
  page: number;
  kind: "text" | "scan" | "image";
  layout: string;
  words: Word[];
}

/**
 * How one dollar amount printed in the contract ended up: captured in the rulebook (proven by the checks), decided by a
 * person, set aside on purpose (with the reason), or missing.
 */
export type AmountStatus = "captured" | "decided" | "set_aside" | "missing";

export type Doubt = "unsure" | "handwritten" | "struck_out" | "initialed";

export type CoverageRef = { target: "term"; id: string } | { target: "grid"; id: string; row: number; col: number };

export interface CoverageAmount {
  /** Fractions 0–1 of the page, origin top-left. */
  box: Region;
  text: string;
  cents: number;
  status: AmountStatus;
  ref: CoverageRef | null;
  reason: string | null;
  doubt: Doubt | null;
  /** The printed line it sits on, for context. */
  line: string;
}

/** A clause the rulebook took a term from: where its quoted words sit on the page. */
export interface CoverageClause {
  termId: string;
  boxes: Region[];
}

export interface CoveragePage {
  documentId: string;
  doc: string;
  page: number;
  kind: "text" | "scan" | "image";
  amounts: CoverageAmount[];
  clauses: CoverageClause[];
}

export interface Coverage {
  pages: CoveragePage[];
  totals: { amounts: number; captured: number; decided: number; setAside: number; missing: number };
}
