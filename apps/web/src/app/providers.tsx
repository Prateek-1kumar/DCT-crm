"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let browserClient: QueryClient | undefined;
// networkMode "always": the API is on this computer, so the browser going offline says nothing about it. In the default
// ("online") a write would pause with its button spinning and no error, then fire by itself later, maybe on another page.
const make = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false, networkMode: "always" }, mutations: { networkMode: "always" } } });

function getClient() {
  if (typeof window === "undefined") return make();
  return (browserClient ??= make());
}

export function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getClient()}>{children}</QueryClientProvider>;
}
