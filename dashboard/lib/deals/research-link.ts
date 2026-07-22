// Resolve a domain's public Domain Owner report share link from the research app's runs
// (domain_research_runs lives in the shared main project — admin SUPABASE_URL == research
// main), so a deal gets its research report auto-populated even when it wasn't created from
// a research surface (imported / board / triage). Mirrors the research app's share-URL shape
// `/research/r/<domain>-<runId>` (buildSlug). Returns null if there's no completed run yet.

import { getDb } from "../supabase";

const RESEARCH_BASE = (process.env.RESEARCH_APP_BASE || "https://app.snagged.com/research").replace(/\/+$/, "");

export async function researchReportLink(domain: string): Promise<string | null> {
  const d = String(domain || "").trim().toLowerCase();
  if (!d || !d.includes(".")) return null;
  try {
    // Accept an in-progress run too — the share link is deterministic (keyed on the run
    // id) and the public route redirects into the SPA, which finishes the report live. We
    // only skip terminal FAILURES (error/cancelled). Newest qualifying run wins.
    const { data, error } = await getDb()
      .from("domain_research_runs")
      .select("id,status")
      .eq("domain", d)
      .in("status", ["done", "running", "queued"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.id) return null;
    return `${RESEARCH_BASE}/r/${d}-${data.id}`;
  } catch {
    return null;
  }
}
