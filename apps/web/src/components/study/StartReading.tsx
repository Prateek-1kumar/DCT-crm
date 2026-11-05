"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { Button, ErrorNote } from "../ui";

export function StartReading({ studyId, label, canStart }: { studyId: string; label: string; canStart: { ok: boolean; reason: string } }) {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const start = useMutation({
    mutationFn: () => api.startRead(studyId, by!),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.study(studyId) }), queryClient.invalidateQueries({ queryKey: keys.studies })]),
  });
  return (
    <div className="flex flex-col items-start gap-2.5">
      <Button variant="primary" size="lg" disabled={!canStart.ok || start.isPending} aria-describedby={canStart.ok ? undefined : reasonId} onClick={() => (by ? start.mutate() : askForPerson())}>
        {start.isPending ? "Starting…" : label}
      </Button>
      {!canStart.ok && (
        <p id={reasonId} className="text-small text-warn">
          {canStart.reason}
        </p>
      )}
      <ErrorNote error={start.error} />
    </div>
  );
}
