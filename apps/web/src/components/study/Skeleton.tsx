import { cx } from "../ui";

/** A grey bar where text will land, so a loading screen keeps the shape of the loaded one. */
export const Skeleton = ({ className }: { className?: string }) => <span aria-hidden className={cx("block animate-pulse rounded-full bg-ink/[0.07]", className)} />;
