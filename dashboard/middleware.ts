// Authentication gate for the umbrella. Edge runtime.
//
// Verifies the shared `dr_auth` cookie (HMAC + expiry) on every request. No
// valid session → redirect to /login. This is the AUTHENTICATION gate only;
// per-module / per-action AUTHORIZATION (loading the user and checking the
// permission catalog) happens in server components, which can reach the DB.
//
// Excluded: /login and /api/login (so an unauthenticated user can sign in),
// /api/cron/* and /api/inbound/* (machine-to-machine; secured by a secret in the
// route — CRON_SECRET / the Resend webhook signature — not the session cookie,
// since the caller sends no cookie), and Next's static assets.

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifyCookie, authSecret } from "./lib/auth";

export const config = {
  // Exclude public assets (brand/, fonts/) so the login page can load the
  // mascot + brand fonts before the user is authenticated, plus /login itself
  // and the CRON_SECRET-gated /api/cron routes (Vercel Cron has no session).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand|fonts|login|api/login|api/cron|api/inbound).*)"],
};

export async function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname;

  // Password-reset / invite links land on /research?reset=<token> while the user
  // has NO session (they're locked out — that's the whole point). Two things
  // must load without a session for the set-password form to render:
  //   1. the reset PAGE itself (carries ?reset=), and
  //   2. research's static assets (app.js, styles.css, fonts, mascot) — these
  //      are SEPARATE requests that do NOT carry ?reset=, so without this they'd
  //      be redirected to /login and the SPA would never boot (blank page).
  // Research's /api/* stays gated (no file extension), the reset form posts to
  // /api/login (excluded), and the token is verified server-side — so this opens
  // nothing sensitive; static bundles are public by nature.
  const isResetPage = p.startsWith("/research") && req.nextUrl.searchParams.has("reset");
  const isResearchAsset =
    p.startsWith("/research/") &&
    /\.(js|mjs|css|map|svg|png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|json|txt)$/i.test(p);
  // research's auth endpoint (login / forgot-password / reset-confirm) and the
  // session probe must work WITHOUT a session — they're how a logged-out user
  // signs in or finishes a reset. The SPA posts reset-confirm here; gating it
  // bounced the POST to /login and returned 405. Everything else under
  // /research/api/* stays gated.
  const isResearchAuthApi = p === "/research/api/login" || p === "/research/api/me";
  if (isResetPage || isResearchAsset || isResearchAuthApi) {
    return NextResponse.next();
  }

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
