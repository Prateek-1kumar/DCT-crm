"use client";

import { useQuery } from "@tanstack/react-query";
import { EVIDENCE_LABEL, GridTable, termValue } from "@/components/rulebook";
import { api, keys } from "@/lib/queries";
import type { CoverageRef } from "@/lib/types";
import { PageView, type Box } from "../PageView";
import { Badge, Button, Card, cx } from "../ui";
import { docName, EVIDENCE_TONE, findTerm, GROUPS, locate, pageAt, sameRef, sourceOf, type ProofData } from "./model";

function SourcePane({ data, line, onShow }: { data: ProofData; line: CoverageRef | null; onShow: () => void }) {
  const term = line?.target === "term" ? findTerm(data, line.id) : undefined;
  const spot = !line ? null : term ? sourceOf(data, line) : locate(data, line);
  const page = pageAt(data, spot);
  const quote = term?.source.quote ?? "";

  const found = useQuery({
    queryKey: keys.find(spot?.doc ?? "", spot?.page ?? 0, quote),
    queryFn: () => api.find(spot!.doc, spot!.page, quote),
    enabled: !!term && !!spot && quote !== "",
  });

  const regions = term ? (found.data?.boxes ?? []) : (page?.amounts.filter((a) => line && a.ref && sameRef(a.ref, line)).map((a) => a.box) ?? []);
  const boxes: Box[] = regions.map((box) => ({ box, mark: "highlight", label: term ? "The words quoted in the rulebook" : "This amount in the contract" }));

  if (!line || !spot || !page) {
    return <Card className="p-6 text-body text-muted">{line ? "We couldn't tell which page this line came from." : "Pick a line on the left to see where it came from in the contract."}</Card>;
  }

  const lost = boxes.length === 0 && !found.isPending;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body font-medium text-ink-2">
          {docName(data, spot.doc)} · page {spot.page}
        </p>
        <Button size="sm" onClick={onShow}>
          Show on contract
        </Button>
      </div>
      {page.kind === "image" && <p className="rounded-field bg-warn-soft px-4 py-2 text-small text-warn">Scanned page: the words on it can&apos;t be searched. Read it on the page below.</p>}
      {page.kind === "ocr" && <p className="rounded-field bg-sunken px-4 py-2 text-small text-muted">Scanned page, read with OCR</p>}
      {page.kind !== "image" && lost && <p className="rounded-field bg-warn-soft px-4 py-2 text-small text-warn">We couldn&apos;t find the exact words on this page. The page is shown so you can look.</p>}
      <div data-page-scroller className="relative min-h-0 flex-1 overflow-auto rounded-tile">
        <PageView key={`${spot.doc}-${spot.page}`} documentId={spot.doc} page={spot.page} alt={`${docName(data, spot.doc)}, page ${spot.page}`} boxes={boxes} focus={regions[0]} />
      </div>
    </div>
  );
}

export function RulebookTab({ data, line, onSelect, onShowOnContract }: { data: ProofData; line: CoverageRef | null; onSelect: (ref: CoverageRef) => void; onShowOnContract: () => void }) {
  const { grids, terms } = data.rulebook;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="grid gap-6">
        {grids.map((g) => (
          <Card key={g.id} className="grid gap-3 p-5">
            <h2 className="text-title font-semibold tracking-tight">
              {g.name}
              {g.arm && <span className="font-normal text-muted"> · {g.arm}</span>}
            </h2>
            <div className="overflow-x-auto">
              <GridTable
                grid={g}
                selected={line?.target === "grid" && line.id === g.id ? { row: line.row, col: line.col } : null}
                onCellClick={(row, col) => onSelect({ target: "grid", id: g.id, row, col })}
              />
            </div>
          </Card>
        ))}
        {GROUPS.map((group) => {
          const inGroup = terms.filter((t) => group.categories.includes(t.category));
          return (
            inGroup.length > 0 && (
              <Card key={group.title} className="p-5">
                <h2 className="text-title font-semibold tracking-tight">{group.title}</h2>
                <ul className="mt-3 grid gap-1">
                  {inGroup.map((t) => {
                    const selected = line?.target === "term" && line.id === t.id;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onSelect({ target: "term", id: t.id })}
                          className={cx("flex w-full items-center gap-3 rounded-field px-3 py-2 text-left", selected ? "bg-brand-soft" : "hover:bg-ink/[0.045]")}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-ink">{t.name}</span>
                            <span className="num block text-small text-muted">{termValue(t)}</span>
                          </span>
                          <Badge tone={EVIDENCE_TONE[t.evidence]}>{EVIDENCE_LABEL[t.evidence]}</Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )
          );
        })}
      </div>
      <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
        <SourcePane data={data} line={line} onShow={onShowOnContract} />
      </div>
    </div>
  );
}
