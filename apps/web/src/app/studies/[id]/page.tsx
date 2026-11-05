"use client";

import { use } from "react";
import { StudyHub } from "@/components/study/StudyHub";

export default function StudyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <StudyHub id={id} />;
}
