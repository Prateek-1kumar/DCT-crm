import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** False on the server and while hydrating, true after. Data a shared cache already holds (the sidebar fills it first) must not be drawn in the hydrating render, or it won't match the server's HTML. */
export const useMounted = () => useSyncExternalStore(noop, () => true, () => false);
