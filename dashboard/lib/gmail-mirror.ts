// Gmail MIRROR read layer — a drop-in for lib/gmail.ts that serves reads from the LOCAL Postgres
// copy (gmail_messages) instead of the throttled Gmail API. Every function has the SAME signature as
// its lib/gmail.ts counterpart, so a consumer can switch `from "../gmail"` → `from "../gmail-mirror"`
// with no other change. Each fn serves locally when the mailbox is mirrored (gmail_sync_state
// backfill_done=true), and FALLS BACK to the governed live Gmail client otherwise (or when a specific
// message/thread isn't in the mirror yet) — so it's always correct, just cheaper when it can be.
//
// The Gmail search query is translated to SQL by a bounded parser that understands ONLY the operators
// our readers actually use: a quoted/bare phrase, from:, to:, subject:, after:, before:, newer_than:Nd,
// and in:/-in: label filters (applied in JS post-fetch). Anything it doesn't recognize is treated as a
// free-text term against search_text. Unsupported-but-harmless is the safe direction (broader match).

import { getDb, isDbConfigured } from "./supabase";
import * as live from "./gmail";
import type { GmailMessage } from "./gmail";

// Re-export the passthroughs so consumers can import everything from the mirror.
export { dealMailboxes, gmailConfigured, GMAIL_THREAD_SIZE_CAP } from "./gmail";
export type { GmailMessage } from "./gmail";

const TABLE = "gmail_messages";

// ── strictly-local (never touch Gmail) — DEFAULT ────────────────────────────
// Every module that reads through the mirror is Gmail-FREE: it serves only the local Postgres copy and,
// on a miss (un-mirrored mailbox, or a thread not yet in the snapshot), returns EMPTY rather than
// falling back to the live API — so a mirror-backed reader can NEVER add load to the shared per-user
// Gmail quota / throttle. This is the hard guarantee: zero live pulls from any mirror consumer. (The
// deal-emails cron, deal-detail ingest, and the Email compose tool import the LIVE client directly, not
// the mirror — they're intentionally live + budget-governed.) Escape hatch: GMAIL_MIRROR_ALLOW_LIVE=1
// restores the transparent live fallback (e.g. once the History delta-sync keeps the mirror current and
// you want misses to resolve live).
function localOnly(): boolean {
  return process.env.GMAIL_MIRROR_ALLOW_LIVE !== "1";
}
function emptyMsg(id: string): GmailMessage {
  return { id, threadId: id, mid: "", from: "", fromName: "", to: "", cc: "", subject: "", date: 0, snippet: "", body: "", bulk: false };
}

// ── mirrored-mailbox check (cached) ─────────────────────────────────────────
const mirroredCache = new Map<string, { at: number; ok: boolean }>();
const MIRRORED_TTL_MS = 60_000;

async function isMailboxMirrored(mailbox: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  const hit = mirroredCache.get(mailbox);
  if (hit && Date.now() - hit.at < MIRRORED_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const { data } = await getDb()
      .from("gmail_sync_state")
      .select("backfill_done")
      .eq("mailbox", mailbox)
      .maybeSingle();
    ok = Boolean(data?.backfill_done);
  } catch {
    ok = false;
  }
  mirroredCache.set(mailbox, { at: Date.now(), ok });
  return ok;
}

// ── row → GmailMessage ──────────────────────────────────────────────────────
type DbRow = {
  id: string;
  thread_id: string | null;
  mid: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  cc: string | null;
  subject: string | null;
  ts: string | null;
  snippet: string | null;
  body: string | null;
  labels: string[] | null;
  size_est: number | null;
  bulk: boolean | null;
};

const MSG_COLS =
  "id,thread_id,mid,from_addr,from_name,to_addr,cc,subject,ts,snippet,body,labels,size_est,bulk";

function toMessage(r: DbRow): GmailMessage {
  return {
    id: r.id,
    threadId: r.thread_id || r.id,
    mid: r.mid || r.id,
    from: r.from_addr || "",
    fromName: r.from_name || "",
    to: r.to_addr || "",
    cc: r.cc || "",
    subject: r.subject || "",
    date: r.ts ? Date.parse(r.ts) : 0,
    snippet: r.snippet || "",
    body: r.body || "",
    bulk: Boolean(r.bulk),
  };
}

// ── Gmail query → SQL parse ─────────────────────────────────────────────────
type Leaf = { field: "from" | "to" | "subject" | "text"; value: string };
type Parsed = {
  and: Leaf[];
  or: Leaf[] | null; // set when the query is a single top-level `A OR B` of leaf terms
  includeLabels: string[]; // in:X  (lowercased gmail tokens)
  excludeLabels: string[]; // -in:X
  after: number | null; // epoch ms (inclusive)
  before: number | null; // epoch ms (exclusive-ish; we use <=)
  newerThanDays: number | null;
};

// Tokenize respecting double quotes: `from:x subject:"a b" "c"` → ['from:x','subject:"a b"','"c"'].
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|\S*"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[0]);
  return out;
}
const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/"/g, "");

