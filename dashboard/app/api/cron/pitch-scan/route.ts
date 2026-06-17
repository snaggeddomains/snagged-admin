// Weekly pitch-scan cron: reads the owner's Sent mail, finds outbound domain
// pitches not yet on a tracked pitch-exercise sheet, and emails a digest to the
// review address. Read-only (Gmail) + one outbound email; runs inline.
//
// Auth: CRON_SECRET (Vercel sends it as the Authorization bearer).
// Env: GOOGLE_SA_KEY (gmail), RESEND_API_KEY (+ EMAIL_FROM) to send, and
// PITCH_SCAN_TO (digest recipient, default rob@snagged.com).
//   ?days=N   widen the lookback (default 10).
//   ?dry=1    scan + return candidates as JSON without sending the email.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { gmailConfigured } from "@/lib/gmail";
import { scanPitchSuggestions, renderPitchDigest } from "@/lib/pitch-scan";
import { sendEmail, emailConfigured } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ ok: false, error: "Gmail not configured (GOOGLE_SA_KEY)." }, { status: 200 });

  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") || "10", 10) || 10, 1), 60);
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const to = process.env.PITCH_SCAN_TO || "rob@snagged.com";

  try {
    const result = await scanPitchSuggestions(days);
    const digest = renderPitchDigest(result);
    if (dry) return NextResponse.json({ ok: true, dry: true, ...result });
    if (!digest) return NextResponse.json({ ok: true, sent: false, reason: "no untracked pitches", ...result });
    if (!emailConfigured()) {
      return NextResponse.json({ ok: true, sent: false, reason: "RESEND_API_KEY not set", ...result }, { status: 200 });
    }
    const sent = await sendEmail({ to, subject: digest.subject, html: digest.html });
    return NextResponse.json({ ok: true, sent, to, candidates: result.candidates, scanned: result.scanned });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
