"use client";

import Link from "next/link";
import type { VersionSummary } from "@/lib/types";
import { Badge, Card } from "../ui";
import { VERSION_PILL, when } from "./format";

function link(v: VersionSummary) {
  if (v.status === "draft") return { href: `/versions/${v.id}/questions`, label: "Answer questions" };
  if (v.status === "approved" || v.status === "superseded") return { href: `/versions/${v.id}`, label: "Open rulebook" };
  return null;
}

export function VersionsHistory({ versions }: { versions: VersionSummary[] }) {
  if (versions.length === 0) return null;
  return (
    <Card className="p-6">
      <h2 className="text-title font-semibold tracking-tight">Versions</h2>
      <ul className="mt-4 divide-y divide-line">
        {versions.map((v) => {
          const pill = VERSION_PILL[v.status];
          const to = link(v);
          return (
            <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <span className="w-24 text-body font-medium">Version {v.number}</span>
              <Badge tone={pill.tone}>{pill.label}</Badge>
              <span className="min-w-0 flex-1 text-small text-muted">
                Started by {v.createdBy}, {when(v.createdAt)}
                {v.approvedAt && v.approvedBy && ` · Approved by ${v.approvedBy}, ${when(v.approvedAt)}`}
              </span>
              {to && (
                <Link href={to.href} className="text-body font-medium text-accent underline-offset-2 hover:underline">
                  {to.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
