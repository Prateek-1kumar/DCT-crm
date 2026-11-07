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

/** A party as the parties page lists it: with how many contracts use it. */
export interface PartyRow extends Party {
  studies: number;
}

/** What the activity trail groups an entry as, for its icon. */
export type ActivityKind = "files" | "reading" | "decision" | "approval" | "proofread" | "parties" | "other";

export interface ActivityItem {
  /** Newest first; also the cursor for the next page. */
  id: number;
  at: string;
  /** Who did it: a person's name, or "Contract reader" for the reading itself. */
  by: string;
  /** A plain-English sentence: "Ana Answerer answered a decision on version 2". */
  summary: string;
  kind: ActivityKind;
  /** The contract it belongs to, when it belongs to one. */
  studyId: string | null;
  studyTitle: string | null;
  versionNumber: number | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` to get the next page; null at the end. */
  next: number | null;
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
  /** The latest version, whatever its status; its id is what the workspace opens. */
  latestVersion: { id: string; number: number; status: VersionStatus } | null;
  /** The principal investigator the contract names; null until read. */
  pi: string | null;
  /** When anything about the contract last changed (a version made, read or approved). */
  updatedAt: string;
  /** Number of the approved version, if any. */
  liveVersion: number | null;
  /** Open blocking questions on the latest version, plus one when its checks fail with no question open. */
  openDecisions: number;
  /** A reading or draft version exists that is newer than the live one. */
  newVersionInProgress: boolean;
  /** Names that answered the latest draft's questions: they can't approve it (maker-checker). */
  answeredBy: string[];
}

export interface StudyDocument {
  id: string;
  name: string;
  bytes: number;
  pageCount: number;
  /** Scanned pages not read from the image yet. */
  scannedPages: number[];
  /** Scanned pages already read from the image. */
  scansRead: number[];
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
  /** Who checked what against the PDF. `item` is a term id, or `grid:<gridId>:<row>:<col>` for one grid cell. Record only: approval doesn't wait for it. */
  proofreads: Proofread[];
}

export interface Proofread {
  item: string;
  by: string;
  at: string;
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
