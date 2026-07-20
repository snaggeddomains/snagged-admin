// Shared assignment notification for a NEW buy-side Pipedrive deal — bell + email +
// Slack to the buy-side channel. Used by both the research-app internal endpoint and
// the Admin buy-side triage queue's convert action, so the two behave identically.

import { createNotification } from "./notifications";
import { sendEmail, emailConfigured } from "./email";
import { slackAlert } from "./orchestrator";
import { listUsers } from "./users";

export type DealAssignmentInfo = {
  domain: string;
  assigneeEmail?: string;
  buyerName?: string;
  buyerEmail?: string;
  budgetRange?: string;
  source?: string;
  url?: string;
};

// Fires only when there's an assignee. Best-effort — a notification failure never
// affects the deal. Returns true if anything was sent.
export async function notifyBuyDealAssignment(info: DealAssignmentInfo): Promise<boolean> {
  if (!info.assigneeEmail) return false;
  try {
    const headline = `📥 New buy-side deal assigned: ${info.domain}`;
    const lines = [
      info.buyerName || info.buyerEmail ? `Buyer: ${info.buyerName || ""} ${info.buyerEmail ? `<${info.buyerEmail}>` : ""}`.trim() : "",
      info.budgetRange ? `Budget: ${info.budgetRange}` : "",
      info.source ? `Source: ${info.source}` : "",
    ].filter(Boolean);
    const body = lines.join("\n");
    const users = await listUsers();
    const assignee = users.find((u) => String((u as { email?: unknown }).email || "").toLowerCase() === info.assigneeEmail!.toLowerCase());
    if (assignee) {
      await createNotification([String((assignee as { id?: unknown }).id || "")].filter(Boolean), {
        kind: "pipedrive_deal", title: headline, body, link: info.url || null,
      });
      if (emailConfigured() && (assignee as { email?: string }).email) {
        await sendEmail({
          to: (assignee as { email: string }).email,
          subject: headline,
          html: `<p style="font-size:15px;font-weight:700">${headline}</p>${body ? `<p>${body.replace(/\n/g, "<br>")}</p>` : ""}${info.url ? `<p><a href="${info.url}">Open the deal in Pipedrive →</a></p>` : ""}`,
        });
      }
    }
    await slackAlert(`${headline}\n${body}${info.url ? `\n<${info.url}|Open deal>` : ""}`, process.env.SLACK_CHANNEL_DEALS);
    return true;
  } catch {
    return false;
  }
}
