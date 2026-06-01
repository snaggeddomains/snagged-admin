// Authentication gate for the umbrella. Edge runtime.
//
// Verifies the shared `dr_auth` cookie (HMAC + expiry) on every request. No
// valid session → redirect to /login. This is the AUTHENTICATION gate only;
// per-module / per-action AUTHORIZATION (loading the user and checking the
// permission catalog) happens in server components, which can reach the DB.
//
// Excluded: /login and /api/login (so an unauthenticated user can sign in),
// /api/cron/* (machine-to-machine; secured by CRON_SECRET in the route, not the
// session cookie — Vercel Cron sends no cookie), and Next's static assets.

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifyCookie, authSecret } from "./lib/auth";

export const config = {
  // Exclude public assets (brand/, fonts/) so the login page can load the
  // mascot + brand fonts before the user is authenticated, plus /login itself
  // and the CRON_SECRET-gated /api/cron routes (Vercel Cron has no session).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand|fonts|login|api/login|api/cron).*)"],
};

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(COOKIE)?.value;
  const session = await verifyCookie(token, authSecret());
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
