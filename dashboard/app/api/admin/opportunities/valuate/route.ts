// On-demand valuation for a SNAP/auction row — Appraise.net value + TLD-demand count, fetched from
// the research app (the valuation keys live only there). Gated by the SNAP Opportunities report.
// GET ?domain=one.com → { valuation }; POST { domains:[...] } → { valuations: { domain: val } }.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { valuateDomains, researchValuationConfigured, type Valuation } from "@/lib/research-valuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function guard() {
  const me = await getCurrentUser();
  if (!me) return { err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!canReports(me, "reports.opportunities")) return { err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  if (!researchValuationConfigured()) return { err: NextResponse.json({ error: "Valuation not configured (RESEARCH_INTERNAL_SECRET)" }, { status: 503 }) };
  return { err: null };
}

export async function GET(req: NextRequest) {
  const g = await guard(); if (g.err) return g.err;
  const domain = (req.nextUrl.searchParams.get("domain") || "").trim().toLowerCase();
  if (!domain.includes(".")) return NextResponse.json({ error: "domain required" }, { status: 400 });
  const map = await valuateDomains([domain]);
  return NextResponse.json({ ok: true, valuation: map.get(domain) || null });
}

export async function POST(req: NextRequest) {
  const g = await guard(); if (g.err) return g.err;
  const body = (await req.json().catch(() => ({}))) as { domains?: string[] };
  const domains = [...new Set((body.domains || []).map((d) => String(d || "").trim().toLowerCase()).filter((d) => d.includes(".")))].slice(0, 40);
  if (!domains.length) return NextResponse.json({ error: "domains[] required" }, { status: 400 });
  const map = await valuateDomains(domains);
  const valuations: Record<string, Valuation> = {};
  for (const d of domains) { const v = map.get(d); if (v) valuations[d] = v; }
  return NextResponse.json({ ok: true, valuations });
}
