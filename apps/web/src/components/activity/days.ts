import type { ActivityItem } from "@/lib/types";
import { day } from "../study/format";

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Today", "Yesterday" or the date, by the viewer's calendar day (not a rolling 24 hours, so 00:05 is Today at 00:10). */
export function dayLabel(iso: string, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / 86_400_000);
  // A clock a little ahead of the server's can put an entry slightly in the future; it still belongs to today.
  if (days <= 0) return "Today";
  return days === 1 ? "Yesterday" : day(iso);
}

/** Consecutive entries under the same day heading; the feed arrives newest first, so each day is one run. */
export function groupByDay(items: ActivityItem[], now = Date.now()): { label: string; items: ActivityItem[] }[] {
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
