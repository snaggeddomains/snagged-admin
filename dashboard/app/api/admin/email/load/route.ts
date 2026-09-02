// Inbox load — read-only view of how much WE are reading the deal mailboxes, so the shared
// per-user Gmail quota (which Superhuman draws on) never gets blown by our features again.
// Two lenses: (1) our own read ledger today, per mailbox, broken down by feature (from the
// gmail_read_budget governor); (2) best-effort Google OAuth-token audit for each mailbox
// (which apps authorized to it, last 7d) — needs the admin.reports scope on the SA's DWD.
// Gated by the `email` module perm.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { dealMailboxes } from "@/lib/gmail";
import { budgetStatus, CAPS } from "@/lib/gmail-budget";
import { googleAccessToken } from "@/lib/google-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REPORTS_SCOPE = "https://www.googleapis.com/auth/admin.reports.audit.readonly";

// Per-mailbox OAuth token grants in the last 7d, grouped by app — the audit lens that shows OUR
// SA vs Superhuman vs everything else. Fail-open (returns null per mailbox if the scope/API
// isn't available), so the ledger view always renders.
async function auditByApp(mailbox: string, adminSubject: string): Promise<{ app: string; events: number }[] | null> {
  try {
    const token = await googleAccessToken(REPORTS_SCOPE, adminSubject);
    const start = new Date(Date.now() - 7 * 864e5).toISOString();
    const url = `https://admin.googleapis.com/admin/reports/v1/activity/users/${encodeURIComponent(mailbox)}/applications/token?maxResults=1000&startTime=${start}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { items?: { events?: { parameters?: { name: string; value?: string; intValue?: string; boolValue?: boolean }[] }[] }[] };
    const byApp: Record<string, number> = {};
    for (const it of j.items || []) {
      for (const e of it.events || []) {
        const p = Object.fromEntries((e.parameters || []).map((x) => [x.name, x.value ?? x.intValue ?? x.boolValue]));
        const app = String(p.app_name || p.client_id || "?");
        byApp[app] = (byApp[app] || 0) + 1;
      }
    }
    return Object.entries(byApp).map(([app, events]) => ({ app, events })).sort((a, b) => b.events - a.events).slice(0, 12);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const mailboxes = dealMailboxes();
  const withAudit = new URL(req.url).searchParams.get("audit") === "1";
  const ledger = await budgetStatus(mailboxes);

  let audit: Record<string, { app: string; events: number }[] | null> | null = null;
  if (withAudit) {
    // The Reports API needs an ADMIN subject; use the caller if they're an admin, else rob@.
    const subject = me.is_admin ? me.email : "rob@snagged.com";
    audit = {};
    for (const mb of mailboxes) audit[mb] = await auditByApp(mb, subject);
  }

  return NextResponse.json({
    ok: true,
    mailboxes,
    ledger,      // [{ mailbox, reads, bytes, by_feature, bg_read_cap, bg_byte_cap }]
    caps: CAPS,
    audit,       // null unless ?audit=1; then { mailbox: [{app,events}] | null }
    day: new Date().toISOString().slice(0, 10),
  });
}
