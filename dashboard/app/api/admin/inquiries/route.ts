// Buy-side triage queue API. GET lists the enriched inbound inquiries; POST converts
// one into a Pipedrive deal (human-triggered — Rob's discretion). Gated by the
// research.pipedrive permission (admins auto-pass). Convert reuses upsertBuyDeal +
// the shared assignment notification, so it behaves exactly like the research button.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listBuyInquiries } from "@/lib/inquiries";
import { upsertBuyDeal, type BuyDealInput } from "@/lib/pipedrive-deals";
import { notifyBuyDealAssignment } from "@/lib/pipedrive-notify";
import { getUsers } from "@/lib/pipedrive";
import { resolvePipedrive } from "@/lib/pipedrive-fields";

// The drawer metadata (assignable Pipedrive owners + Source/Channel labels), fetched
// once alongside the list so the convert form is ready. Fail-open to empties.
async function pipedriveMeta(): Promise<{ assignees: { name: string; email: string }[]; sources: string[] }> {
  let assignees: { name: string; email: string }[] = [];
  let sources: string[] = [];
  try {
    const u = await getUsers();
    assignees = (u.data || []).filter((x) => x.active_flag && x.email).map((x) => ({ name: x.name || x.email, email: x.email }));
  } catch { /* fail-open */ }
  try {
    const R = await resolvePipedrive();
    sources = [...R.optionId.keys()].filter((k) => k.startsWith("Source / Channel||")).map((k) => k.split("||")[1]);
  } catch { /* fail-open */ }
  return { assignees, sources };
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
    const [data, meta] = await Promise.all([listBuyInquiries({ includeSell, q }), pipedriveMeta()]);
    return NextResponse.json({ ok: true, ...data, meta });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "research.pipedrive")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const input = (await req.json().catch(() => ({}))) as BuyDealInput;
  if (!input.domain || !input.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }
  const deal = await upsertBuyDeal(input);
  if (!deal.ok) return NextResponse.json({ ok: false, error: deal.error }, { status: 502 });

  const notified = deal.created
    ? await notifyBuyDealAssignment({
        domain: input.domain, assigneeEmail: input.assigneeEmail,
        buyerName: input.buyerName, buyerEmail: input.buyerEmail,
        budgetRange: input.budgetRange, source: input.source, url: deal.url,
      })
    : false;
  return NextResponse.json({ ok: true, dealId: deal.dealId, created: deal.created, url: deal.url, notified });
}
