"use client";

import type { SettingsDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { Button, Card, ErrorNote, LoadError, PageTitle, pageCls, Spinner, cx, inputCls } from "@/components/ui";
import { MOCK, api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { keys, useSettings } from "@/lib/queries";

export default function SettingsPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  const me = useActingAs();
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: (patch: Partial<SettingsDto>) => api.patchSettings({ ...patch, ...(me ? { by: me } : {}) } as Partial<SettingsDto>),
    onSuccess: (s) => qc.setQueryData(keys.settings, s),
  });

  if (!settings.data)
    return settings.error ? <LoadError error={settings.error} what="settings" retry={() => void settings.refetch()} /> : <div className="p-6"><Spinner label="Loading settings" /></div>;
  const { people, makerChecker } = settings.data;
  const trimmed = name.trim();
  const dupe = people.some((p) => p.toLowerCase() === trimmed.toLowerCase());

  return (
    <div className={`${pageCls} max-w-[760px]`}>
      <PageTitle eyebrow="Workspace" title="Settings" sub="Shared by everyone who uses this workspace." />
      <div className="flex flex-col gap-5">
        <Card className="p-5">
          <h2 className="text-lg">People</h2>
          <p className="mb-3 text-sm text-muted">
            The names in the “Acting as” list. There is no login yet: anyone can pick any name, and everything done is recorded under the chosen name.
          </p>
          <ul className="mb-3 divide-y divide-line rounded-md border border-line">
            {people.map((p) => (
              <li key={p} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  {p} {p === me && <span className="text-xs text-muted">(you)</span>}
                </span>
                <Button size="sm" variant="ghost" disabled={save.isPending || people.length <= 1} onClick={() => save.mutate({ people: people.filter((x) => x !== p) })} aria-label={`Remove ${p}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!trimmed || dupe) return;
              save.mutate({ people: [...people, trimmed] }, { onSuccess: () => setName("") });
            }}
          >
            <label htmlFor="new-person" className="sr-only">
              New person&apos;s name
            </label>
            <input id="new-person" className={inputCls} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" disabled={!trimmed || dupe || save.isPending}>
              Add
            </Button>
          </form>
          {dupe && <p className="mt-1 text-xs text-warn">Already in the list.</p>}
        </Card>

        <Card className="p-5">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h2 className="text-lg" id="mc-h">
                Maker-checker
              </h2>
              <p className="mt-1 text-sm text-muted">
                When on, a person who answered a contract&apos;s questions can&apos;t also approve it; someone else has to. Off by default.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={makerChecker}
              aria-labelledby="mc-h"
              disabled={save.isPending}
              onClick={() => save.mutate({ makerChecker: !makerChecker })}
              className={cx("relative mt-1 h-6 w-11 shrink-0 rounded-full border transition-colors", makerChecker ? "border-ink bg-ink" : "border-line-strong bg-sunken")}
            >
              <span className={cx("absolute top-0.5 size-4.5 rounded-full shadow transition-all", makerChecker ? "left-[1.375rem] bg-surface" : "left-0.5 bg-faint")} />
            </button>
          </div>
          <p className="mt-2 text-sm">{makerChecker ? "On: the person who answers and the person who approves must be different." : "Off: anyone can approve."}</p>
        </Card>
        {!me && <NeedsPerson />}
        <ErrorNote error={save.error} />

        {MOCK && (
          <Card className="p-5">
            <h2 className="text-lg">Sample data</h2>
            <p className="mb-3 text-sm text-muted">This build runs on made-up sample data kept in your browser. Reset it to the starting state.</p>
            <Button
              variant="danger"
              onClick={async () => {
                // The flag is checked here, not via MOCK: only an inlined `if (process.env…)` lets a real build drop the sample server.
                if (process.env.NEXT_PUBLIC_API_MOCK === "1") (await import("@/lib/mock/server")).mockReset();
                await qc.invalidateQueries();
              }}
            >
              Reset sample data
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
