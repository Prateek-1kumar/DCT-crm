import { NextResponse, type NextRequest } from "next/server";
import { authRequired, COOKIE, verify } from "@/lib/session";

/** UAT sign-in gate for pages and the /api proxy (it runs before the rewrite). Off unless AUTH_REQUIRED=1. */
export async function proxy(req: NextRequest) {
  if (!authRequired()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/auth") return NextResponse.next();
  if (await verify(req.cookies.get(COOKIE)?.value, process.env.AUTH_SECRET)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ statusCode: 401, error: "Unauthorized", message: "Your session has ended. Sign in again." }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|.*\\.png$).*)"] };
