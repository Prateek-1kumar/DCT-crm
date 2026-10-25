"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let browserClient: QueryClient | undefined;
const make = () => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } } });

function getClient() {
  if (typeof window === "undefined") return make();
  return (browserClient ??= make());
}

export function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getClient()}>{children}</QueryClientProvider>;
}