function leafFromToken(tok: string): Leaf | null {
  const lc = tok.toLowerCase();
  if (lc.startsWith("from:")) return { field: "from", value: unquote(tok.slice(5)) };
  if (lc.startsWith("to:")) return { field: "to", value: unquote(tok.slice(3)) };
  if (lc.startsWith("subject:")) return { field: "subject", value: unquote(tok.slice(8)) };
  const v = unquote(tok);
  return v ? { field: "text", value: v } : null;
}

function parseNewerThan(v: string): number | null {
  const m = v.match(/^(\d+)([dmy])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const days = unit === "d" ? n : unit === "m" ? n * 30 : n * 365;
  return days;
}
// Gmail date: YYYY/MM/DD (also tolerates YYYY-MM-DD).
function parseGmailDate(v: string): number | null {
  const ms = Date.parse(v.replace(/\//g, "-"));
  return Number.isFinite(ms) ? ms : null;
}

function parseQuery(q: string): Parsed {
  const parsed: Parsed = {
    and: [],
    or: null,
    includeLabels: [],
    excludeLabels: [],
    after: null,
    before: null,
    newerThanDays: null,
  };
  const trimmed = (q || "").trim();
  if (!trimmed) return parsed;

  // Top-level `A OR B` of two leaf terms (the only OR shape our readers use: `from:x OR to:x`).
  if (/\sOR\s/.test(trimmed) && !/"/.test(trimmed)) {
    const parts = trimmed.split(/\s+OR\s+/);
    const leaves = parts.map((p) => leafFromToken(p.trim())).filter((x): x is Leaf => Boolean(x));
    if (leaves.length === parts.length && leaves.length >= 2) {
      parsed.or = leaves;
      return parsed;
    }
  }

  for (const tok of tokenize(trimmed)) {
    const lc = tok.toLowerCase();
    if (lc === "or") continue; // stray OR in an AND context — ignore
    if (lc.startsWith("-in:")) { parsed.excludeLabels.push(lc.slice(4)); continue; }
    if (lc.startsWith("in:")) { parsed.includeLabels.push(lc.slice(3)); continue; }
    if (lc.startsWith("newer_than:")) { parsed.newerThanDays = parseNewerThan(lc.slice(11)); continue; }
    if (lc.startsWith("after:")) { parsed.after = parseGmailDate(tok.slice(6)); continue; }
    if (lc.startsWith("before:")) { parsed.before = parseGmailDate(tok.slice(7)); continue; }
    if (lc.startsWith("older_than:") || lc.startsWith("category:") || lc.startsWith("label:")) continue; // ignore (safe: broader)
    const leaf = leafFromToken(tok);
    if (leaf) parsed.and.push(leaf);
  }
  return parsed;
}

const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const colFor = (f: Leaf["field"]) =>
  f === "from" ? "from_addr" : f === "to" ? "to_addr" : f === "subject" ? "subject" : "search_text";

// Map a gmail `in:` token to a substring test on our (mixed-case) MBOX labels.
const LABEL_TOKEN: Record<string, string> = { chats: "chat", chat: "chat", sent: "sent", spam: "spam", trash: "trash", inbox: "inbox", unread: "unread", important: "important", starred: "starred" };
function labelMatches(labels: string[] | null | undefined, token: string): boolean {
  const needle = LABEL_TOKEN[token] || token;
  return (labels || []).some((l) => l.toLowerCase().includes(needle));
}
function passesLabels(row: { labels: string[] | null }, p: Parsed): boolean {
  for (const inc of p.includeLabels) if (!labelMatches(row.labels, inc)) return false;
  for (const exc of p.excludeLabels) if (labelMatches(row.labels, exc)) return false;
  return true;
}

// Build a Supabase select query for a mailbox from a parsed Gmail query. Label filters are NOT applied
// here (done in JS post-fetch) — so callers over-fetch when labels are present.
function buildQuery(mailbox: string, p: Parsed, cols: string, limit: number) {
  let qb = getDb().from(TABLE).select(cols).eq("mailbox", mailbox);
  if (p.newerThanDays != null) qb = qb.gte("ts", new Date(Date.now() - p.newerThanDays * 86_400_000).toISOString());
  if (p.after != null) qb = qb.gte("ts", new Date(p.after).toISOString());
  if (p.before != null) qb = qb.lte("ts", new Date(p.before).toISOString());
  if (p.or) {
    qb = qb.or(p.or.map((l) => `${colFor(l.field)}.ilike.%${escLike(l.value.toLowerCase())}%`).join(","));
  } else {
    for (const l of p.and) qb = qb.ilike(colFor(l.field), `%${escLike(l.value.toLowerCase())}%`);
  }
  return qb.order("ts", { ascending: false }).limit(limit);
}

const hasLabelFilter = (p: Parsed) => p.includeLabels.length > 0 || p.excludeLabels.length > 0;

// ── public API (gmail.ts-compatible) ────────────────────────────────────────

export async function searchMessages(subject: string, q: string, max = 200): Promise<{ id: string; threadId: string }[]> {
  if (!(await isMailboxMirrored(subject))) return localOnly() ? [] : live.searchMessages(subject, q, max);
  const p = parseQuery(q);
  const fetchN = hasLabelFilter(p) ? Math.min(max * 4, 2000) : max;
  const { data, error } = await buildQuery(subject, p, "id,thread_id,labels,ts", fetchN);
  if (error) return localOnly() ? [] : live.searchMessages(subject, q, max); // degrade to live on any mirror error
  const rows = (data as unknown as { id: string; thread_id: string | null; labels: string[] | null }[]) || [];
  const filtered = hasLabelFilter(p) ? rows.filter((r) => passesLabels(r, p)) : rows;
  return filtered.slice(0, max).map((r) => ({ id: r.id, threadId: r.thread_id || r.id }));
}

export async function searchThreadIds(subject: string, q: string, max = 100): Promise<string[]> {
  if (!(await isMailboxMirrored(subject))) return localOnly() ? [] : live.searchThreadIds(subject, q, max);
  const p = parseQuery(q);
  // Over-fetch messages then collapse to distinct threads (newest-first) up to max.
  const fetchN = Math.min(Math.max(max * 6, 300), 3000);
  const { data, error } = await buildQuery(subject, p, "thread_id,id,labels,ts", fetchN);
  if (error) return localOnly() ? [] : live.searchThreadIds(subject, q, max);
  const rows = (data as unknown as { thread_id: string | null; id: string; labels: string[] | null }[]) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (hasLabelFilter(p) && !passesLabels(r, p)) continue;
    const t = r.thread_id || r.id;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export async function getMessage(subject: string, id: string): Promise<GmailMessage> {
  if (await isMailboxMirrored(subject)) {
    const { data } = await getDb().from(TABLE).select(MSG_COLS).eq("mailbox", subject).eq("id", id).maybeSingle();
    if (data) return toMessage(data as DbRow);
    // Not in the mirror (e.g. brand-new message not yet synced) — empty (local-only) or live.
  }
  return localOnly() ? emptyMsg(id) : live.getMessage(subject, id);
}

async function threadRows(subject: string, threadId: string): Promise<DbRow[] | null> {
  const { data, error } = await getDb()
    .from(TABLE)
    .select(MSG_COLS)
    .eq("mailbox", subject)
    .eq("thread_id", threadId)
    .order("ts", { ascending: true });
  if (error) return null;
  return (data as DbRow[]) || [];
}

export async function getThread(subject: string, threadId: string): Promise<GmailMessage[]> {
  if (await isMailboxMirrored(subject)) {
    const rows = await threadRows(subject, threadId);
    if (rows && rows.length) return rows.map(toMessage);
    // Empty locally — the thread may be live-only; empty (local-only) or fall back.
  }
  return localOnly() ? [] : live.getThread(subject, threadId);
}

export async function getThreadMeta(
  subject: string,
  threadId: string,
): Promise<{ count: number; sizeEstimate: number; newestMid: string | null }> {
  if (await isMailboxMirrored(subject)) {
    const { data, error } = await getDb()
      .from(TABLE)
      .select("mid,ts,size_est")
      .eq("mailbox", subject)
      .eq("thread_id", threadId)
      .order("ts", { ascending: true });
    const rows = (data as { mid: string | null; ts: string | null; size_est: number | null }[]) || [];
    if (!error && rows.length) {
      let size = 0;
      let newestMid: string | null = null;
      let newestMs = -1;
      for (const r of rows) {
        size += Number(r.size_est) || 0;
        const ms = r.ts ? Date.parse(r.ts) : 0;
        if (ms >= newestMs) { newestMs = ms; if (r.mid) newestMid = r.mid; }
      }
      return { count: rows.length, sizeEstimate: size, newestMid };
    }
  }
  return localOnly() ? { count: 0, sizeEstimate: 0, newestMid: null } : live.getThreadMeta(subject, threadId);
}

export async function getThreadCapped(
  subject: string,
  threadId: string,
  maxBytes = live.GMAIL_THREAD_SIZE_CAP,
): Promise<GmailMessage[]> {
  if (await isMailboxMirrored(subject)) {
    const rows = await threadRows(subject, threadId);
    if (rows && rows.length) {
      const size = rows.reduce((s, r) => s + (Number(r.size_est) || 0), 0);
      if (size > maxBytes) return [];
      return rows.map(toMessage);
    }
  }
  return localOnly() ? [] : live.getThreadCapped(subject, threadId, maxBytes);
}

export async function getProfile(subject: string): ReturnType<typeof live.getProfile> {
  // Local-only: never touch Gmail (a stub keeps mirror consumers Gmail-free); else live (cheap).
  return localOnly() ? { emailAddress: subject, messagesTotal: 0, threadsTotal: 0 } : live.getProfile(subject);
}
