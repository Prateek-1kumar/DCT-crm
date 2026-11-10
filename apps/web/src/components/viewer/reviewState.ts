import type { Flag, Version } from "@/lib/types";

/** Who has marked these items as matching the contract, how many are marked by anyone, and which the person using the app has / hasn't marked. */
export function markState(version: Version, items: string[], me: string | null) {
  const set = new Set(items);
  const marks = version.proofreads.filter((p) => set.has(p.item));
  return {
    names: [...new Set(marks.map((p) => p.by))],
    done: new Set(marks.map((p) => p.item)).size,
    mine: me === null ? [] : items.filter((i) => marks.some((p) => p.item === i && p.by === me)),
    todo: me === null ? items : items.filter((i) => !marks.some((p) => p.item === i && p.by === me)),
  };
}

export const flagsFor = (version: Version, items: string[]): Flag[] => version.flags.filter((f) => items.includes(f.item));

/** "Not proofread yet" / "Proofread by Ana, Ben" / "3 of 8 proofread by Ana". */
export function markSummary(names: string[], done: number, total: number): string {
  if (names.length === 0) return "Not proofread yet";
  return total > 1 ? `${done} of ${total} proofread by ${names.join(", ")}` : `Proofread by ${names.join(", ")}`;
}

/** Plain-English check of a flag's note; null when it is fine. The API takes 1–500 characters. */
export function noteProblem(note: string): string | null {
  const n = note.trim().length;
  if (n === 0) return "Say what looks wrong, in a few words.";
  if (n > 500) return `That note is too long: keep it to 500 characters or fewer (it is ${n}).`;
  return null;
}
