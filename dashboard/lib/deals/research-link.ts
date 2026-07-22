// Resolve a domain's public Domain Owner report share link from the research app's runs
// (domain_research_runs lives in the shared main project — admin SUPABASE_URL == research
// main), so a deal gets its research report auto-populated even when it wasn't created from
// a research surface (imported / board / triage). Mirrors the research app's share-URL shape
// `/research/r/<domain>-<runId>` (buildSlug). Returns null if there's no completed run yet.

import { getDb } from "../supabase";

const RESEARCH_BASE = (process.env.RESEARCH_APP_BASE || "https://app.snagged.com/research").replace(/\/+$/, "");
const RESEARCH_INTERNAL_BASE = (process.env.RESEARCH_INTERNAL_BASE || "https://research.snagged.com").replace(/\/+$/, "");

// Kick a FREE Domain Owner pre-flight report for a domain so a report-less deal (manually
// added, or one whose domain we've never researched) gets a report to auto-link. Deduped on
// the research side — safe to call repeatedly. Best-effort + non-blocking: no secret / a
// failed call just means the link fills in later (or never), never blocks the deal. Free
// pre-flight only — no paid credits spent.
export async function kickResearchRun(domain: string): Promise<void> {
  const d = String(domain || "").trim().toLowerCase();
  if (!d || !d.includes(".")) return;
  const secret = process.env.RESEARCH_INTERNAL_SECRET;
  if (!secret) return;
  try {
    await fetch(`${RESEARCH_INTERNAL_BASE}/api/internal/kick-research`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ domain: d }),
    });
  } catch {
    /* best-effort — report auto-links later once a run exists */
  }
}

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
