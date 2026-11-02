"use client";

import type { RulebookVersionDto } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import { useRef } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { useInvalidateStudy } from "@/lib/queries";
import { Button, ErrorNote } from "./ui";

/**
 * Check the draft's budget grids against the sponsor's budget spreadsheet (ADR-003 P2). The result is a notice, shown in
 * "Worth knowing": the signed contract is what's billed, so the spreadsheet never changes a value.
 */
export function BudgetCheck({ studyId, version }: { studyId: string; version: Pick<RulebookVersionDto, "version" | "status" | "warnings"> }) {
  const by = useActingAs();
  const input = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidateStudy();
  const check = useMutation({ mutationFn: (file: File) => api.budgetCheck(studyId, version.version, file, by!), onSuccess: () => invalidate(studyId) });
  if (version.status !== "draft") return null;
  const checked = version.warnings.some((w) => w.startsWith("The sponsor's budget spreadsheet"));
  // relative: the hidden file box is placed inside this, not against the page, or it makes a one-screen page scroll
  return (
    <div className="relative flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        aria-label="The sponsor's budget spreadsheet"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) check.mutate(f);
        }}
      />
      <Button variant="secondary" size="sm" className="self-start" disabled={check.isPending} onClick={() => (by ? input.current?.click() : askForPerson())}>
        <FileSpreadsheet className="size-4" strokeWidth={1.75} />
        {check.isPending ? "Checking…" : checked ? "Check another budget spreadsheet" : "Check against the sponsor's budget spreadsheet"}
      </Button>
      <ErrorNote error={check.error} />
    </div>
  );
}
