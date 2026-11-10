"use client";

import { useQuery } from "@tanstack/react-query";
import { use } from "react";
import { Dashboard } from "@/components/rulebook/Dashboard";
import { LoadError, pageCls, Spinner } from "@/components/ui";
import { api, keys } from "@/lib/queries";

export default function SummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const version = useQuery({ queryKey: keys.version(id), queryFn: () => api.version(id) });

  return (
    <div className={pageCls}>
      {version.isPending ? <Spinner /> : version.isError ? <LoadError error={version.error} retry={() => void version.refetch()} what="this version" /> : <Dashboard version={version.data} />}
    </div>
  );
}
