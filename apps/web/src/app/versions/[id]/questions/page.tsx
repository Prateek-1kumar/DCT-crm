"use client";

import { use } from "react";
import { QuestionsView } from "@/components/version/QuestionsView";

// read in the client, like the contract page: an awaited params in a server page makes Next drop the page from its instant-navigation check
export default function QuestionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <QuestionsView versionId={id} />;
}
