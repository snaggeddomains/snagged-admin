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

/** Fire workflow_dispatch for the orchestrator on main.
 *  mode "ping" triggers a real dispatch that no-ops (connectivity test only);
 *  "full" (default) runs every source. */
export async function dispatchOrchestrator(
  mode: "full" | "ping" = "full",
): Promise<{ ok: boolean; status: number; error?: string }> {
  return dispatchWorkflow(WORKFLOW_FILE, { mode });
}

/** Fire workflow_dispatch for any workflow file on `main`. Shared by the cron
 *  routes (SNAP orchestrator, sedo_net_new, …) so they all use the same token +
 *  error handling. Omits `inputs` when none are given (some workflows take none). */
export async function dispatchWorkflow(
  file: string,
  inputs: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = dispatchToken();
  if (!token) return { ok: false, status: 0, error: "No GH_DISPATCH_TOKEN configured." };

  const body = Object.keys(inputs).length ? { ref: REF, inputs } : { ref: REF };
  const res = await fetch(`${API}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body),
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

/** The current hour (0-23) in America/New_York, DST-aware. */
export function etHourNow(): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  // "24" can appear for midnight in some runtimes; normalize to 0.
  return Number(h) % 24;
}

/** Vercel Cron is fixed-UTC, so to pin a job to an exact ET hour year-round we
 *  schedule it at BOTH candidate UTC hours (EDT and EST) and only act when the
 *  real ET hour matches. Returns true when now is `target` o'clock in ET. */
export function isEtHour(target: number): boolean {
  return etHourNow() === target;
}

/** Constant-time-ish check that a request carries the Vercel Cron secret.
 *  Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes. */
export function authorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — require the secret to be set
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}
