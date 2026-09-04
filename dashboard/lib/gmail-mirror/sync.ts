// Gmail-mirror History delta-sync — keeps the local gmail_messages copy CURRENT after the one-time
// Takeout seed, using cheap incremental Gmail History-API pulls. This is the ONLY path that touches
// Gmail on behalf of the mirror; it runs once/day off-peak (see the cron) and is budget-governed
// under the "mirror-sync" feature. Everything else reads the mirror strictly-local (zero Gmail).
//
// How it stays consistent with the Takeout rows:
//  • a mbox row's PK id = the RFC Message-ID (parseRawMessage: id = mid). We fetch each new message
//    with format=raw and run the SAME parser, so a delta row gets the SAME id → dedupe/upsert lines up.
//  • a mbox row's thread_id = X-GM-THRID (decimal). The API gives threadId in HEX, so we convert
//    hex→decimal (X-GM-THRID === decimal(threadId)) — otherwise a thread spanning seed+delta would split.
//
// Cursor: gmail_sync_state.last_history_id. First run (or an expired historyId → 404) falls back to a
// date-bounded messages.list catch-up from the newest mirrored ts, then sets the baseline historyId.

import { getDb, isDbConfigured } from "../supabase";
import { gapiGet } from "../gmail";
import { withGmailFeature, isGmailBudgetError } from "../gmail-budget";
import { parseRawMessage } from "./mbox";
import { rowFromMessage, type Row } from "./ingest";

const MAX_PER_MAILBOX = Number(process.env.GMAIL_SYNC_MAX_PER_MAILBOX) || 1500;
const OVERLAP_DAYS = 2; // re-scan a couple days before the newest mirrored ts, to be safe on the boundary
const FETCH_CONCURRENCY = 4;

export type MailboxSyncResult = { mailbox: string; added: number; note: string };

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// X-GM-THRID is the DECIMAL form of the API's hex threadId — convert so delta rows share thread_id
// with the Takeout rows (which store the decimal X-GM-THRID).
function decimalThreadId(hex?: string): string {
  if (!hex) return "";
  try {
    return BigInt(`0x${hex}`).toString();
  } catch {
    return hex;
  }
}

async function newestMirroredDate(mailbox: string): Promise<Date | null> {
  const { data } = await getDb()
    .from("gmail_messages")
    .select("ts")
    .eq("mailbox", mailbox)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ts = (data as { ts: string | null } | null)?.ts;
  return ts ? new Date(ts) : null;
}

// Fetch one message (format=raw) and build a Row consistent with the Takeout rows.
async function fetchRow(mailbox: string, apiId: string): Promise<Row | null> {
  const msg = await gapiGet(mailbox, `messages/${encodeURIComponent(apiId)}?format=raw`);
  if (!msg?.raw) return null;
  const raw = Buffer.from(String(msg.raw), "base64url").toString("utf8");
  const m = parseRawMessage(raw);
  // Override with the authoritative API fields the raw RFC822 doesn't carry.
  m.threadId = decimalThreadId(msg.threadId ? String(msg.threadId) : "") || m.threadId;
  if (Array.isArray(msg.labelIds)) m.labels = msg.labelIds.map((l: unknown) => String(l));
  if (msg.sizeEstimate != null) m.sizeEstimate = Number(msg.sizeEstimate) || m.sizeEstimate;
  if (msg.snippet) m.snippet = String(msg.snippet);
  if (msg.internalDate) m.date = Number(msg.internalDate) || m.date;
  return rowFromMessage(mailbox, m);
}

async function upsertRows(rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  // De-dupe by (mailbox,id) within the batch (same-message-twice → ON CONFLICT can't hit a row twice).
  const byKey = new Map<string, Row>();
  for (const r of rows) byKey.set(`${r.mailbox} ${r.id}`, r);
  const unique = [...byKey.values()];
  const { error } = await getDb().from("gmail_messages").upsert(unique, { onConflict: "mailbox,id" });
  if (error) throw new Error(`gmail_messages upsert: ${error.message}`);
  return unique.length;
}

