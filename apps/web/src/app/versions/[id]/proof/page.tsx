"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/study/Skeleton";
import { ProofScreen } from "@/components/proof/ProofScreen";

export default function ProofPage() {
  const { id } = useParams<{ id: string }>();
  // the screen reads the URL's query (which line is selected); that needs a Suspense boundary on a page load
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-card" />}>
      <ProofScreen versionId={id} />
    </Suspense>
  );
}
