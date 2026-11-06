"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { Button, ErrorNote } from "../ui";

export function StartReading({ studyId, label }: { studyId: string; label: string }) {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.startRead(studyId, by!),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.study(studyId) }), queryClient.invalidateQueries({ queryKey: keys.studies })]),
  });
  return (
    <div className="flex flex-col items-start gap-2.5">
      <Button variant="primary" size="lg" disabled={start.isPending} onClick={() => (by ? start.mutate() : askForPerson())}>
        {start.isPending ? "Starting…" : label}
      </Button>
      <ErrorNote error={start.error} />
    </div>
  );
}
