// Resend Inbound webhook for the daily NameJet backorder email.
//
// Flow: a Gmail filter forwards noreply@namejet.com → a Resend Inbound address;
// Resend POSTs the email here. We verify Resend's (Svix) signature, then stash
// the raw email in the naming-project table `namejet_inbound`. The Python source
// `namejet_email_digest` (daily auctions run) parses + filters + publishes it.
//
// We stay lenient on the sender — Gmail forwarding rewrites the envelope From —
// and let the downstream parser validate it's a NameJet digest (a non-NameJet
// email simply yields zero auction rows).
//
// Env: RESEND_INBOUND_SIGNING_SECRET (whsec_…) + the naming Supabase vars.

import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { getNamingDb, isNamingConfigured } from "@/lib/naming";

export const runtime = "nodejs";

const INBOX_TABLE = "namejet_inbound";

// Verify a Svix-signed webhook (Resend uses Svix). Svix sends both the legacy
// `svix-*` headers and the standardized `webhook-*` aliases; accept either.
// Signature header is a space-separated list of "v1,<base64>"; content signed is
// `${id}.${ts}.${body}`.
function verifySignature(secret: string, headers: Headers, rawBody: string): boolean {
  const id = headers.get("svix-id") || headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") || headers.get("webhook-timestamp");
  const sigHeader = headers.get("svix-signature") || headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const secretBytes = Buffer.from((secret.split("_")[1] ?? secret), "base64");
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(`${id}.${ts}.${rawBody}`)
    .digest("base64");
  const expBuf = Buffer.from(expected);
  return sigHeader.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

// Resend's inbound payload shape isn't perfectly stable, so pull fields
// defensively from either the event envelope or a flat body.
function pick(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_INBOUND_SIGNING_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Inbound not configured" }, { status: 503 });
  }
  const raw = await req.text();
  if (!verifySignature(secret, req.headers, raw)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }
  if (!isNamingConfigured()) {
    return NextResponse.json({ error: "Naming DB not configured" }, { status: 503 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const data = (payload.data && typeof payload.data === "object"
    ? (payload.data as Record<string, unknown>)
    : payload) as Record<string, unknown>;

  // The email.received payload is METADATA ONLY (no body) — the HTML lives
  // behind Resend's Retrieve Email API, keyed by email_id. Fetch it here.
  const emailId = pick(data, "email_id", "id");
  let subject = pick(data, "subject");
  const fromRaw = data.from;
  let sender =
    typeof fromRaw === "string"
      ? fromRaw
      : fromRaw && typeof fromRaw === "object"
        ? pick(fromRaw as Record<string, unknown>, "address", "email", "from")
        : null;

  if (!emailId) {
    return NextResponse.json({ ok: true, stored: false, reason: "no email_id" });
  }

  let html: string | null = null;
  let text: string | null = null;
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const r = await fetch(`https://api.resend.com/emails/${emailId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (r.ok) {
        const email = (await r.json()) as Record<string, unknown>;
        html = pick(email, "html", "body_html");
        text = pick(email, "text", "body_text");
        subject = pick(email, "subject") || subject;
        const ef = email.from;
        sender =
          (typeof ef === "string" ? ef : null) ||
          (ef && typeof ef === "object"
            ? pick(ef as Record<string, unknown>, "address", "email")
            : null) ||
          sender;
      } else {
        console.error(`namejet inbound: Resend retrieve ${emailId} → ${r.status}`);
      }
    } catch (e) {
      console.error("namejet inbound: Resend retrieve failed", e);
    }
  } else {
    console.error("namejet inbound: RESEND_API_KEY not set — storing metadata only");
  }

  // Store the row regardless (keeps email_id so the body can be refetched);
  // the source skips rows with no html.
  try {
    const { error } = await getNamingDb().from(INBOX_TABLE).insert({
      email_id: emailId,
      sender,
      subject,
      html,
      text,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, stored: true, body: !!(html || text) });
}
