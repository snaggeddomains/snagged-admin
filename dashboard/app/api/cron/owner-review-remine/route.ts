// Background drain: re-mine the wrong-looking Owner Review cards (broker/none · no seller named)
// with the whole-thread miner and assign each to Judy — so Rob doesn't click "Re-mine" repeatedly.
// Each invocation DRAINS A CHUNK: a time-boxed loop of batches until ~220s elapsed or nothing wrong
// remains. Vercel does NOT reliably fire a */2 schedule (observed ~10-min cadence), so relying on
// frequent ticks stalls; draining a lot per invocation makes the backlog clear in a few ticks
// regardless of how often Vercel actually fires. Each card is re-mined ONCE (remined_at marker), so
// the drain terminates and later ticks no-op. Auth: CRON_SECRET.
//   ?limit=N per batch (default 12) · ?once=1 (single batch) · ?dry=1 (preview one batch, no writes)
import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { remineWrongCards } from "@/lib/deals/owner-review-mine";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { withGmailFeature } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINE_ASSIGNEE = process.env.OWNER_REVIEW_REMINE_ASSIGNEE || "judy@snagged.com";

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const batch = Math.min(Number(url.searchParams.get("limit")) || 12, 40);
  const dry = url.searchParams.get("dry") === "1";
  const once = dry || url.searchParams.get("once") === "1";
  const chain = Number(url.searchParams.get("chain")) || 0;
  const MAX_CHAIN = 60;   // hard cap so a self-chain can never run away (60 × batch ≫ backlog)
  const deadline = Date.now() + 220000; // stay under maxDuration 300
  let scanned = 0, updated = 0, found = 0, remaining = 0, note: string | undefined;
  try {
    await withGmailFeature("owner-review-remine", async () => {
      do {
        const s = await remineWrongCards({ limit: batch, dry, assignTo: REMINE_ASSIGNEE, requireMarker: !dry });
        scanned += s.scanned; updated += s.updated; found += s.found; remaining = s.remaining; note = s.note;
        if (once || s.note || s.scanned === 0 || s.remaining === 0) break;   // note = migration missing → stop (don't loop)
      } while (Date.now() < deadline);
    });
    if (!dry) await recordHeartbeat("owner-review-remine", { updated, found, remaining }).catch(() => {});
    // Self-chain: kick the next chunk ourselves so one trigger cascades through the backlog instead of
    // waiting for Vercel's next tick. OFF by default now — cascading back-to-back invocations HAMMERS
    // the shared per-user Gmail quota (brian@ was getting throttled), and the */5 schedule at low
    // concurrency drains gently enough. Set OWNER_REVIEW_REMINE_CHAIN=1 to re-enable when mailboxes
    // aren't under pressure. Bounded by MAX_CHAIN + the remined_at marker.
    const chainOn = process.env.OWNER_REVIEW_REMINE_CHAIN === "1";
    if (chainOn && !dry && !once && !note && remaining > 0 && chain < MAX_CHAIN) {
      const next = new URL(req.url); next.searchParams.set("chain", String(chain + 1)); next.searchParams.set("limit", String(batch));
      fetch(next.toString(), { headers: { authorization: `Bearer ${process.env.CRON_SECRET || ""}` } }).catch(() => {});
    }
    return NextResponse.json({ ok: true, scanned, updated, found, remaining, chain, note });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
