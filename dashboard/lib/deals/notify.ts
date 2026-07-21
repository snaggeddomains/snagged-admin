// Deal notifications — bell + email + Slack, best-effort. Covers assignment, stage
// changes, and @mention comments. Replaces the Pipedrive assignment notifier; same
// delivery stack (createNotification / sendEmail / slackAlert), now for native deals.

import { createNotification } from "../notifications";
import { sendEmail, emailConfigured } from "../email";
import { slackAlert } from "../orchestrator";
import { listUsers } from "../users";
import type { Deal } from "./store";

const APP_BASE = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/+$/, "");
export function dealUrl(id: string): string {
  return `${APP_BASE}/deals/${id}`;
}

// email → user id (for the bell). Our app users carry no display name, so labels use email.
async function idsForEmails(emails: string[]): Promise<string[]> {
  const want = new Set(emails.map((e) => e.toLowerCase()).filter(Boolean));
  if (!want.size) return [];
  const users = await listUsers();
  return users.filter((u) => want.has(String(u.email || "").toLowerCase())).map((u) => u.id).filter(Boolean);
}

async function deliver(emails: string[], title: string, bodyLines: string[], id: string, slack: boolean): Promise<boolean> {
  try {
    const body = bodyLines.filter(Boolean).join("\n");
    const url = dealUrl(id);
    const ids = await idsForEmails(emails);
    if (ids.length) await createNotification(ids, { kind: "deal", title, body, link: url });
    if (emailConfigured()) {
      for (const to of emails.filter(Boolean)) {
        await sendEmail({ to, subject: title, html: `<p style="font-size:15px;font-weight:700">${title}</p>${body ? `<p>${body.replace(/\n/g, "<br>")}</p>` : ""}<p><a href="${url}">Open the deal →</a></p>` });
      }
    }
    if (slack) await slackAlert(`${title}\n${body}\n<${url}|Open deal>`, process.env.SLACK_CHANNEL_DEALS);
    return true;
  } catch {
    return false;
  }
}

// A deal was assigned to an owner (on create, or a re-assign).
export async function notifyAssignment(deal: Deal): Promise<boolean> {
  if (!deal.owner_email) return false;
  const lines = [
    deal.buyer_name || deal.buyer_email ? `Buyer: ${deal.buyer_name || ""} ${deal.buyer_email ? `<${deal.buyer_email}>` : ""}`.trim() : "",
    deal.budget_range ? `Budget: ${deal.budget_range}` : "",
    deal.source ? `Source: ${deal.source}` : "",
  ];
  return deliver([deal.owner_email], `📥 Deal assigned to ${deal.owner_email}: ${deal.domain}`, lines, deal.id, true);
}

// Stage moved on the board — tell the owner (unless they moved it themselves).
export async function notifyStageChange(deal: Deal, fromStage: string, byEmail: string | null): Promise<boolean> {
  if (!deal.owner_email || (byEmail && byEmail.toLowerCase() === deal.owner_email.toLowerCase())) return false;
  return deliver([deal.owner_email], `🔀 ${deal.domain}: ${fromStage} → ${deal.stage}`, [byEmail ? `Moved by ${byEmail}` : ""], deal.id, true);
}

// @mention in a comment — tell the mentioned users (not Slack).
export async function notifyMention(deal: Deal, mentioned: string[], byEmail: string | null, comment: string): Promise<boolean> {
  const targets = mentioned.map((e) => e.toLowerCase()).filter((e) => e && e !== (byEmail || "").toLowerCase());
  if (!targets.length) return false;
  return deliver(targets, `💬 ${byEmail || "Someone"} mentioned you on ${deal.domain}`, [comment.slice(0, 300)], deal.id, false);
}
