"use client";

import type { Question } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Box } from "@/components/PageView";
import { ErrorNote } from "@/components/ui";
import { cropFor } from "@/components/version/questions";
import { api, keys, pageImage } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { PageCrop } from "./PageCrop";

/** The exact quote and the page cut down to where it sits, with a way to see the whole page. */
export function SourcePane({ version, question }: { version: Version; question: Question }) {
  const { doc: name, page, quote, region } = question.source;
  const doc = version.documents.find((d) => d.name === name);
  const found = useQuery({ queryKey: keys.find(doc?.id ?? "", page, quote), queryFn: () => api.find(doc!.id, page, quote), enabled: !!doc && quote !== "" });
  const words = found.data?.boxes;
  const boxes = useMemo<Box[]>(
    () => [
      ...(words ?? []).map((box) => ({ box, mark: "highlight" as const, label: "The words this question is about" })),
      ...(region ? [{ box: region, mark: "highlight" as const, label: "The part of the page this question is about" }] : []),
    ],
    [words, region],
  );
  const crop = useMemo(() => cropFor(boxes.map((b) => b.box)), [boxes]);
  const missed = found.isError || (found.isSuccess && words?.length === 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {quote && (
        <figure className="rounded-tile border-l-4 border-brand bg-sunken px-5 py-4">
          <blockquote className="text-body break-words text-ink">&ldquo;{quote}&rdquo;</blockquote>
          <figcaption className="mt-2 text-small break-words text-muted">
            {name} · page {page}
          </figcaption>
        </figure>
      )}
      {missed && !region && <p className="rounded-field bg-warn-soft px-4 py-3 text-small text-warn">We couldn&apos;t highlight the exact words on this page.</p>}
      {doc ? (
        <>
          <PageCrop documentId={doc.id} page={page} crop={crop} boxes={boxes} alt={`Page ${page} of ${name}`} />
          {crop && (
            <a href={pageImage(doc.id, page)} target="_blank" rel="noreferrer" className="text-small font-medium text-accent hover:text-accent-hover">
              See the whole page
            </a>
          )}
        </>
      ) : (
        <ErrorNote>We couldn&apos;t find this document, so the page can&apos;t be shown.</ErrorNote>
      )}
    </div>
  );
}
