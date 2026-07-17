// Client Domain corpus builder — the single daily aggregation pipeline (spec §18).
// Gathers domains from every source (each fail-open), dedupes to canonical apex,
// merges provenance, preserves Date Added + first-ingested day, upserts the
// client_domains table (source of truth), then mirrors the FULL corpus to the
// Client Domain Names Google Sheet. Replaces the OpenClaw build_domain_contact_sheet.py.

import { clearSheetRange, writeSheetRange } from "../sheets";
import { gmailConfigured } from "../gmail";
import type { CorpusRecord, CorpusRow, RawHit } from "./types";
import { mergeHit, finalizeRecord, todayISO } from "./merge";
import { readPaymentsHits, readMasterTxnsHits } from "./sources/tracker";
import { readOpportunityHits } from "./sources/opportunity";
import { readGmailHits } from "./sources/gmail";
import { readDomainScoutHits } from "./sources/domainscout";
import { readExistingMeta, upsertCorpus, corpusCount, logBuildRun, readAllForMirror, pruneBulkGmail } from "./store";

const TARGET_SHEET_ID = process.env.CLIENT_DOMAINS_SHEET_ID || "19uJ2-1DrSAZ9J110Zf2AJIf9opNkXdPQguE3HplUgpM";
const TARGET_TAB = "Client Domain Names";
const HEADER = ["Domain", "Client / Contact", "Date of Last Contact", "Date Added", "Notes"];

export type BuildStats = {
  ok: boolean;
  added: number; // net-new domains this run
  total: number; // corpus size after the run
  sourceCounts: Record<string, number>;
  gmailDays: number | null;
  mirrored: boolean;
  pruned?: number;
  mirrorError?: string;
  error?: string;
};

// Collapse a per-row source tag to a coarse bucket for the run summary
// ([Gmail:rob@…] → [Gmail]).
function bucket(tag: string): string {
  if (tag.startsWith("[Gmail")) return "[Gmail]";
  return tag;
}

/** Run one source, logging + swallowing failures (spec §16 — a bad source degrades). */
async function safe(label: string, fn: () => Promise<RawHit[]>): Promise<RawHit[]> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[corpus] source ${label} failed: ${String((e as Error)?.message || e)}`);
    return [];
  }
}

/** Rewrite the Client Domain Names tab from the full corpus. Best-effort (the DB is
 *  the source of truth) — a share/permission problem never fails the build. */
async function mirrorSheet(): Promise<{ ok: boolean; error?: string }> {
  try {
    const rows = await readAllForMirror();
    const matrix: (string | number | null)[][] = [HEADER];
    for (const r of rows) {
      matrix.push([
        r.domain,
        r.clients.join("\n"),
        r.last_contact_date || "Unknown",
        r.date_added || "",
        r.notes || "",
      ]);
    }
    await clearSheetRange(TARGET_SHEET_ID, `'${TARGET_TAB}'!A:E`);
    await writeSheetRange(TARGET_SHEET_ID, `'${TARGET_TAB}'!A1`, matrix);
    return { ok: true };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[corpus] sheet mirror failed: ${error}`);
    return { ok: false, error };
  }
}

export async function buildCorpus(opts: { gmailDays?: number; skipGmail?: boolean; skipMirror?: boolean; prune?: boolean } = {}): Promise<BuildStats> {
  const gmailDays = opts.gmailDays ?? 30;
  const useGmail = !opts.skipGmail && gmailConfigured();

  try {
    // Optional: scrub bulk-list pollution (NameJet/Catches.io blasts) before rebuilding.
    let pruned = 0;
    if (opts.prune) pruned = await pruneBulkGmail();

    const existing = await readExistingMeta();

    // Gather every source in parallel; each is independently fail-open.
    const [payments, master, opp, gmail, ds] = await Promise.all([
      safe("payments", readPaymentsHits),
      safe("master_txns", readMasterTxnsHits),
      safe("opportunity", readOpportunityHits),
      useGmail ? safe("gmail", () => readGmailHits(gmailDays)) : Promise.resolve([] as RawHit[]),
      safe("domainscout", readDomainScoutHits),
    ]);

    // Merge all hits into one record per canonical apex.
    const map = new Map<string, CorpusRecord>();
    for (const hit of [...payments, ...master, ...opp, ...gmail, ...ds]) mergeHit(map, hit);

    const today = todayISO();
    const rows: CorpusRow[] = [];
    const sourceCounts: Record<string, number> = {};
    let added = 0;
    for (const rec of map.values()) {
      const row = finalizeRecord(rec, existing.get(rec.domain) || null);
      rows.push(row);
      if (!existing.has(rec.domain)) added++;
      for (const tag of row.sources) {
        const b = bucket(tag);
        sourceCounts[b] = (sourceCounts[b] || 0) + 1;
      }
    }

    await upsertCorpus(rows);
    const total = await corpusCount();

    let mirrored = false;
    let mirrorError: string | undefined;
    if (!opts.skipMirror) {
      const m = await mirrorSheet();
      mirrored = m.ok;
      mirrorError = m.error;
    }

    await logBuildRun({
      run_date: today,
      added_count: added,
      total_count: total,
      source_counts: sourceCounts,
      gmail_days: useGmail ? gmailDays : null,
      ok: true,
      error: null,
    });

    return { ok: true, added, total, sourceCounts, gmailDays: useGmail ? gmailDays : null, mirrored, pruned, mirrorError };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[corpus] build failed: ${error}`);
    await logBuildRun({ run_date: todayISO(), added_count: 0, total_count: await corpusCount().catch(() => 0), source_counts: {}, gmail_days: null, ok: false, error });
    return { ok: false, added: 0, total: 0, sourceCounts: {}, gmailDays: null, mirrored: false, error };
  }
}
