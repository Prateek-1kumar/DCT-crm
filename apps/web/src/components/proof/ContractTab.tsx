"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageView, type Box } from "../PageView";
import { Badge, Card, cx } from "../ui";
import type { AmountStatus, CoveragePage, CoverageRef } from "@/lib/types";
import { DetailPanel } from "./DetailPanel";
import { pageAt, plural, type ProofData, type Spot } from "./model";
import { TotalsBar, type Layers } from "./TotalsBar";

const WORDS: Record<AmountStatus, string> = { captured: "captured", decided: "decided by a person", set_aside: "set aside", missing: "not in the rulebook yet" };

const countOf = (p: CoveragePage, s: AmountStatus) => p.amounts.filter((a) => a.status === s).length;
const showsOn = (p: CoveragePage, filter: AmountStatus | null) => !filter || countOf(p, filter) > 0;
const pageId = (p: { documentId: string; page: number }) => `page-${p.documentId}-${p.page}`;

/** Draws the page image only once it nears the screen (a contract can be 60+ pages); a jump target draws at once. */
function Lazy({ eager, children }: { eager: boolean; children: ReactNode }) {
  const holder = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = holder.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return <div ref={holder}>{seen || eager ? children : <div className="aspect-[8.5/11] rounded-tile bg-sunken" />}</div>;
}

interface PageProps {
  page: CoveragePage;
  names: Map<string, string>;
  filter: AmountStatus | null;
  layers: Layers;
  selected: number | null;
  target: Spot | null;
  onAmount: (page: CoveragePage, index: number) => void;
  onClause: (page: CoveragePage, termId: string) => void;
}

