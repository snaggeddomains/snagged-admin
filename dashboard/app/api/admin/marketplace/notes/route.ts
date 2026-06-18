// Per-domain broker notes for the Marketplace deal report (GET + POST).
// Free-text the broker maintains for off-platform activity (offers over
// text/WhatsApp/phone, context, next steps); folded into the generated client
// Doc. Gated reports.marketplace.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { getNotes, saveNotes } from "@/lib/marketplace-notes";

export const runtime = "nodejs";

const cleanDomain = (s: string) => (s || "").toLowerCase().trim().replace(/^www\./, "");
const valid = (d: string) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d);

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const domain = cleanDomain(req.nextUrl.searchParams.get("domain") || "");
  if (!valid(domain)) return NextResponse.json({ error: "Provide a valid ?domain=" }, { status: 400 });
  const notes = await getNotes(domain);
  return NextResponse.json({ ok: true, domain, ...notes });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) return NextResponse.json({ error: "No access" }, { status: 403 });

  let body: { domain?: string; notes?: string };
  try { body = await req.json(); } catch { body = {}; }
  const domain = cleanDomain(body.domain || "");
  if (!valid(domain)) return NextResponse.json({ error: "Provide a valid domain" }, { status: 400 });

  try {
    const saved = await saveNotes(domain, body.notes || "", me.email || null);
    return NextResponse.json({ ok: true, domain, ...saved });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
