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
import { getDb } from "../lib/supabase";

// Preflight: probe which tables PostgREST can see, so a "schema cache" failure is diagnosable.
// `deals` is a long-standing table on the main project → if it's visible we're on the RIGHT
// project and the miss is purely a stale schema cache (run NOTIFY); if `deals` is ALSO missing,
// the SUPABASE_URL secret points at the WRONG project.
async function preflight() {
  const db = getDb();
  const probe = async (t: string) => {
    const { error } = await db.from(t).select("id", { head: true, count: "exact" }).limit(1);
    return error ? `NOT VISIBLE (${error.message.slice(0, 70)})` : "visible";
  };
  const deals = await probe("deals");
  const gmail = await probe("gmail_messages");
  console.log(`[preflight] deals=${deals} | gmail_messages=${gmail}`);
  if (deals.startsWith("visible") && !gmail.startsWith("visible")) {
    console.log("[preflight] → RIGHT project, but gmail_messages isn't in PostgREST's cache. Run `notify pgrst, 'reload schema';` on domain-owner-research.");
  } else if (!deals.startsWith("visible")) {
    console.log("[preflight] → deals is missing too — the SUPABASE_URL secret likely points at the WRONG project (not domain-owner-research).");
  }
}

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

  const writePath = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL) ? "direct Postgres (pg)" : "supabase-js (REST)";
  console.log(`[gmail-mirror] Write path: ${writePath}`);
  if (writePath.startsWith("supabase")) await preflight();  // REST path only — pg has no schema cache
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
