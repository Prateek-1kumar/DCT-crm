"use client";

import { useParams } from "next/navigation";
import { ProofScreen } from "@/components/proof/ProofScreen";

export default function ProofPage() {
  const { id } = useParams<{ id: string }>();
  return <ProofScreen versionId={id} />;
}
