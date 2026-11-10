"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { btnCls, Field, inputCls } from "@/components/ui";

/** UAT sign-in. A plain form post, so it works before any script has loaded. */
export default function Login() {
  const q = useSearchParams();
  return (
    <div className="mx-auto flex min-h-screen max-w-[380px] flex-col justify-center gap-6 px-4">
      <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={160} height={40} priority className="h-auto w-40" />
      <form method="post" action="/auth" className="flex flex-col gap-4">
        <h1 className="text-title font-semibold tracking-tight">Sign in</h1>
        {q.has("wrong") && <p role="alert" className="text-body text-warn">That name or password isn&apos;t right. Check them and try again.</p>}
        {q.has("problem") && <p role="alert" className="text-body text-warn">We couldn&apos;t check your password just now. Try again in a minute; if it keeps happening, tell the team.</p>}
        <Field label="Name" htmlFor="name">
          <input id="name" name="name" autoComplete="username" required autoFocus className={inputCls} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" name="password" type="password" autoComplete="current-password" required className={inputCls} />
        </Field>
        <button type="submit" className={btnCls("primary")}>Sign in</button>
      </form>
    </div>
  );
}
