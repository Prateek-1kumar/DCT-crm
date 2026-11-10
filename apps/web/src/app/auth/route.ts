import { NextResponse } from "next/server";
import { authRequired, COOKIE, MAX_AGE, NAME_COOKIE, sign } from "@/lib/session";

const API_URL = process.env.API_URL ?? "http://localhost:4100";

/** Sign in: the login form posts here; the API says whether the name and password are right. */
export async function POST(req: Request) {
  const form = await req.formData();
  const secret = process.env.AUTH_SECRET;
  // 303 so the browser turns the POST into a GET; a relative Location, so it stays on whatever host the browser used
  const back = (path: string) => new NextResponse(null, { status: 303, headers: { location: path } });
  if (!authRequired()) return back("/");
  if (!secret) return back("/login?problem=1");

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(form.get("name") ?? ""), password: String(form.get("password") ?? "") }),
    });
  } catch {
    return back("/login?problem=1");
  }
  if (res.status === 401 || res.status === 400) return back("/login?wrong=1");
  if (!res.ok) return back("/login?problem=1");

  const { name, displayName } = (await res.json()) as { name: string; displayName: string };
  const out = back("/");
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const opts = { sameSite: "lax", secure, path: "/", maxAge: MAX_AGE } as const;
  out.cookies.set(COOKIE, await sign(name, secret), { ...opts, httpOnly: true });
  out.cookies.set(NAME_COOKIE, displayName, opts);
  return out;
}

/** Sign out. */
export async function DELETE() {
  const res = new NextResponse(null, { status: 204 });
  res.cookies.delete(COOKIE);
  res.cookies.delete(NAME_COOKIE);
  return res;
}
