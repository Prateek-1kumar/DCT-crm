import type { Page, PageKind, Word } from "../types";
import { groupLines, layoutText, maskBankDetails, rawLine } from "./lines";

const FIRST_LINE_MAX = 90;

export function buildPage(number: number, words: Word[], kind: PageKind, rotation = 0): Page {
  const lines = groupLines(words);
  // also masks the words' text in place; a scan's word positions are made up, so boxes from them would paint the wrong spots
  const boxes = maskBankDetails(lines);
  const raw = lines.map(rawLine).join("\n");
  return {
    page: number,
    kind,
    layout: layoutText(lines),
    raw,
    words,
    maskBoxes: kind === "scan" ? [] : boxes,
    firstLine: (raw.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, FIRST_LINE_MAX),
    rotation,
  };
}
