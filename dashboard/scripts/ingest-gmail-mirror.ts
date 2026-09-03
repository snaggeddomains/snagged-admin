// Runner for the Gmail local-mirror seed. Streams a mailbox's Google Takeout export into the
// gmail_messages table (quota-free — Takeout/Drive, never the Gmail API). Meant to run on a
// long-lived runner (the gmail-mirror-ingest GitHub Action, or the sandbox), NOT a Vercel fn.
//
//   npx tsx scripts/ingest-gmail-mirror.ts --mailbox rob@snagged.com --file-id <driveId>
//   npx tsx scripts/ingest-gmail-mirror.ts --mailbox rob@snagged.com --file /path/to/export.mbox
//
// A --file-id may point at the raw .mbox OR the Takeout .zip (the .mbox is streamed out of the zip).
// Env required: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (mirror DB), and for --file-id GOOGLE_SA_KEY
// (the Drive service account, which must be able to read the file — shared drive or shared to the SA).

import { ingestMbox, ingestMboxFromDrive } from "../lib/gmail-mirror/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

async function main() {
  const mailbox = arg("mailbox") || process.env.MIRROR_MAILBOX;
  const fileId = arg("file-id") || process.env.MIRROR_FILE_ID;
  const filePath = arg("file") || process.env.MIRROR_FILE_PATH;

  if (!mailbox) throw new Error("Missing --mailbox (or MIRROR_MAILBOX)");
  if (!fileId && !filePath) throw new Error("Provide --file-id <driveId> (or MIRROR_FILE_ID) or --file <path> (or MIRROR_FILE_PATH)");
  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  const started = Date.now();
  const onProgress = (n: number) => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`  … ${n.toLocaleString()} messages ingested (${mins} min)`);
  };

  console.log(`[gmail-mirror] Seeding ${mailbox} from ${fileId ? `Drive ${fileId}` : filePath}`);
  const res = fileId
    ? await ingestMboxFromDrive({ mailbox, fileId, onProgress })
    : await ingestMbox({ mailbox, filePath: filePath as string, onProgress });

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`[gmail-mirror] DONE — ${mailbox}: ${res.imported.toLocaleString()} messages in ${mins} min`);
}

main().catch((e) => {
  console.error(`[gmail-mirror] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
