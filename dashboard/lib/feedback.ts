// Feedback / Feature Requests store + notify. Any logged-in user can submit; only Rob (admin /
// admin.feedback.manage) sees the whole queue. On a new submission ONLY rob@snagged.com is alerted
// (bell + email). Fail-soft: a missing table (migration not run) returns [] / a note instead of erroring.

import { getDb, isDbConfigured } from "./supabase";
import { createNotification } from "./notifications";
import { sendEmail } from "./email";
import { RESEARCH_TABS, ADMIN_TABS, SNAP_TABS, REPORTS_TABS, DEALS_TABS } from "./permissions";

const TABLE = "feature_requests";
const ROB = "rob@snagged.com";

export const KINDS: { value: string; label: string }[] = [
  { value: "tweak", label: "Tweak / improvement to something that exists" },
  { value: "addition", label: "Addition to an existing module" },
  { value: "new_module", label: "Brand-new module / functionality" },
  { value: "bug", label: "Bug / something's broken" },
  { value: "other", label: "Other" },
];
export const STATUSES: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped", label: "Shipped" },
  { value: "declined", label: "Declined" },
];

export type FeatureRequest = {
  id: string;
  submitted_by: string | null;
  submitted_by_name: string | null;
  module: string | null;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  admin_notes: string | null;
  attachments: { url: string; name: string; type: string }[] | null;
  created_at: string;
  updated_at: string;
};

export function feedbackConfigured(): boolean {
  return isDbConfigured();
}

// The module/area picklist — derived from the nav tab registry so it auto-covers every current
// tool (+ the top-level areas) and never drifts. Deduped, sorted, with a catch-all at the end.
export function feedbackModules(): string[] {
  const labels = new Set<string>();
  for (const arr of [RESEARCH_TABS, SNAP_TABS, REPORTS_TABS, DEALS_TABS, ADMIN_TABS]) {
    for (const t of arr) labels.add(t.label);
  }
  const list = [...labels].sort((a, b) => a.localeCompare(b));
  return [...list, "New module / other"];
}

function missingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code || "";
  const msg = (e?.message || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table");
}
const clean = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s || null; };

export type CreateFeedbackInput = { module?: string; kind?: string; title: string; body?: string; attachments?: { url: string; name?: string; type?: string }[] };

export async function createFeedback(input: CreateFeedbackInput, by: { email: string; name?: string | null }): Promise<FeatureRequest> {
  const title = clean(input.title);
  if (!title) throw new Error("A short title is required.");
  const kind = KINDS.some((k) => k.value === input.kind) ? String(input.kind) : "tweak";
  // Sanitize attachments: http(s) URLs only, ≤10.
  const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
    .filter((a) => a && /^https?:\/\//i.test(String(a.url)))
    .slice(0, 10)
    .map((a) => ({ url: String(a.url), name: String(a.name || "image"), type: String(a.type || "") }));
  const row: Record<string, unknown> = {
    submitted_by: (by.email || "").toLowerCase() || null,
    submitted_by_name: clean(by.name) || by.email || null,
    module: clean(input.module),
    kind,
    title,
    body: clean(input.body),
    status: "open",
    attachments: attachments.length ? attachments : null,
  };
  let ins = await getDb().from(TABLE).insert(row).select("*").single();
  // Degrade gracefully if the attachments column isn't migrated yet.
  if (ins.error && /attachments/i.test(ins.error.message || "")) {
    delete row.attachments;
    ins = await getDb().from(TABLE).insert(row).select("*").single();
  }
  if (ins.error) throw new Error(`createFeedback: ${ins.error.message}`);
  const fr = ins.data as FeatureRequest;
  notifyRob(fr).catch(() => {});   // best-effort, never blocks the submit
  return fr;
}

// List: `mine` = a user's own submissions; `all` (Rob) = the whole queue. Newest first.
export async function listFeedback(opts: { mine?: string; status?: string; q?: string; limit?: number } = {}): Promise<FeatureRequest[]> {
  if (!isDbConfigured()) return [];
  let query = getDb().from(TABLE).select("*");
  if (opts.mine) query = query.eq("submitted_by", opts.mine.toLowerCase());
  if (opts.status && opts.status !== "all") query = query.eq("status", opts.status);
  if (opts.q && opts.q.trim()) { const like = `%${opts.q.trim()}%`; query = query.or(`title.ilike.${like},body.ilike.${like},module.ilike.${like}`); }
  query = query.order("created_at", { ascending: false }).limit(Math.min(opts.limit ?? 500, 1000));
  const { data, error } = await query;
  if (error) { if (missingTable(error)) return []; throw new Error(`listFeedback: ${error.message}`); }
  return (data as FeatureRequest[]) || [];
}

const EDITABLE = new Set(["status", "admin_notes", "module", "kind", "title", "body"]);
export async function updateFeedback(id: string, patch: Record<string, unknown>): Promise<FeatureRequest> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) if (EDITABLE.has(k)) update[k] = typeof v === "string" ? v.trim() : v;
  const { data, error } = await getDb().from(TABLE).update(update).eq("id", id).select("*").single();
  if (error) throw new Error(`updateFeedback: ${error.message}`);
  return data as FeatureRequest;
}

// Alert ONLY rob@snagged.com — bell (needs his user id) + email. Best-effort.
async function notifyRob(fr: FeatureRequest): Promise<void> {
  const who = fr.submitted_by_name || fr.submitted_by || "someone";
  const kindLabel = KINDS.find((k) => k.value === fr.kind)?.label || fr.kind;
  const sub = `💡 Feature request: ${fr.title}`;
  const bodyLine = `${fr.module ? fr.module + " · " : ""}${kindLabel} · from ${who}`;
  try {
    const { data } = await getDb().from("domain_research_users").select("id").eq("email", ROB).maybeSingle();
    const id = (data as { id: string } | null)?.id;
    if (id) await createNotification([id], { kind: "feedback", title: sub, body: bodyLine, link: "/feedback" });
  } catch { /* best-effort */ }
  try {
    const base = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/$/, "");
    await sendEmail({
      to: ROB,
      subject: sub,
      html:
        `<p><strong>${escapeHtml(fr.title)}</strong></p>` +
        `<p>${escapeHtml(bodyLine)}</p>` +
        (fr.body ? `<p style="white-space:pre-wrap">${escapeHtml(fr.body)}</p>` : "") +
        `<p><a href="${base}/feedback">Open the feedback queue →</a></p>`,
    });
  } catch { /* best-effort */ }
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
