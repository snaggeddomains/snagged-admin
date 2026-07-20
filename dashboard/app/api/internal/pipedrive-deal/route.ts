// Internal endpoint the research app's "Add to Pipedrive" button POSTs to (owner-lookup /
// appraisal / whois surfaces). Auth = shared secret (x-internal-secret == RESEARCH_INTERNAL_SECRET,
// same pattern as sales-comps / email-threads). Creates/opens the buy-side deal (idempotent)
// and fires the assignment notification (bell + email + Slack). middleware.ts excludes api/internal.

import { NextResponse, type NextRequest } from "next/server";
import { upsertBuyDeal, type BuyDealInput } from "@/lib/pipedrive-deals";
import { createNotification } from "@/lib/notifications";
import { sendEmail, emailConfigured } from "@/lib/email";
import { slackAlert } from "@/lib/orchestrator";
import { listUsers } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.RESEARCH_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const input = (await req.json().catch(() => ({}))) as BuyDealInput & { assigneeEmail?: string };
  if (!input.domain || !input.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }

  const deal = await upsertBuyDeal(input);
  if (!deal.ok) return NextResponse.json({ ok: false, error: deal.error }, { status: 502 });

  // Notify the assignee only on a NEW deal that actually has an assignee.
  let notified = false;
  if (deal.created && input.assigneeEmail) {
    try {
      const users = await listUsers();
      const assignee = users.find((u) => String((u as { email?: unknown }).email || "").toLowerCase() === input.assigneeEmail!.toLowerCase());
      const headline = `📥 New buy-side deal assigned: ${input.domain}`;
      const lines = [
        input.buyerName || input.buyerEmail ? `Buyer: ${input.buyerName || ""} ${input.buyerEmail ? `<${input.buyerEmail}>` : ""}`.trim() : "",
        input.budgetRange ? `Budget: ${input.budgetRange}` : "",
        input.source ? `Source: ${input.source}` : "",
      ].filter(Boolean);
      const body = lines.join("\n");
      if (assignee) {
        await createNotification([String((assignee as { id?: unknown }).id || "")].filter(Boolean), {
          kind: "pipedrive_deal", title: headline, body, link: deal.url || null,
        });
        if (emailConfigured() && (assignee as { email?: string }).email) {
          await sendEmail({
            to: (assignee as { email: string }).email,
            subject: headline,
            html: `<p style="font-size:15px;font-weight:700">${headline}</p>${body ? `<p>${body.replace(/\n/g, "<br>")}</p>` : ""}<p><a href="${deal.url}">Open the deal in Pipedrive →</a></p>`,
          });
        }
      }
      await slackAlert(`${headline}\n${body}\n<${deal.url}|Open deal>`, process.env.SLACK_CHANNEL_DEALS);
      notified = true;
    } catch { /* notification is best-effort — the deal still exists */ }
  }

  return NextResponse.json({ ok: true, dealId: deal.dealId, created: deal.created, url: deal.url, notified });
}
