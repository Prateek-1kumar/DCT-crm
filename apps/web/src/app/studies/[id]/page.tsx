"use client";

import { use } from "react";
import { Workspace } from "@/components/workspace/Workspace";

export default function StudyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Workspace id={id} />;
}
