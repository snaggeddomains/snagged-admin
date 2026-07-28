// Deal notifications — bell + email + Slack, best-effort. Covers assignment, stage
// changes, and @mention comments. Replaces the Pipedrive assignment notifier; same
// delivery stack (createNotification / sendEmail / slackAlert), now for native deals.

import { createNotification } from "../notifications";
import { sendEmail, emailConfigured } from "../email";
import { listUsers } from "../users";
import { displayName } from "./assignees";
import { channelsFor } from "./prefs";
import { slackDm } from "./slack-dm";
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

// Deliver to each recipient on THEIR enabled channels (in-app bell / email / Slack DM).
// Per-user prefs (notif_prefs.deal), default all on. Slack is a per-user DM now, not a
// team-channel post, so it honors the recipient's preference.
async function deliver(emails: string[], title: string, bodyLines: string[], id: string, hash = ""): Promise<boolean> {
  try {
    const body = bodyLines.filter(Boolean).join("\n");
    const url = dealUrl(id) + hash;
    for (const to of emails.filter(Boolean)) {
      const ch = await channelsFor(to);
      if (ch.in_app) {
        const ids = await idsForEmails([to]);
        if (ids.length) await createNotification(ids, { kind: "deal", title, body, link: url });
      }
      // NB: the subject carries the headline (with its one emoji); the body doesn't repeat
      // it, so the inbox preview doesn't show the same emoji twice.
      if (ch.email && emailConfigured()) {
        await sendEmail({ to, subject: title, html: `${body ? `<p>${body.replace(/\n/g, "<br>")}</p>` : ""}<p><a href="${url}">Open the deal →</a></p>` });
      }
      if (ch.slack) await slackDm(to, `${title}\n${body}\n${url}`);
    }
    return true;
  } catch {
    return false;
  }
}

// A deal was assigned to an owner (on create, or a re-assign).
export async function notifyAssignment(deal: Deal): Promise<boolean> {
  if (!deal.owner_email) return false;
  const name = await displayName(deal.owner_email);
  const lines = [
    `Assigned to: ${name}`,
    deal.buyer_name || deal.buyer_email ? `Buyer: ${deal.buyer_name || ""} ${deal.buyer_email ? `<${deal.buyer_email}>` : ""}`.trim() : "",
    deal.budget_range ? `Budget: ${deal.budget_range}` : "",
    deal.source ? `Source: ${deal.source}` : "",
  ];
  return deliver([deal.owner_email], `📥 Deal assigned: ${deal.domain}`, lines, deal.id);
}

// Stage moved on the board — tell the owner (unless they moved it themselves).
export async function notifyStageChange(deal: Deal, fromStage: string, byEmail: string | null): Promise<boolean> {
  if (!deal.owner_email || (byEmail && byEmail.toLowerCase() === deal.owner_email.toLowerCase())) return false;
  return deliver([deal.owner_email], `🔀 ${deal.domain}: ${fromStage} → ${deal.stage}`, [byEmail ? `Moved by ${byEmail}` : ""], deal.id);
}

// @mention in a note — tell the mentioned users on their enabled channels (bell/email/Slack).
export async function notifyMention(deal: Deal, mentioned: string[], byEmail: string | null, comment: string): Promise<boolean> {
  const targets = mentioned.map((e) => e.toLowerCase()).filter((e) => e && e !== (byEmail || "").toLowerCase());
  if (!targets.length) return false;
  const by = byEmail ? await displayName(byEmail) : "Someone";
  return deliver(targets, `💬 ${by} mentioned you on ${deal.domain}`, [comment.slice(0, 300)], deal.id, "#comments");
}

// A deal was explicitly SHARED with someone (Share button, no comment) — tell them they now
// have access. (An @mention auto-share is announced by notifyMention instead, so this is only
// used for the button path with the NEWLY-added collaborators.)
export async function notifyShare(deal: Deal, sharedWith: string[], byEmail: string | null): Promise<boolean> {
  const targets = sharedWith.map((e) => e.toLowerCase()).filter((e) => e && e !== (byEmail || "").toLowerCase());
  if (!targets.length) return false;
  const by = byEmail ? await displayName(byEmail) : "Someone";
  const lines = [
    `${by} shared a deal with you — you can now view it and join the discussion.`,
    deal.buyer_name ? `Buyer: ${deal.buyer_name}` : "",
  ];
  return deliver(targets, `🤝 ${by} shared ${deal.domain} with you`, lines, deal.id, "#comments");
}
