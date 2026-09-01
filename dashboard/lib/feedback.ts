// Feedback / Feature Requests store + notify. Any logged-in user can submit; only Rob (admin /
// admin.feedback.manage) sees the whole queue. On a new submission ONLY rob@snagged.com is alerted
// (bell + email). Fail-soft: a missing table (migration not run) returns [] / a note instead of erroring.

import { getDb, isDbConfigured } from "./supabase";
import { createNotification } from "./notifications";
import { sendEmail } from "./email";
import { RESEARCH_TABS, ADMIN_TABS, SNAP_TABS, REPORTS_TABS, DEALS_TABS } from "./permissions";

const TABLE = "feature_requests";
const COMMENTS = "feature_request_comments";
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
  comment_count?: number;   // attached by listFeedback for the list UI
};

export type FeatureComment = {
  id: string;
  request_id: string;
  author_email: string | null;
  author_name: string | null;
  body: string | null;
  mentions: string[] | null;
  created_at: string;
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

// List: `mine` = a user's own submissions PLUS any ticket they commented on or were tagged in
// (so a clarification thread keeps both sides looking at it); `all` (Rob) = the whole queue.
// Newest first; each row carries a comment_count for the list UI.
export async function listFeedback(opts: { mine?: string; status?: string; q?: string; limit?: number } = {}): Promise<FeatureRequest[]> {
  if (!isDbConfigured()) return [];
  let query = getDb().from(TABLE).select("*");
  if (opts.mine) {
    const email = opts.mine.toLowerCase();
    const partIds = await participantTicketIds(email);   // tickets they've joined via comments/mentions
    query = partIds.length
      ? query.or(`submitted_by.eq.${email},id.in.(${partIds.join(",")})`)
      : query.eq("submitted_by", email);
  }
  if (opts.status && opts.status !== "all") query = query.eq("status", opts.status);
  if (opts.q && opts.q.trim()) { const like = `%${opts.q.trim()}%`; query = query.or(`title.ilike.${like},body.ilike.${like},module.ilike.${like}`); }
  query = query.order("created_at", { ascending: false }).limit(Math.min(opts.limit ?? 500, 1000));
  const { data, error } = await query;
  if (error) { if (missingTable(error)) return []; throw new Error(`listFeedback: ${error.message}`); }
  const rows = (data as FeatureRequest[]) || [];
  return attachCommentCounts(rows);
}

async function attachCommentCounts(rows: FeatureRequest[]): Promise<FeatureRequest[]> {
  if (!rows.length) return rows;
  try {
    const { data } = await getDb().from(COMMENTS).select("request_id").in("request_id", rows.map((r) => r.id));
    const counts = new Map<string, number>();
    for (const c of (data as { request_id: string }[]) || []) counts.set(c.request_id, (counts.get(c.request_id) || 0) + 1);
    return rows.map((r) => ({ ...r, comment_count: counts.get(r.id) || 0 }));
  } catch { return rows; }   // table not migrated yet → no counts, list still works
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

// ── Clarification thread (comments + @mention tagging) ───────────────────────────────────
// Any participant (submitter, Rob, a tagged teammate, or a past commenter) can read + post.
// Posting a comment tagging teammates gives them access + a bell/email; every later comment
// then keeps every participant in the loop — mirrors the deal comment module.

// The set of ticket ids a user is a PARTICIPANT of via the thread (commented on OR tagged in).
// Used to widen a non-manager's "mine" list beyond just their own submissions.
export async function participantTicketIds(email: string): Promise<string[]> {
  const e = (email || "").toLowerCase();
  if (!isDbConfigured() || !e) return [];
  try {
    const { data, error } = await getDb().from(COMMENTS).select("request_id,author_email,mentions");
    if (error) return [];
    const ids = new Set<string>();
    for (const c of (data as { request_id: string; author_email: string | null; mentions: string[] | null }[]) || []) {
      if ((c.author_email || "").toLowerCase() === e) ids.add(c.request_id);
      else if (Array.isArray(c.mentions) && c.mentions.some((m) => (m || "").toLowerCase() === e)) ids.add(c.request_id);
    }
    return [...ids];
  } catch { return []; }
}

export async function listComments(requestId: string): Promise<FeatureComment[]> {
  if (!isDbConfigured() || !requestId) return [];
  try {
    const { data, error } = await getDb().from(COMMENTS).select("*").eq("request_id", requestId).order("created_at", { ascending: true });
    if (error) { if (missingTable(error)) return []; throw new Error(error.message); }
    return (data as FeatureComment[]) || [];
  } catch (err) { if (missingTable(err)) return []; throw err; }
}

export async function getFeedback(id: string): Promise<FeatureRequest | null> {
  if (!isDbConfigured() || !id) return null;
  try {
    const { data, error } = await getDb().from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) { if (missingTable(error)) return null; throw new Error(error.message); }
    return (data as FeatureRequest) || null;
  } catch (err) { if (missingTable(err)) return null; throw err; }
}

export async function addComment(
  requestId: string,
  input: { body?: string; mentions?: string[] },
  author: { email: string; name?: string | null },
): Promise<FeatureComment> {
  const body = clean(input.body);
  const mentions = [...new Set((Array.isArray(input.mentions) ? input.mentions : []).map((m) => String(m || "").toLowerCase().trim()).filter(Boolean))];
  if (!body && !mentions.length) throw new Error("Write a comment first.");
  const row = {
    request_id: requestId,
    author_email: (author.email || "").toLowerCase() || null,
    author_name: clean(author.name) || author.email || null,
    body,
    mentions: mentions.length ? mentions : null,
  };
  const { data, error } = await getDb().from(COMMENTS).insert(row).select("*").single();
  if (error) throw new Error(`addComment: ${error.message}`);
  const comment = data as FeatureComment;
  notifyFeedbackComment(requestId, comment).catch(() => {});   // best-effort
  return comment;
}

// Notify on a new comment: the tagged teammates (strong "tagged you" ping) + every other
// participant (submitter, Rob, past commenters/mentioned) kept in the loop — minus the author.
async function notifyFeedbackComment(requestId: string, comment: FeatureComment): Promise<void> {
  try {
    const fr = await getFeedback(requestId);
    if (!fr) return;
    const author = (comment.author_email || "").toLowerCase();
    const mentioned = (comment.mentions || []).map((m) => m.toLowerCase());
    // Everyone with a stake: submitter + Rob + every past commenter/mentioned.
    const past = await getDb().from(COMMENTS).select("author_email,mentions").eq("request_id", requestId);
    const participants = new Set<string>([ROB]);
    if (fr.submitted_by) participants.add(fr.submitted_by.toLowerCase());
    for (const c of ((past.data as { author_email: string | null; mentions: string[] | null }[]) || [])) {
      if (c.author_email) participants.add(c.author_email.toLowerCase());
      for (const m of c.mentions || []) if (m) participants.add(m.toLowerCase());
    }
    const who = comment.author_name || comment.author_email || "Someone";
    const preview = (comment.body || "").slice(0, 300);
    const link = `/feedback?ticket=${requestId}`;
    const base = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/$/, "");
    // Tagged people first (stronger wording), then the rest of the participants.
    const tagged = mentioned.filter((e) => e && e !== author);
    const others = [...participants].filter((e) => e && e !== author && !tagged.includes(e));
    const deliver = async (emails: string[], strong: boolean) => {
      for (const to of emails) {
        try {
          const { data } = await getDb().from("domain_research_users").select("id").eq("email", to).maybeSingle();
          const id = (data as { id: string } | null)?.id;
          const title = strong ? `💬 ${who} tagged you on “${fr.title}”` : `💬 ${who} commented on “${fr.title}”`;
          if (id) await createNotification([id], { kind: "feedback", title, body: preview, link });
          await sendEmail({
            to,
            subject: title,
            html: `<p><strong>${escapeHtml(fr.title)}</strong></p>` + (preview ? `<p style="white-space:pre-wrap">${escapeHtml(preview)}</p>` : "") + `<p><a href="${base}${link}">Open the request →</a></p>`,
          });
        } catch { /* best-effort per recipient */ }
      }
    };
    await deliver(tagged, true);
    await deliver(others, false);
  } catch { /* best-effort */ }
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

