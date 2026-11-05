"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { api, keys } from "@/lib/queries";
import { LoadError, PageTitle, pageCls, Spinner } from "../ui";
import { Documents } from "./Documents";
import { isPreparing, studySub, studyTitle } from "./format";
import { NextStep } from "./NextStep";
import { VersionsHistory } from "./VersionsHistory";

const PREPARING_POLL_MS = 2000;

export function StudyHub({ id }: { id: string }) {
  const study = useQuery({
    queryKey: keys.study(id),
    queryFn: () => api.study(id),
    refetchInterval: (q) => (q.state.data?.documents.some(isPreparing) ? PREPARING_POLL_MS : false),
  });
  const picker = useRef<HTMLInputElement>(null);

  if (study.isPending)
    return (
      <div className={pageCls}>
        <Spinner label="Loading this contract" />
      </div>
    );
  if (study.isError) return <LoadError error={study.error} retry={() => void study.refetch()} />;

  const s = study.data;
  return (
    <div className={pageCls}>
      <PageTitle title={studyTitle(s.protocol, s.documents[0]?.name)} sub={studySub(s.protocol, [s.sponsor?.name, s.payer?.name, s.site?.name])} />
      <div className="flex flex-col gap-6">
        <NextStep study={s} pickFiles={picker} />
        <Documents study={s} inputRef={picker} />
        <VersionsHistory versions={s.versions} />
      </div>
    </div>
  );
}
