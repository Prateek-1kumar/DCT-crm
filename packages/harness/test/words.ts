import type { Word } from "../src/types";

/** Rough word positions for a page written as text lines, so checks that work from words see the same lines. */
export const wordsOf = (text: string): Word[] =>
  text.split("\n").flatMap((line, i) => [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], x0: m.index / 200, x1: (m.index + m[0].length) / 200, y0: i / 100, y1: (i + 0.8) / 100 })));
