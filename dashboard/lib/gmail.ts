// Read-only Gmail client (server-only). Reads the deal mailboxes via the
// `marketplace-pipeline` service account using DOMAIN-WIDE DELEGATION — the SA's
// client ID is authorized for gmail.readonly in Workspace Admin and impersonates
// a specific user per request (see lib/google-auth.ts `subject`). Used by the
// Marketplace activity report to reconstruct per-domain buyer inquiry / outreach
// threads. NEVER writes — gmail.readonly only.

import { googleAccessToken } from "./google-auth";
import { assertReadBudget, chargeRead } from "./gmail-budget";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Mailboxes scanned for deal activity. The team has SEPARATE @snagged.com AND
// @snagged.co Workspaces — direct buyer negotiations often land in the .co boxes
// (e.g. Luxe.com's six-figure offers went to brian@snagged.co), so we read all
// four and dedupe by RFC Message-ID. Override via env (comma-separated).
export function dealMailboxes(): string[] {
  return (process.env.GMAIL_DEAL_MAILBOXES || "rob@snagged.com,brian@snagged.com,rob@snagged.co,brian@snagged.co")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64);
}

export type GmailMessage = {
  id: string;
  threadId: string;
  mid: string; // RFC Message-ID — stable across mailboxes, used to dedupe
  from: string; // bare lowercased address
  fromName: string;
  to: string; // raw To header (may hold several recipients)
  cc: string; // raw Cc header
  subject: string;
  date: number; // epoch ms
  snippet: string;
  body: string; // text/plain (html-stripped fallback), capped
  bulk: boolean; // looks like a mass/marketing send (HubSpot etc.), not a 1:1 email
};

// Gmail enforces a PER-USER quota (a rolling per-second limit AND a per-user daily
// allocation shared across every app on that mailbox — including the user's own
// Superhuman/Gmail client). To avoid starving that shared budget we (a) back off and
// retry on 429 / 5xx instead of hammering, honoring Retry-After, and (b) callers
// keep total volume down (see the deal-emails cron's activity gating). Read-only.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Rough byte size of a parsed Gmail response, for the read governor's byte-budget. Prefer the
// message payload's own sizeEstimate(s) (present on messages/threads) over stringifying the JSON.
function approxBytes(json: any): number {
  try {
    if (Array.isArray(json?.messages) && json.messages.some((m: any) => m?.sizeEstimate != null)) {
      return json.messages.reduce((s: number, m: any) => s + (Number(m?.sizeEstimate) || 0), 0);
    }
    if (json?.sizeEstimate != null) return Number(json.sizeEstimate) || 0;
    return JSON.stringify(json).length;
  } catch { return 0; }
}
async function gget(subject: string, path: string): Promise<any> {
  // Governor: a BACKGROUND read on a mailbox over its daily budget is refused here (hard-stop,
  // fail-open) so the sum of our features can never eat the per-user quota Superhuman shares.
  await assertReadBudget(subject);
  const token = await googleAccessToken(SCOPE, subject);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const json = await res.json();
      // Charge the ledger by approximate bytes returned (thread reads = the byte-heavy ones).
      const bytes = Number(res.headers.get("content-length")) || approxBytes(json);
      void chargeRead(subject, bytes);
      return json;
    }
    const bodyText = (await res.text()).slice(0, 200);
    // 429 (rate/quota) and 5xx are transient — back off and retry a few times.
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt);
      lastErr = new Error(`gmail ${path.split("?")[0]}: ${res.status} ${bodyText}`);
      await sleep(wait);
      continue;
    }
    throw new Error(`gmail ${path.split("?")[0]}: ${res.status} ${bodyText}`);
  }
  throw lastErr || new Error(`gmail ${path.split("?")[0]}: retries exhausted`);
}

// Confirm a mailbox is reachable (delegation + Gmail API check).
export async function getProfile(subject: string): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
  return gget(subject, "profile");
}

// Distinct thread IDs matching a Gmail search query, in one mailbox.
export async function searchThreadIds(subject: string, q: string, max = 100): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken = "";
  while (ids.size < max) {
    const qs = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.size)) });
    if (pageToken) qs.set("pageToken", pageToken);
    const r = await gget(subject, `messages?${qs.toString()}`);
    for (const m of r.messages || []) ids.add(m.threadId);
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return [...ids];
}

