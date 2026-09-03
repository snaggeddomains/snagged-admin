// Streaming MBOX → Postgres ingester for the Gmail mirror. Google Takeout exports each mailbox as
// one big mboxrd file (often many GB), so we stream it line-by-line (never load it whole), accumulate
// each message between `From ` separator lines, parse it with the pure MBOX/MIME parser, and upsert in
// batches into gmail_messages. Idempotent (PK (mailbox,id), so re-running an import is safe) and
// resumable in the sense that a re-run just re-upserts the same rows. Quota-FREE — this reads a local
// file, never the Gmail API.
//
// Usage (from a one-off script / route):
//   await ingestMbox({ mailbox: "rob@snagged.com", filePath: "/path/to/rob.mbox" });

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { getDb } from "../supabase";
import { parseRawMessage } from "./mbox";

type IngestOpts = {
  mailbox: string;
  filePath: string;
  batchSize?: number;     // rows per upsert (default 500)
  onProgress?: (count: number) => void;
  progressEvery?: number; // fire onProgress every N messages (default 5000)
};

type Row = {
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

function toRow(mailbox: string, raw: string): Row | null {
  const m = parseRawMessage(raw);
  if (!m.id) return null;
  const searchText = [m.subject, m.from, m.fromName, m.to, m.cc, m.body.slice(0, SEARCH_BODY_CAP)]
    .filter(Boolean).join(" \n ").toLowerCase();
  return {
    mailbox,
    id: m.id,
    thread_id: m.threadId || null,
    mid: m.mid || null,
    from_addr: m.from || null,
    from_name: m.fromName || null,
    to_addr: m.to || null,
    cc: m.cc || null,
    subject: m.subject || null,
    ts: m.date ? new Date(m.date).toISOString() : null,
    snippet: m.snippet || null,
    body: m.body || null,
    labels: m.labels,
    size_est: m.sizeEstimate,
    bulk: m.bulk,
    search_text: searchText,
  };
}

// Un-escape mboxrd body lines: `>From ` → `From `, `>>From ` → `>From `, etc.
function unescapeMboxrd(block: string): string {
  return block.replace(/^(>+)From /gm, (_m, gt: string) => ">".repeat(gt.length - 1) + "From ");
}

export async function ingestMbox(opts: IngestOpts): Promise<{ mailbox: string; imported: number }> {
  const { mailbox, filePath } = opts;
  const batchSize = opts.batchSize ?? 500;
  const progressEvery = opts.progressEvery ?? 5000;
  const db = getDb();

  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

  let current: string[] = [];  // lines of the message currently being accumulated (excludes the `From ` separator)
  let started = false;
  let batch: Row[] = [];
  let imported = 0;

  async function flush(): Promise<void> {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    // Upsert on the PK so a re-import is idempotent. Chunked by batchSize already.
    const { error } = await db.from("gmail_messages").upsert(rows, { onConflict: "mailbox,id" });
    if (error) throw new Error(`gmail_messages upsert failed: ${error.message}`);
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

  for await (const line of rl) {
    // An mbox message begins with a line starting "From " at column 0.
    if (line.startsWith("From ")) {
      if (started) await finishMessage();
      started = true;
      continue; // drop the separator line itself
    }
    if (started) current.push(line);
  }
  await finishMessage();
  await flush();

  // Record backfill state so the delta sync knows this mailbox is seeded.
  await db.from("gmail_sync_state").upsert(
    {
      mailbox,
      backfill_done: true,
      backfill_source: "takeout-mbox",
      message_count: imported,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mailbox" },
  );

  return { mailbox, imported };
}
