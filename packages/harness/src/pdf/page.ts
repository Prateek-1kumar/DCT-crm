import type { Page, PageKind, Word } from "../types";
import { groupLines, layoutText, maskBankDetails, rawLine } from "./lines";

const FIRST_LINE_MAX = 90;

export function buildPage(number: number, words: Word[], kind: PageKind, confidence: number | null, rotation = 0): Page {
  const lines = groupLines(words);
  const maskBoxes = maskBankDetails(lines, kind === "ocr");
  const raw = lines.map(rawLine).join("\n");
  return {
    page: number,
    kind,
    layout: layoutText(lines),
    raw,
    words,
    maskBoxes,
    firstLine: (raw.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, FIRST_LINE_MAX),
    confidence,
    rotation,
  };
}
