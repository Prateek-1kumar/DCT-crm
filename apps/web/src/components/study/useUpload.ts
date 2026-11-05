"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { errorText } from "../ui";

export type Note = { text: string; problem: boolean };
type Row = { name: string; status: "waiting" | "sending" | "added" | "failed" };

const failure = (file: File, error: unknown) => {
  const message = errorText(error);
  return message.includes(file.name) ? message : `${file.name}: ${message}`;
};

/** Sends PDFs to a study one per request: each is checked on its own, and a bad one doesn't sink the others. */
export function useUpload() {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const mark = (i: number, status: Row["status"]) => setRows((r) => r.map((row, j) => (j === i ? { ...row, status } : row)));

  const upload = useMutation({
    mutationFn: async ({ studyId, files }: { studyId: string; files: File[] }) => {
      setRows(files.map((f) => ({ name: f.name, status: "waiting" })));
      const notes: Note[] = [];
      for (const [i, file] of files.entries()) {
        mark(i, "sending");
        try {
          const [result] = await api.upload(studyId, [file], by!);
          if (result?.alreadyInStudy) notes.push({ text: `${file.name} was already in this contract, so it wasn't added again.`, problem: false });
          mark(i, "added");
        } catch (error) {
          notes.push({ text: failure(file, error), problem: true });
          mark(i, "failed");
        }
      }
      return notes;
    },
    onSettled: (_notes, _error, { studyId }) => queryClient.invalidateQueries({ queryKey: keys.study(studyId) }),
  });
  return { ...upload, rows };
}
