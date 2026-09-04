// Streaming MBOX → Postgres ingester for the Gmail mirror. Google Takeout exports each mailbox as
// one big mboxrd file (often many GB). We stream it line-by-line (never load it whole), accumulate
// each message between `From ` separator lines, parse it with the pure MBOX/MIME parser, and upsert in
// batches into gmail_messages. Idempotent (PK (mailbox,id), so re-running an import is safe). Quota-FREE
// — reads a local file OR pulls the archive straight from Google Drive via the service account (a
// Takeout export dropped in the "Snagged Pipeline" shared drive / shared to the SA), never the Gmail API.
//
// Usage:
//   await ingestMbox({ mailbox: "rob@snagged.com", filePath: "/path/to/rob.mbox" });
//   await ingestMboxFromDrive({ mailbox: "rob@snagged.com", fileId: "<drive-file-id>" });

import { createReadStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { Readable } from "node:stream";
import { getDb } from "../supabase";
import { googleAccessToken } from "../google-auth";
import { parseRawMessage, type MirrorMessage } from "./mbox";
import { listZipEntries, openZipEntryStream, pickMboxEntry, type RangeReader, type RangeStreamer } from "./zip-remote";

type CoreOpts = {
  mailbox: string;
  batchSize?: number;     // rows per upsert (default 500)
  onProgress?: (count: number) => void;
  progressEvery?: number; // fire onProgress every N messages (default 5000)
  backfillSource?: string; // stamped on gmail_sync_state (default 'takeout-mbox')
};
type FileOpts = CoreOpts & { filePath: string };
type DriveOpts = CoreOpts & { fileId: string };

export type Row = {
  mailbox: string;
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
  labels: string[];
  size_est: number;
  bulk: boolean;
  search_text: string;
};

const SEARCH_BODY_CAP = 8_000; // only the first 8KB of body feeds the trgm search column
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Postgres `text` columns CANNOT store a NUL byte (0x00) — a single one anywhere in a message field
// aborts the whole INSERT batch with `invalid byte sequence for encoding "UTF8": 0x00`. Message
// bodies (esp. mis-decoded base64 / binary-ish parts) occasionally carry a NUL, other bare C0 control
// chars, or a lone UTF-16 surrogate the JSON/pg layer rejects. Strip them from every text field before
// insert (keep \t \n \r). Same class of scrub as Social Sweep's `clean()`.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g;
function clean(s: string | null): string | null {
  return s == null ? null : s.replace(BAD_CHARS, "");
}

function toRow(mailbox: string, raw: string): Row | null {
  return rowFromMessage(mailbox, parseRawMessage(raw));
}

// Map a parsed MirrorMessage → a gmail_messages Row. Shared by the mbox ingest (via toRow) and the
// History delta-sync (which builds a MirrorMessage from the Gmail API + raw, then calls this) so both
// paths produce byte-identical rows (same id/thread/search-text/clean scheme).
export function rowFromMessage(mailbox: string, m: MirrorMessage): Row | null {
  if (!m.id) return null;
  const searchText = [m.subject, m.from, m.fromName, m.to, m.cc, m.body.slice(0, SEARCH_BODY_CAP)]
    .filter(Boolean).join(" \n ").toLowerCase();
  return {
    mailbox,
    id: m.id,
    thread_id: m.threadId || null,
    mid: m.mid || null,
    from_addr: clean(m.from || null),
    from_name: clean(m.fromName || null),
    to_addr: clean(m.to || null),
    cc: clean(m.cc || null),
    subject: clean(m.subject || null),
    ts: m.date ? new Date(m.date).toISOString() : null,
    snippet: clean(m.snippet || null),
    body: clean(m.body || null),
    labels: m.labels.map((l) => clean(l) || "").filter(Boolean),
    size_est: m.sizeEstimate,
    bulk: m.bulk,
    search_text: clean(searchText) || "",
  };
}

// Un-escape mboxrd body lines: `>From ` → `From `, `>>From ` → `>From `, etc.
function unescapeMboxrd(block: string): string {
  return block.replace(/^(>+)From /gm, (_m, gt: string) => ">".repeat(gt.length - 1) + "From ");
}

const ROW_COLS = [
  "mailbox", "id", "thread_id", "mid", "from_addr", "from_name", "to_addr", "cc",
  "subject", "ts", "snippet", "body", "labels", "size_est", "bulk", "search_text",
] as const;
const rowValues = (r: Row): unknown[] => [
  r.mailbox, r.id, r.thread_id, r.mid, r.from_addr, r.from_name, r.to_addr, r.cc,
  r.subject, r.ts, r.snippet, r.body, r.labels, r.size_est, r.bulk, r.search_text,
];

type SyncState = { mailbox: string; backfill_done: boolean; backfill_source: string; message_count: number; updated_at: string };
type Writer = { upsertMessages: (rows: Row[]) => Promise<void>; setSyncState: (s: SyncState) => Promise<void>; close: () => Promise<void> };

// Pick the write path. When SUPABASE_DB_URL is set, write via a DIRECT Postgres connection (node-pg) —
// this bypasses PostgREST + its schema cache entirely (the schema-cache "could not find the table"
// failures on the REST write path are what blocked the seed). Otherwise use supabase-js (REST), with
// the schema-cache retry as a stopgap.
async function makeWriter(): Promise<Writer> {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    const pg = (await import("pg")).default as typeof import("pg");
    const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 4 });
    const cols = ROW_COLS.join(", ");
    const updates = ROW_COLS.filter((c) => c !== "mailbox" && c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
    return {
      async upsertMessages(rows) {
        const params: unknown[] = [];
        const tuples = rows.map((r) => `(${rowValues(r).map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
        await pool.query(`insert into gmail_messages (${cols}) values ${tuples.join(",")} on conflict (mailbox, id) do update set ${updates}`, params);
      },
      async setSyncState(s) {
        await pool.query(
          `insert into gmail_sync_state (mailbox, backfill_done, backfill_source, message_count, updated_at)
           values ($1,$2,$3,$4,$5)
           on conflict (mailbox) do update set backfill_done = excluded.backfill_done, backfill_source = excluded.backfill_source, message_count = excluded.message_count, updated_at = excluded.updated_at`,
          [s.mailbox, s.backfill_done, s.backfill_source, s.message_count, s.updated_at],
        );
      },
      async close() { await pool.end(); },
    };
  }
  // supabase-js (REST) fallback — with the PostgREST schema-cache retry.
  const db = getDb();
  return {
    async upsertMessages(rows) {
      let error: { message: string } | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        ({ error } = await db.from("gmail_messages").upsert(rows, { onConflict: "mailbox,id" }));
        if (!error) return;
        if (!/schema cache|pgrst205|could not find the table/i.test(error.message)) break;
        if (attempt === 0 || attempt % 5 === 0) console.log(`  [schema-cache] PostgREST not ready yet, retrying (attempt ${attempt + 1})…`);
        await new Promise((r) => setTimeout(r, 6000));
      }
      throw new Error(`gmail_messages upsert failed: ${error?.message}`);
    },
    async setSyncState(s) { await db.from("gmail_sync_state").upsert(s, { onConflict: "mailbox" }); },
    async close() { /* supabase-js has no pool to close */ },
  };
}

// The shared core: consume a readline stream of mbox lines and upsert every message.
async function runIngest(rl: Interface, opts: CoreOpts): Promise<{ mailbox: string; imported: number }> {
  const { mailbox } = opts;
  const batchSize = opts.batchSize ?? 500;
  const progressEvery = opts.progressEvery ?? 5000;
  const writer = await makeWriter();

  let current: string[] = [];  // lines of the message currently being accumulated (excludes the `From ` separator)
  let started = false;
  let batch: Row[] = [];
  let imported = 0;

  async function flush(): Promise<void> {
    if (!batch.length) return;
    // De-dupe by (mailbox,id) within the batch, keeping the LAST occurrence. A Gmail message that
    // appears more than once in the Takeout mbox (e.g. filed under two labels) would otherwise put
    // the same conflict key twice in one multi-row upsert → Postgres "ON CONFLICT DO UPDATE command
    // cannot affect row a second time". Cross-batch dupes are fine (separate statements).
    const bykey = new Map<string, Row>();
    for (const r of batch) bykey.set(`${r.mailbox} ${r.id}`, r);
    const rows = [...bykey.values()];
    batch = [];
    await writer.upsertMessages(rows);
    imported += rows.length;
    if (opts.onProgress && imported % progressEvery < rows.length) opts.onProgress(imported);
  }

  async function finishMessage(): Promise<void> {
    if (!current.length) return;
    const raw = unescapeMboxrd(current.join("\n"));
    current = [];
    if (!raw.trim()) return;
    const row = toRow(mailbox, raw);
    if (row) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    }
  }

  try {
    for await (const line of rl) {
      if (line.startsWith("From ")) { // an mbox message begins with "From " at column 0
        if (started) await finishMessage();
        started = true;
        continue; // drop the separator line itself
      }
      if (started) current.push(line);
    }
    await finishMessage();
    await flush();

    await writer.setSyncState({
      mailbox,
      backfill_done: true,
      backfill_source: opts.backfillSource || "takeout-mbox",
      message_count: imported,
      updated_at: new Date().toISOString(),
    });
  } finally {
    await writer.close().catch(() => { /* best-effort pool close */ });
  }

  return { mailbox, imported };
}

// Ingest from a LOCAL mbox file.
export async function ingestMbox(opts: FileOpts): Promise<{ mailbox: string; imported: number }> {
  const rl = createInterface({ input: createReadStream(opts.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  return runIngest(rl, opts);
}

// Ingest by STREAMING a Takeout export straight from Google Drive (by file id) via the service
// account — no giant local temp file, bounded memory. The file must be readable by the SA: drop it
// in the "Snagged Pipeline" shared drive, or share it to the SA's email. Accepts EITHER a raw
// `.mbox` OR a Takeout `.zip` (Google exports Mail as a .zip) — a zip is detected and the .mbox
// entry is streamed straight out of it via HTTP Range requests (never unzipped to disk).
export async function ingestMboxFromDrive(opts: DriveOpts): Promise<{ mailbox: string; imported: number }> {
  const token = await googleAccessToken(DRIVE_SCOPE);
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(opts.fileId)}`;
  const authHdr = { Authorization: `Bearer ${token}` };

  // Metadata → decide zip vs raw mbox (by mimeType/name).
  const metaRes = await fetch(`${base}?fields=name,size,mimeType&supportsAllDrives=true`, { headers: authHdr });
  if (!metaRes.ok) {
    const detail = (await metaRes.text().catch(() => "")).slice(0, 300);
    throw new Error(`Drive metadata failed (${metaRes.status}) for file ${opts.fileId}: ${detail}`);
  }
  const meta = (await metaRes.json()) as { name?: string; size?: string; mimeType?: string };
  const isZip = /\.zip$/i.test(meta.name || "") || meta.mimeType === "application/zip";

  const mediaUrl = `${base}?alt=media&supportsAllDrives=true`;
  const rl = isZip
    ? await mboxLinesFromZip(mediaUrl, authHdr, Number(meta.size || 0))
    : await mboxLinesDirect(mediaUrl, authHdr);
  return runIngest(rl, { ...opts, backfillSource: opts.backfillSource || (isZip ? "takeout-drive-zip" : "takeout-drive") });
}

// Direct .mbox download → readline (streaming line parse, no whole-file buffer).
async function mboxLinesDirect(mediaUrl: string, authHdr: Record<string, string>): Promise<Interface> {
  const res = await fetch(mediaUrl, { headers: authHdr });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Drive download failed (${res.status}): ${detail}`);
  }
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.setEncoding("utf8");
  return createInterface({ input: nodeStream, crlfDelay: Infinity });
}

// Takeout .zip → locate + stream-inflate the .mbox entry via HTTP Range requests → readline.
async function mboxLinesFromZip(mediaUrl: string, authHdr: Record<string, string>, size: number): Promise<Interface> {
  if (!size) throw new Error("Drive: missing file size for zip (needed for Range reads)");
  const readRange: RangeReader = async (start, end) => {
    const r = await fetch(mediaUrl, { headers: { ...authHdr, Range: `bytes=${start}-${end}` } });
    if (!r.ok) throw new Error(`Drive range read ${start}-${end} failed (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  };
  const streamRange: RangeStreamer = async (start, end) => {
    const r = await fetch(mediaUrl, { headers: { ...authHdr, Range: `bytes=${start}-${end}` } });
    if (!r.ok || !r.body) throw new Error(`Drive range stream ${start}-${end} failed (${r.status})`);
    return Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
  };
  const entries = await listZipEntries(size, readRange);
  const entry = pickMboxEntry(entries);
  if (!entry) throw new Error(`No .mbox entry found in the Takeout zip (${entries.length} entries)`);
  const mbox = await openZipEntryStream(entry, readRange, streamRange);
  mbox.setEncoding("utf8");
  return createInterface({ input: mbox, crlfDelay: Infinity });
}
