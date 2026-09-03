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
import { parseRawMessage } from "./mbox";

type CoreOpts = {
  mailbox: string;
  batchSize?: number;     // rows per upsert (default 500)
  onProgress?: (count: number) => void;
  progressEvery?: number; // fire onProgress every N messages (default 5000)
  backfillSource?: string; // stamped on gmail_sync_state (default 'takeout-mbox')
};
type FileOpts = CoreOpts & { filePath: string };
type DriveOpts = CoreOpts & { fileId: string };

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
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

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

// The shared core: consume a readline stream of mbox lines and upsert every message.
async function runIngest(rl: Interface, opts: CoreOpts): Promise<{ mailbox: string; imported: number }> {
  const { mailbox } = opts;
  const batchSize = opts.batchSize ?? 500;
  const progressEvery = opts.progressEvery ?? 5000;
  const db = getDb();

  let current: string[] = [];  // lines of the message currently being accumulated (excludes the `From ` separator)
  let started = false;
  let batch: Row[] = [];
  let imported = 0;

  async function flush(): Promise<void> {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
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
    if (line.startsWith("From ")) { // an mbox message begins with "From " at column 0
      if (started) await finishMessage();
      started = true;
      continue; // drop the separator line itself
    }
    if (started) current.push(line);
  }
  await finishMessage();
  await flush();

  await db.from("gmail_sync_state").upsert(
    {
      mailbox,
      backfill_done: true,
      backfill_source: opts.backfillSource || "takeout-mbox",
      message_count: imported,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mailbox" },
  );

  return { mailbox, imported };
}

// Ingest from a LOCAL mbox file.
export async function ingestMbox(opts: FileOpts): Promise<{ mailbox: string; imported: number }> {
  const rl = createInterface({ input: createReadStream(opts.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  return runIngest(rl, opts);
}

// Ingest by STREAMING a Takeout .mbox straight from Google Drive (by file id) via the service account —
// no giant local temp file, bounded memory. The file must be readable by the SA: drop it in the
// "Snagged Pipeline" shared drive, or share it to the SA's email. NB point this at the raw `.mbox`
// file, not the Takeout .zip (unzip first, or upload the extracted mbox).
export async function ingestMboxFromDrive(opts: DriveOpts): Promise<{ mailbox: string; imported: number }> {
  const token = await googleAccessToken(DRIVE_SCOPE);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(opts.fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Drive download failed (${res.status}) for file ${opts.fileId}: ${detail}`);
  }
  // Web ReadableStream → Node stream → readline (streaming line parse, no whole-file buffer).
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.setEncoding("utf8");
  const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });
  return runIngest(rl, { ...opts, backfillSource: opts.backfillSource || "takeout-drive" });
}
