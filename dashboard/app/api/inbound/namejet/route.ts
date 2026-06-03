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
import { dispatchWorkflow } from "@/lib/orchestrator";

// Run the source the moment an email is stashed (event-driven, not on a cron).
const SOURCE_WORKFLOW = "source-namejet-email-digest.yml";

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

// Recursively collect every string leaf — so we can find the body no matter how
// Resend names/nests it in the Retrieve response.
function collectStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, acc);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, acc);
  return acc;
}
const looksHtml = (s: string) => /<\s*(table|tr|td|html|body|a\b|div)/i.test(s);

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
  const diag: Record<string, unknown> = {};
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    diag.retrieve = "no_api_key";
  } else {
    try {
      // Received/inbound emails use the Receiving API, NOT /emails/{id} (that's
      // sent-only and 404s for inbound). Returns html / text / subject / from.
      const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const bodyText = await r.text();
      let email: Record<string, unknown> = {};
      try { email = JSON.parse(bodyText) as Record<string, unknown>; } catch { /* non-JSON */ }
      diag.retrieve_status = r.status;
      diag.keys = Object.keys(email).slice(0, 40);
      if (r.ok) {
        const strings = collectStrings(email);
        html = strings.filter(looksHtml).sort((a, b) => b.length - a.length)[0] || null;
        text = strings.filter((s) => !looksHtml(s) && s.length > 40).sort((a, b) => b.length - a.length)[0] || null;
        subject = pick(email, "subject") || subject;
        const ef = email.from;
        sender =
          (typeof ef === "string" ? ef : null) ||
          (ef && typeof ef === "object" ? pick(ef as Record<string, unknown>, "address", "email") : null) ||
          sender;
      } else {
        diag.body_snippet = bodyText.slice(0, 300);
      }
    } catch (e) {
      diag.retrieve_error = e instanceof Error ? e.message : String(e);
    }
  }

  // Store the row regardless (keeps email_id so the body can be refetched). When
  // we couldn't get the body, stash the Retrieve diagnostic in `text` so it's
  // inspectable; the source skips rows with no html.
  const textToStore = html ? text : (text || `RETRIEVE_DEBUG ${JSON.stringify(diag)}`);
  try {
    const { error } = await getNamingDb().from(INBOX_TABLE).insert({
      email_id: emailId,
      sender,
      subject,
      html,
      text: textToStore,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
  // Event-driven ingest: the instant we've stored a real email body, kick the
  // source so it parses + filters + publishes right away (no waiting for the
  // morning auctions batch). Best-effort — the daily run is the safety net.
  let dispatched = false;
  if (html) {
    try {
      const d = await dispatchWorkflow(SOURCE_WORKFLOW);
      dispatched = d.ok;
      if (!d.ok) console.error("namejet inbound: dispatch failed —", d.error || d.status);
    } catch (e) {
      console.error("namejet inbound: dispatch error", e);
    }
  }

  return NextResponse.json({ ok: true, stored: true, body: !!html, dispatched, ...diag });
}
