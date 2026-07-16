// Read-only probe of the corpus Google-Sheet sources (uses GOOGLE_SA_KEY). Proves the
// shares work + the column mapping is sane against real data. Touches NO DB, writes nothing.
// Run: npx tsx scripts/corpus_read_probe.ts
import { readPaymentsHits, readMasterTxnsHits } from "../lib/domain-corpus/sources/tracker";
import { readOpportunityHits } from "../lib/domain-corpus/sources/opportunity";
import { getSheetValues } from "../lib/sheets";

function summarize(label: string, hits: { domain: string; client?: string | null; date?: string | null }[]) {
  const domains = new Set(hits.map((h) => h.domain));
  const withClient = hits.filter((h) => h.client).length;
  const withDate = hits.filter((h) => h.date).length;
  console.log(`\n[${label}] ${hits.length} hits · ${domains.size} distinct domains · ${withClient} w/client · ${withDate} w/date`);
  console.log("  sample:", [...domains].slice(0, 8).join(", "));
}

(async () => {
  try {
    const pay = await readPaymentsHits();
    summarize("Payments", pay);
  } catch (e) { console.log("[Payments] ERROR:", String((e as Error).message)); }

  try {
    const mtx = await readMasterTxnsHits();
    summarize("Master Txns List", mtx);
  } catch (e) { console.log("[Master Txns List] ERROR:", String((e as Error).message)); }

  try {
    const opp = await readOpportunityHits();
    summarize("Full Opportunity", opp);
  } catch (e) { console.log("[Full Opportunity] ERROR:", String((e as Error).message)); }

  // Confirm read access to the TARGET workbook (edit-share implies read).
  try {
    const target = process.env.CLIENT_DOMAINS_SHEET_ID || "19uJ2-1DrSAZ9J110Zf2AJIf9opNkXdPQguE3HplUgpM";
    const rows = await getSheetValues(target, "'Client Domain Names'!A1:E5");
    console.log(`\n[Client Domain Names TARGET] readable · header: ${JSON.stringify(rows[0] || [])}`);
  } catch (e) { console.log("[Client Domain Names TARGET] ERROR:", String((e as Error).message)); }
})();
