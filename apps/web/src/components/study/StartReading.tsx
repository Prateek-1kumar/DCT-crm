"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { Button, ErrorNote } from "../ui";

export function StartReading({ studyId, label, disabled, onStarted }: { studyId: string; label: string; disabled?: boolean; onStarted?: () => void }) {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.startRead(studyId, by!),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: keys.study(studyId) }), queryClient.invalidateQueries({ queryKey: keys.studies })]);
      onStarted?.();
    },
  });
  return (
    <div className="flex flex-col items-start gap-2.5">
      <Button variant="primary" size="lg" disabled={disabled || start.isPending} onClick={() => (by ? start.mutate() : askForPerson())}>
        {start.isPending ? "Starting…" : label}
      </Button>
      <ErrorNote error={start.error} />
    </div>
  );
}
