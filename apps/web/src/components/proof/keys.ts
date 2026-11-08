export type Shortcut = "match" | "next" | "prev" | "flag" | "close" | "help";

/**
 * What a key means on the proofread screen, or null to leave it alone. `onControl` is a key pressed on a button or link,
 * where Space and Enter keep their usual meaning (press it); `inViewer` is the page area, where arrows pan the page.
 * The caller has already ruled out modifier keys and typing in a text box.
 */
export function shortcutOf(key: string, ctx: { onControl: boolean; inViewer: boolean }): Shortcut | null {
  if (key === " " || key === "Enter") return ctx.onControl ? null : "match";
  if (key === "j" || key === "J" || (key === "ArrowDown" && !ctx.inViewer)) return "next";
  if (key === "k" || key === "K" || (key === "ArrowUp" && !ctx.inViewer)) return "prev";
  if (key === "f" || key === "F") return "flag";
  if (key === "Escape") return "close";
  if (key === "?") return "help";
  return null;
}
