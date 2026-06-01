// Drives the SNAP Orchestrator GitHub Actions workflow from Vercel Cron.
//
// GitHub's `schedule:` triggers are best-effort — they routinely run late or
// get dropped, which broke the 7 AM ET SLA. Instead a Vercel Cron hits
// /api/cron/snap-run at the SLA start time, and we dispatch the single
// "SNAP Orchestrator" workflow (snap-orchestrator.yml) via the REST API. The
// orchestrator then runs every daily source in order. A second cron hits
// /api/cron/snap-watchdog near the SLA deadline to confirm it actually ran.
//
// Auth: GH_DISPATCH_TOKEN — a fine-grained PAT scoped to snagged-admin with
// Actions: read & write. Falls back to GITHUB_TOKEN (the read-only contents
// token) which canNOT dispatch, so the user must add GH_DISPATCH_TOKEN.

const OWNER = "snaggeddomains";
const REPO = "snagged-admin";
const REF = "main";
const WORKFLOW_FILE = "snap-orchestrator.yml";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function dispatchToken(): string | null {
  return process.env.GH_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || null;
}

function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Fire workflow_dispatch for the orchestrator on main. */
export async function dispatchOrchestrator(): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = dispatchToken();
  if (!token) return { ok: false, status: 0, error: "No GH_DISPATCH_TOKEN configured." };

  const res = await fetch(`${API}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ ref: REF }),
    cache: "no-store",
  });
  // 204 No Content == accepted.
  if (res.status === 204) return { ok: true, status: 204 };
  const detail = await res.text().catch(() => "");
  return { ok: false, status: res.status, error: detail || `dispatch failed (${res.status})` };
}

export interface OrchestratorRun {
  id: number;
  status: string | null; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null (while running)
  created_at: string;
  html_url: string;
}

/** Most recent orchestrator runs (newest first). Empty if not configured. */
export async function recentOrchestratorRuns(perPage = 10): Promise<OrchestratorRun[]> {
  const token = dispatchToken();
  if (!token) return [];
  const res = await fetch(
    `${API}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${perPage}`,
    { headers: ghHeaders(token), cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { workflow_runs?: OrchestratorRun[] } | null;
  return data?.workflow_runs ?? [];
}

/** The latest run that was created on the current UTC calendar day, if any. */
export function latestRunToday(runs: OrchestratorRun[]): OrchestratorRun | null {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  for (const r of runs) {
    if ((r.created_at || "").slice(0, 10) === today) return r;
  }
  return null;
}

/** Best-effort Slack alert. No-ops if SLACK_BOT_TOKEN / channel aren't set. */
export async function slackAlert(text: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_SNAP || process.env.SLACK_CHANNEL_AUCTIONS;
  if (!token || !channel) return false;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

/** Constant-time-ish check that a request carries the Vercel Cron secret.
 *  Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes. */
export function authorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — require the secret to be set
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}
