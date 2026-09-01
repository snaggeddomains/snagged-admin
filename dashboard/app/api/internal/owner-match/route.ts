// Internal endpoint for the research app's Domain Owner report: "have we worked with this
// owner before?" Auth = shared secret header x-internal-secret == RESEARCH_INTERNAL_SECRET
// (same pattern as sales-comps/report-summary; middleware.ts excludes api/internal).
//   GET ?domain=&email=&name=  → { ok, owners: OwnerMatch[] }
// Fail-soft: no match / any error → { ok:true, owners:[] } so the report just shows no banner.

import { NextResponse, type NextRequest } from "next/server";
import { matchOwnersForResearch } from "@/lib/deals/owner-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

function authStatus(req: NextRequest): "ok" | "unconfigured" | "mismatch" {
  const secret = process.env.RESEARCH_INTERNAL_SECRET || "";
  if (!secret) return "unconfigured";
  const got = (req.headers.get("x-internal-secret") || "").trim();
  return got === secret.trim() ? "ok" : "mismatch";
}

export async function GET(req: NextRequest) {
  const auth = authStatus(req);
  if (auth === "unconfigured") return NextResponse.json({ error: "Server has no RESEARCH_INTERNAL_SECRET configured." }, { status: 503 });
  if (auth === "mismatch") return NextResponse.json({ error: "Secret mismatch." }, { status: 401 });
  const url = new URL(req.url);
  try {
    const owners = await matchOwnersForResearch({
      domain: url.searchParams.get("domain") || undefined,
      email: url.searchParams.get("email") || undefined,
      name: url.searchParams.get("name") || undefined,
    });
    return NextResponse.json({ ok: true, owners });
  } catch {
    return NextResponse.json({ ok: true, owners: [] });   // fail-soft — never break the report
  }
}
