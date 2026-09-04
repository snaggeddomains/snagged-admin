// Daily Gmail-mirror delta sync — keeps the local gmail_messages copy current with cheap incremental
// History-API pulls, so the mirror-backed readers (owner-review, marketplace deal report, leads,
// client-corpus, chat-attach) stay both Gmail-free AND up-to-date. Runs once/day at the very end of the
// (UTC) day, before the read-budget resets, using the day's leftover capacity off-peak. Auth: CRON_SECRET.
//   ?mailbox=<addr> to sync just one box.
// Governed under "mirror-sync": a per-mailbox budget stop just skips that box (retries next run).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { syncAllMailboxes, syncMailbox } from "@/lib/gmail-mirror/sync";
import { withGmailFeature } from "@/lib/gmail-budget";
import { recordHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const one = new URL(req.url).searchParams.get("mailbox");
  try {
    const results = one
      ? [await withGmailFeature("mirror-sync", () => syncMailbox(one))]
      : await syncAllMailboxes();
    const added = results.reduce((s, r) => s + r.added, 0);
    await recordHeartbeat("gmail-mirror-sync", { added, mailboxes: results.length, results }).catch(() => {});
    return NextResponse.json({ ok: true, added, results });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