// Message stubs ({id, threadId}) matching a Gmail search query, one mailbox.
// Like searchThreadIds but keeps the message id so a single message can be fetched
// directly (no thread expansion) — used by the Leads feed (one email per lead).
export async function searchMessages(subject: string, q: string, max = 200): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken = "";
  while (out.length < max) {
    const qs = new URLSearchParams({ q, maxResults: String(Math.min(100, max - out.length)) });
    if (pageToken) qs.set("pageToken", pageToken);
    const r = await gget(subject, `messages?${qs.toString()}`);
    for (const m of r.messages || []) out.push({ id: m.id, threadId: m.threadId });
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

// One full message (parsed) by id, one mailbox.
export async function getMessage(subject: string, id: string): Promise<GmailMessage> {
  return parseMessage(await gget(subject, `messages/${id}?format=full`));
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function unescapeHtml(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENT[m] || m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function decodeB64(data?: string): string {
  if (!data) return "";
  try { return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}
function plainBody(payload: any): string {
  let out = "";
  if ((payload?.mimeType || "").startsWith("text/plain") && payload?.body?.data) out += decodeB64(payload.body.data);
  for (const p of payload?.parts || []) out += plainBody(p);
  return out;
}
function htmlBody(payload: any): string {
  let out = "";
  if (payload?.mimeType === "text/html" && payload?.body?.data) out += decodeB64(payload.body.data);
  for (const p of payload?.parts || []) out += htmlBody(p);
  return out;
}
const bareAddr = (s: string): string => (s.match(/[\w.\-+]+@[\w.\-]+/)?.[0] || "").toLowerCase();

// Heuristic mass/marketing-send detector (HubSpot, Mailchimp, generic ESP).
// FALLBACK ONLY: pitch type is now classified authoritatively from the HubSpot
// CRM email log (lib/hubspot.ts — a send carrying an hs_sequence_id is mass). This
// header heuristic is the backstop for our sends that aren't in HubSpot's log: a
// HubSpot sequence/blast carries an unsubscribe header, a bulk Precedence, an ESP
// X-mailer/return-path, or HubSpot tracking infra in the body; a 1:1 has none.
const ESP_HEADER_KEY = /^(list-unsubscribe|x-hubspot|x-hs-|x-mailer|x-campaign|x-mailgun|x-sg-|x-ses-)/;
function looksBulk(hd: Record<string, string>, body: string): boolean {
  const keys = Object.keys(hd);
  if (hd["list-unsubscribe"] || hd["list-id"]) return true;
  if (/\bbulk\b/i.test(hd["precedence"] || "")) return true;
  if (/hubspot|mailchimp|sendgrid|mailgun|amazonses|marketo/i.test(`${hd["x-mailer"] || ""} ${hd["return-path"] || ""} ${hd["x-csa-complaints"] || ""}`)) return true;
  if (keys.some((k) => ESP_HEADER_KEY.test(k) && /hubspot|hs-/i.test(k))) return true;
  // HubSpot tracking infra in the rendered body (unsubscribe pixel / link domains).
  if (/hubspotlinks\.com|hs-sites\.com|hubspotemail\.net|track\.hubspot|\/hs\/manage-preferences|email\.hubspot/i.test(body)) return true;
  return false;
}
function parseMessage(m: any): GmailMessage {
  const hd: Record<string, string> = {};
  for (const h of m.payload?.headers || []) hd[h.name.toLowerCase()] = h.value;
  let body = plainBody(m.payload || {});
  if (!body) body = htmlBody(m.payload || {}).replace(/<[^>]+>/g, " ");
  const bulk = looksBulk(hd, body);
  return {
    id: m.id,
    threadId: m.threadId,
    mid: hd["message-id"] || m.id,
    from: bareAddr(hd["from"] || ""),
    fromName: (hd["from"] || "").replace(/\s*<.*/, "").trim().replace(/^"|"$/g, ""),
    to: hd["to"] || "",
    cc: hd["cc"] || "",
    subject: hd["subject"] || "",
    date: Number(m.internalDate || 0),
    snippet: unescapeHtml(m.snippet || ""),
    body: unescapeHtml(body).slice(0, 8000),
    bulk,
  };
}

// All messages in a thread (full bodies), one mailbox.
export async function getThread(subject: string, threadId: string): Promise<GmailMessage[]> {
  const t = await gget(subject, `threads/${threadId}?format=full`);
  return (t.messages || []).map(parseMessage);
}

// Default cap for a single full-thread download (bodies + attachments). A handful of giant
// negotiation threads (some >100 MB) re-downloaded repeatedly is what blows the shared per-user
// Gmail data quota (Superhuman hit the same wall). Env DEAL_EMAIL_THREAD_MAX_BYTES tunes it.
export const GMAIL_THREAD_SIZE_CAP = Number(process.env.DEAL_EMAIL_THREAD_MAX_BYTES) || 10 * 1024 * 1024;

// getThread, but SKIP the heavy download when the thread exceeds `maxBytes` — a cheap metadata
// pre-check decides. An oversized thread returns [] (the caller treats it as "no messages", which
// for a deal report / chat attach just omits that one giant chain — low-priority content, never
// worth throttling the mailbox for). If the metadata check itself fails we fall through to a normal
// fetch so behavior degrades safely. Use this for any full-chain read that isn't latency-critical.
export async function getThreadCapped(
  subject: string,
  threadId: string,
  maxBytes = GMAIL_THREAD_SIZE_CAP,
): Promise<GmailMessage[]> {
  try {
    const meta = await getThreadMeta(subject, threadId);
    if (meta.sizeEstimate > maxBytes) return [];
  } catch {
    /* metadata unavailable — fall through and fetch normally */
  }
  return getThread(subject, threadId);
}

// Cheap thread metadata (headers + per-message sizeEstimate only — NO bodies/attachments), so a
// caller can decide whether to skip the heavy full download. Even a 145 MB thread returns only
// ~KB here. Used to avoid re-downloading giant / unchanged threads, which was blowing the shared
// per-user Gmail data quota. Returns the message count, the summed size estimate, and the newest
// message's RFC Message-ID.
export async function getThreadMeta(
  subject: string,
  threadId: string,
): Promise<{ count: number; sizeEstimate: number; newestMid: string | null }> {
  const t = await gget(subject, `threads/${threadId}?format=metadata&metadataHeaders=Message-ID`);
  const msgs: any[] = t.messages || [];
  let size = 0;
  let newestMid: string | null = null;
  let newestMs = -1;
  for (const m of msgs) {
    size += Number(m.sizeEstimate) || 0;
    const internal = Number(m.internalDate) || 0;
    if (internal >= newestMs) {
      newestMs = internal;
      const headers: any[] = m.payload?.headers || [];
      const mid = headers.find((h) => (h.name || "").toLowerCase() === "message-id")?.value;
      if (mid) newestMid = mid;
    }
  }
  return { count: msgs.length, sizeEstimate: size, newestMid };
}
