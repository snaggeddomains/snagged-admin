// Buy-side triage queue API. GET lists the enriched inbound inquiries; POST converts
// one into a NATIVE deal (human-triggered — Rob's discretion). Gated by the
// research.pipedrive permission (admins auto-pass). Convert = createDeal + the deal
// assignment notification, landing the inquiry on the Deals board.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listBuyInquiries } from "@/lib/inquiries";
import { createDeal, type CreateDealInput } from "@/lib/deals/store";
import { notifyAssignment, dealUrl } from "@/lib/deals/notify";
import { SOURCES } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";

// Drawer metadata (assignable owners = "can receive deals" users, by name + Source labels).
async function convertMeta(): Promise<{ assignees: { name: string; email: string }[]; sources: string[] }> {
  let assignees: { name: string; email: string }[] = [];
  try { assignees = await assignableUsers(); } catch { /* fail-open */ }
  return { assignees, sources: [...SOURCES] };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "research.pipedrive")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const url = new URL(req.url);
  const includeSell = url.searchParams.get("all") === "1";
  const q = url.searchParams.get("q") || "";
  try {
    const [data, meta] = await Promise.all([listBuyInquiries({ includeSell, q }), convertMeta()]);
    return NextResponse.json({ ok: true, ...data, meta });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "research.pipedrive")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown> & { assigneeEmail?: string };
  if (!b.domain || !b.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }
  const input: CreateDealInput = {
    domain: String(b.domain),
    source: String(b.source),
    buyerName: b.buyerName ? String(b.buyerName) : undefined,
    buyerEmail: b.buyerEmail ? String(b.buyerEmail) : undefined,
    orgName: b.orgName ? String(b.orgName) : undefined,
    ownerEmail: b.assigneeEmail ? String(b.assigneeEmail) : undefined,
    budgetRange: b.budgetRange ? String(b.budgetRange) : undefined,
    priority: b.priority ? String(b.priority) : undefined,
    additionalDomains: b.additionalDomains ? String(b.additionalDomains) : undefined,
    reportLink: b.reportLink ? String(b.reportLink) : undefined,
    leadKey: b.leadKey ? String(b.leadKey) : undefined,
    createdBy: me.email,
  };
  try {
    const { deal, created } = await createDeal(input);
    const notified = created && deal.owner_email ? await notifyAssignment(deal) : false;
    return NextResponse.json({ ok: true, dealId: deal.id, created, url: dealUrl(deal.id), notified });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 502 });
  }
}