// Incremental: collect messageAdded ids since startHistoryId. Returns tooOld=true on a 404 (the
// historyId has expired — Gmail keeps history for only ~1 week), signalling a date catch-up instead.
async function historyAddedIds(
  mailbox: string,
  startHistoryId: string,
): Promise<{ ids: string[]; latestHistoryId: string | null; tooOld: boolean }> {
  const ids = new Set<string>();
  let pageToken = "";
  let latestHistoryId: string | null = null;
  for (let page = 0; page < 50 && ids.size < MAX_PER_MAILBOX; page++) {
    let path = `history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&maxResults=500`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    let res: any;
    try {
      res = await gapiGet(mailbox, path);
    } catch (e) {
      if (/:\s*404\b/.test(String((e as Error)?.message || ""))) return { ids: [], latestHistoryId: null, tooOld: true };
      throw e;
    }
    for (const h of res.history || []) {
      for (const a of h.messagesAdded || []) if (a?.message?.id) ids.add(String(a.message.id));
    }
    if (res.historyId) latestHistoryId = String(res.historyId);
    pageToken = res.nextPageToken || "";
    if (!pageToken) break;
  }
  return { ids: [...ids].slice(0, MAX_PER_MAILBOX), latestHistoryId, tooOld: false };
}

// Date-bounded catch-up (first sync, or history expired): messages.list?q=after:<date>.
async function catchUpIds(mailbox: string, since: Date): Promise<string[]> {
  const d = new Date(since.getTime() - OVERLAP_DAYS * 86_400_000);
  const q = `after:${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const ids = new Set<string>();
  let pageToken = "";
  for (let page = 0; page < 20 && ids.size < MAX_PER_MAILBOX; page++) {
    let path = `messages?q=${encodeURIComponent(q)}&maxResults=500`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await gapiGet(mailbox, path);
    for (const m of res.messages || []) if (m?.id) ids.add(String(m.id));
    pageToken = res.nextPageToken || "";
    if (!pageToken) break;
  }
  return [...ids].slice(0, MAX_PER_MAILBOX);
}

export async function syncMailbox(mailbox: string): Promise<MailboxSyncResult> {
  const { data: state } = await getDb()
    .from("gmail_sync_state")
    .select("last_history_id,backfill_done")
    .eq("mailbox", mailbox)
    .maybeSingle();
  if (!(state as { backfill_done?: boolean } | null)?.backfill_done) {
    return { mailbox, added: 0, note: "not mirrored (no Takeout seed) — skipped" };
  }
  const lastHistoryId = (state as { last_history_id?: string | null }).last_history_id || null;

  // Capture the CURRENT historyId up front so anything added during this run is caught next time.
  const profile = await gapiGet(mailbox, "profile");
  const nowHistoryId = profile?.historyId ? String(profile.historyId) : null;

  let ids: string[] = [];
  let note = "";
  let cursorForNext: string | null = nowHistoryId || lastHistoryId;

  if (lastHistoryId) {
    const h = await historyAddedIds(mailbox, lastHistoryId);
    if (h.tooOld) {
      const newest = await newestMirroredDate(mailbox);
      ids = newest ? await catchUpIds(mailbox, newest) : [];
      note = `historyId expired → date catch-up (${ids.length})`;
    } else {
      ids = h.ids;
      cursorForNext = h.latestHistoryId || nowHistoryId || lastHistoryId;
      note = `history delta (${ids.length})`;
    }
  } else {
    const newest = await newestMirroredDate(mailbox);
    ids = newest ? await catchUpIds(mailbox, newest) : [];
    note = `first delta — date catch-up (${ids.length})`;
  }

  let added = 0;
  for (const batch of chunk(ids, FETCH_CONCURRENCY)) {
    const rows = (await Promise.all(batch.map((id) => fetchRow(mailbox, id).catch(() => null)))).filter(
      (r): r is Row => !!r,
    );
    added += await upsertRows(rows);
  }

  // Advance the cursor (best-effort; a failed advance just re-scans next run).
  await getDb()
    .from("gmail_sync_state")
    .update({ last_history_id: cursorForNext, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox);

  return { mailbox, added, note };
}

// Sync every mirrored mailbox. Each runs under the governed "mirror-sync" feature so it respects the
// per-mailbox budget + global breaker; a budget stop just skips that box (retries next run).
export async function syncAllMailboxes(): Promise<MailboxSyncResult[]> {
  if (!isDbConfigured()) return [];
  const { data } = await getDb().from("gmail_sync_state").select("mailbox").eq("backfill_done", true);
  const boxes = ((data as { mailbox: string }[] | null) || []).map((r) => r.mailbox);
  const out: MailboxSyncResult[] = [];
  for (const mb of boxes) {
    try {
      out.push(await withGmailFeature("mirror-sync", () => syncMailbox(mb)));
    } catch (e) {
      const budget = isGmailBudgetError(e);
      out.push({ mailbox: mb, added: 0, note: budget ? "budget stop — retries next run" : `error: ${String((e as Error)?.message || e)}` });
    }
  }
  return out;
}
