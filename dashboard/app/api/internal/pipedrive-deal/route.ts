// Internal endpoint the research app's "Add to Pipedrive" button POSTs to (owner-lookup /
// appraisal / whois surfaces). Auth = shared secret (x-internal-secret == RESEARCH_INTERNAL_SECRET,
// same pattern as sales-comps / email-threads). Creates/opens the buy-side deal (idempotent)
// and fires the assignment notification (bell + email + Slack). middleware.ts excludes api/internal.

import { NextResponse, type NextRequest } from "next/server";
import { upsertBuyDeal, type BuyDealInput } from "@/lib/pipedrive-deals";
import { notifyBuyDealAssignment } from "@/lib/pipedrive-notify";
import { getUsers } from "@/lib/pipedrive";
import { resolvePipedrive } from "@/lib/pipedrive-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authed(req: NextRequest): boolean {
  const secret = process.env.RESEARCH_INTERNAL_SECRET;
  return Boolean(secret) && req.headers.get("x-internal-secret") === secret;
}

// GET — the metadata the research-app "Add to Pipedrive" drawer needs to build its
// form: the ASSIGNABLE users (active Pipedrive owners — so we never offer someone the
// deal can't actually route to) + the Source/Channel enum labels. Read-only.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let assignees: { name: string; email: string }[] = [];
  try {
    const u = await getUsers();
    assignees = (u.data || [])
      .filter((x) => x.active_flag && x.email)
      .map((x) => ({ name: x.name || x.email, email: x.email }));
  } catch { /* fail-open → empty; the drawer still lets you create Unassigned */ }
  let sources: string[] = [];
  try {
    const R = await resolvePipedrive();
    sources = [...R.optionId.keys()].filter((k) => k.startsWith("Source / Channel||")).map((k) => k.split("||")[1]);
  } catch { /* fail-open */ }
  return NextResponse.json({ ok: true, assignees, sources });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const input = (await req.json().catch(() => ({}))) as BuyDealInput & { assigneeEmail?: string };
  if (!input.domain || !input.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }

  const deal = await upsertBuyDeal(input);
  if (!deal.ok) return NextResponse.json({ ok: false, error: deal.error }, { status: 502 });

  // Notify the assignee only on a NEW deal that actually has an assignee.
  const notified = deal.created
    ? await notifyBuyDealAssignment({
        domain: input.domain, assigneeEmail: input.assigneeEmail,
        buyerName: input.buyerName, buyerEmail: input.buyerEmail,
        budgetRange: input.budgetRange, source: input.source, url: deal.url,
      })
    : false;

  return NextResponse.json({ ok: true, dealId: deal.dealId, created: deal.created, url: deal.url, notified });
}