function ContractPage({ page, names, filter, layers, selected, target, onAmount, onClause }: PageProps) {
  const section = useRef<HTMLElement>(null);
  const focus = target?.box != null ? page.amounts[target.box]?.box : undefined;

  useEffect(() => {
    if (target && !focus) section.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [target, focus]);

  const boxes: Box[] = [
    ...(layers.clauses && !filter
      ? page.clauses.flatMap((c) => c.boxes.map((box): Box => ({ box, mark: "clause", label: `Rule wording behind "${names.get(`term:${c.termId}`) ?? "a rulebook line"}"`, onClick: () => onClause(page, c.termId) })))
      : []),
    ...(layers.amounts
      ? page.amounts.flatMap((a, i): Box[] => {
          if (filter && a.status !== filter) return [];
          const line = a.ref && names.get(`${a.ref.target}:${a.ref.id}`);
          const label = `${a.text} · ${WORDS[a.status]}${line ? ` as ${line}` : ""}${a.reason ? `: ${a.reason}` : ""}`;
          return [{ box: a.box, mark: a.status, label, selected: i === selected, onClick: () => onAmount(page, i) }];
        })
      : []),
  ];

  return (
    <section ref={section} id={pageId(page)} aria-label={`${page.doc}, page ${page.page}`} className="scroll-mt-4">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-small text-muted">
        <span className="font-medium text-ink-2">Page {page.page}</span>
        <span>{plural(page.amounts.length, "amount")}</span>
        {countOf(page, "missing") > 0 && <Badge tone="danger">{countOf(page, "missing")} missing</Badge>}
        {page.kind === "image" && <Badge tone="warn">Scanned page: amounts on it can&apos;t be checked</Badge>}
      </header>
      <Lazy eager={!!target}>
        <PageView documentId={page.documentId} page={page.page} alt={`${page.doc}, page ${page.page}`} boxes={boxes} focus={focus} />
      </Lazy>
    </section>
  );
}

function PageIndex({ groups, spot, onJump }: { groups: { id: string; name: string; pages: CoveragePage[] }[]; spot: Spot | null; onJump: (p: CoveragePage) => void }) {
  return (
    <nav aria-label="Pages" className="grid gap-4">
      {groups.map((g) => (
        <div key={g.id}>
          <p className="eyebrow mb-1 truncate" title={g.name}>{g.name}</p>
          <ul className="grid gap-0.5">
            {g.pages.map((p) => {
              const missing = countOf(p, "missing");
              const here = spot?.doc === p.documentId && spot.page === p.page;
              return (
                <li key={p.page}>
                  <button
                    type="button"
                    onClick={() => onJump(p)}
                    aria-current={here ? "true" : undefined}
                    className={cx("flex w-full items-center justify-between gap-2 rounded-[10px] px-2.5 py-1 text-left text-small", here ? "bg-brand-soft font-medium text-accent" : "text-ink-2 hover:bg-ink/[0.045]")}
                  >
                    <span>Page {p.page}</span>
                    <span className={cx("num", missing > 0 ? "font-medium text-danger" : "text-faint")}>
                      {p.kind === "image" ? "scanned" : missing > 0 ? `${missing} missing` : plural(p.amounts.length, "amount")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function ContractTab({ data, spot, line, onSelect, onShowInRulebook }: {
  data: ProofData;
  spot: Spot | null;
  line: CoverageRef | null;
  onSelect: (sel: { ref: CoverageRef | null } & Spot) => void;
  onShowInRulebook: () => void;
}) {
  const [filter, setFilter] = useState<AmountStatus | null>(null);
  const [layers, setLayers] = useState<Layers>({ amounts: true, clauses: true });
  const [target, setTarget] = useState<Spot | null>(spot);

  const names = useMemo(
    () => new Map([...data.rulebook.terms.map((t) => [`term:${t.id}`, t.name] as const), ...data.rulebook.grids.map((g) => [`grid:${g.id}`, g.name] as const)]),
    [data],
  );
  const groups = useMemo(
    () => data.version.documents.map((d) => ({ id: d.id, name: d.name, pages: data.pages.filter((p) => p.documentId === d.id && showsOn(p, filter)) })).filter((g) => g.pages.length > 0),
    [data, filter],
  );
  const scanned = data.pages.filter((p) => p.kind === "image").length;
  const amount = spot?.box != null ? pageAt(data, spot)?.amounts[spot.box] : undefined;

  const jump = (to: Spot, ref: CoverageRef | null = null) => {
    setTarget(to);
    onSelect({ ...to, ref });
  };

  const nextMissing = () => {
    const missing = data.pages.flatMap((p) => p.amounts.flatMap((a, i): Spot[] => (a.status === "missing" ? [{ doc: p.documentId, page: p.page, box: i }] : [])));
    const at = missing.findIndex((m) => m.doc === spot?.doc && m.page === spot.page && m.box === spot.box);
    const next = missing[(at + 1) % missing.length];
    if (!next) return;
    if (filter && filter !== "missing") setFilter(null);
    jump(next);
  };

  const spotOf = (p: CoveragePage, box: number | null): Spot => ({ doc: p.documentId, page: p.page, box });

  return (
    <div className="grid gap-6">
      <TotalsBar totals={data.totals} scanned={scanned} filter={filter} onFilter={setFilter} onNext={nextMissing} layers={layers} onLayers={setLayers} />
      <div className="grid items-start gap-6 lg:grid-cols-[132px_minmax(0,1fr)_300px]">
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <PageIndex groups={groups} spot={spot} onJump={(p) => jump(spotOf(p, null))} />
        </div>
        <div className="grid gap-8">
          {groups.length === 0 && <Card className="p-6 text-body text-muted">No pages have amounts like that.</Card>}
          {groups.map((g) => (
            <section key={g.id} aria-label={g.name} className="grid gap-6">
              <h2 className="text-title font-semibold tracking-tight">{g.name}</h2>
              {g.pages.map((p) => (
                <ContractPage
                  key={p.page}
                  page={p}
                  names={names}
                  filter={filter}
                  layers={layers}
                  selected={spot?.doc === p.documentId && spot.page === p.page ? spot.box : null}
                  target={target?.doc === p.documentId && target.page === p.page ? target : null}
                  onAmount={(pg, i) => onSelect({ ...spotOf(pg, i), ref: pg.amounts[i]?.ref ?? null })}
                  onClause={(pg, termId) => onSelect({ ...spotOf(pg, null), ref: { target: "term", id: termId } })}
                />
              ))}
            </section>
          ))}
        </div>
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <DetailPanel data={data} amount={amount} line={line} onShowInRulebook={onShowInRulebook} />
        </div>
      </div>
    </div>
  );
}
