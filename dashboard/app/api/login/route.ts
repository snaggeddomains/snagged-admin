// Login proxy. Credential logic (scrypt verify, reset, admin bootstrap) stays
// in research's /api/login — the single source of truth. The umbrella forwards
// the POST and re-emits the Set-Cookie scoped to the whole umbrella domain.
//
// The research form contract: POST JSON { action: "login" | "reset-request" |
// "reset-confirm", ... }.

import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ".snagged.com";

function researchOrigin(): string {
  return process.env.RESEARCH_ORIGIN || "https://research.snagged.com";
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const upstream = await fetch(`${researchOrigin()}/api/login`, {
    method: "POST",
    headers: { "content-type": req.headers.get("content-type") || "application/json" },
    body,
  });

  const text = await upstream.text();
  const res = new NextResponse(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
    },
  });

  // Pass through the session cookie, ensuring it is scoped to the umbrella
  // domain so app.snagged.com and every module share it. (Research will also
  // set Domain=.snagged.com once its Phase-1 change ships; this is belt-and-
  // suspenders for the transition.)
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) {
    const cookie = /;\s*Domain=/i.test(setCookie)
      ? setCookie
      : `${setCookie}; Domain=${COOKIE_DOMAIN}`;
    res.headers.set("set-cookie", cookie);
  }
  return res;
}
