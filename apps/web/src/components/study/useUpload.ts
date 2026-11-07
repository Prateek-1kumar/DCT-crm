"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { errorText } from "../ui";

export type Note = { text: string; problem: boolean };
export type Row = { name: string; size: number; status: "waiting" | "sending" | "added" | "failed"; id?: string; pages?: number; scannedPages?: number[] };

const failure = (file: File, error: unknown) => {
  const message = errorText(error);
  return message.includes(file.name) ? message : `${file.name}: ${message}`;
};

/** Sends PDFs to a study one per request: each is checked on its own, and a bad one doesn't sink the others. */
export function useUpload() {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  // Rows pile up across drops (the Add contract page shows every file); each drop marks only its own, from `base`.
  const count = useRef(0);
  const mark = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const upload = useMutation({
    mutationFn: async ({ studyId, files }: { studyId: string; files: File[] }) => {
      const base = count.current;
      count.current += files.length;
      setRows((r) => [...r, ...files.map((f): Row => ({ name: f.name, size: f.size, status: "waiting" }))]);
      const notes: Note[] = [];
      for (const [i, file] of files.entries()) {
        mark(base + i, { status: "sending" });
        try {
          const [result] = await api.upload(studyId, [file], by!);
          if (result?.alreadyInStudy) notes.push({ text: `${file.name} was already in this contract, so it wasn't added again.`, problem: false });
          mark(base + i, { status: "added", id: result?.id, pages: result?.pages, scannedPages: result?.scannedPages });
        } catch (error) {
          notes.push({ text: failure(file, error), problem: true });
          mark(base + i, { status: "failed" });
        }
      }
      return notes;
    },
    // The list row (files, step) changes with the first file, so it refreshes too.
    onSettled: (_notes, _error, { studyId }) => Promise.all([queryClient.invalidateQueries({ queryKey: keys.study(studyId) }), queryClient.invalidateQueries({ queryKey: keys.studies })]),
  });
  // taking back a file dropped by mistake, before the contract is read
  const remove = useMutation({
    mutationFn: ({ studyId, id }: { studyId: string; id: string }) => api.removeDocument(studyId, id, by!),
    onSuccess: (_ok, { id }) => setRows((r) => r.filter((row) => row.id !== id)),
    onSettled: (_ok, _error, { studyId }) => Promise.all([queryClient.invalidateQueries({ queryKey: keys.study(studyId) }), queryClient.invalidateQueries({ queryKey: keys.studies })]),
  });
  return { ...upload, rows, remove };
}
