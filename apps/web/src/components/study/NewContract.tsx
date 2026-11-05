"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { btnCls, Card, ErrorNote, PageTitle, pageCls, Spinner } from "../ui";
import { PdfDrop } from "./PdfDrop";
import { useUpload } from "./useUpload";

const STATUS = { waiting: "Waiting", sending: "Uploading…", added: "Added", failed: "Couldn't add" };

export function NewContract() {
  const router = useRouter();
  const by = useActingAs();
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const upload = useUpload();

  const create = useMutation({
    mutationFn: async (files: File[]) => {
      const { id } = await api.createStudy({ by: by! });
      const notes = await upload.mutateAsync({ studyId: id, files });
      return { id, notes };
    },
    onSuccess: ({ id, notes }) => {
      void queryClient.invalidateQueries({ queryKey: keys.studies });
      if (!notes.length) router.push(`/studies/${id}`);
    },
  });

  function send(files: File[]) {
    if (!by) return askForPerson();
    create.mutate(files);
  }

  const started = create.isPending || create.isSuccess;
  return (
    <div className={pageCls}>
      <PageTitle title="New contract" sub="Drop the signed contract and any amendments. We'll read the study details from them." />
      <div className="max-w-[720px]">
        {started ? (
          <Card className="p-8">
            {upload.rows.length === 0 ? (
              <Spinner label="Setting up the contract" />
            ) : (
              <ul className="divide-y divide-line">
                {upload.rows.map((row, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-3 text-body">
                    <span className="min-w-0 truncate font-medium">{row.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-small text-muted">
                      {row.status === "added" && <Check aria-hidden className="size-4 text-ok" />}
                      {STATUS[row.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {create.data && create.data.notes.length > 0 && (
              <div className="mt-6 flex flex-col gap-3">
                {create.data.notes.map(({ text, problem }) => (
                  <div key={text}>{problem ? <ErrorNote>{text}</ErrorNote> : <p className="rounded-field bg-sunken px-4 py-3 text-body text-muted">{text}</p>}</div>
                ))}
                <div>
                  <Link href={`/studies/${create.data.id}`} className={btnCls("primary", "lg")}>
                    Open the contract
                  </Link>
                </div>
              </div>
            )}
          </Card>
        ) : (
          <>
            <PdfDrop className="gap-4 px-8 py-20" inputRef={picker} onFiles={send} />
            <div className="mt-4">
              <ErrorNote error={create.error} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
