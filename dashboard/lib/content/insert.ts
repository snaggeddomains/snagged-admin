// Phase 2 — apply a cross-link opportunity to the actual Webflow blog post body.
// Two shapes: kind="anchor" wraps an EXISTING body phrase in a link; kind="add_sentence" inserts a
// NEW sentence (with the anchor linked) after a placement hint. The rewrite is HTML-token-aware so
// it NEVER links inside a heading (<h1>–<h6>) or inside an existing <a>, and never edits a tag.
// Server-only.

import { getDb } from "../supabase";
import { webflowConfigured, webflowCanWrite, getCollection, getItem, updateItem, publishItems, type WfField } from "../webflow";

const LINKS = "content_crosslinks";
const POST_BASE = process.env.CONTENT_POST_BASE || "https://www.snagged.com/post";
export const postHref = (slug: string): string => `${POST_BASE}/${String(slug || "").trim()}`;

const escapeHtml = (s: string): string => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Split HTML into tag/text tokens so we can walk structure without a DOM parser.
type Tok = { t: "tag" | "text"; v: string };
export function tokenizeHtml(html: string): Tok[] {
  const tokens: Tok[] = [];
  const re = /<[^>]+>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) tokens.push({ t: "text", v: html.slice(last, m.index) });
    tokens.push({ t: "tag", v: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) tokens.push({ t: "text", v: html.slice(last) });
  return tokens;
}

// Wrap the FIRST occurrence of `anchor` that sits in ordinary body text — not inside a heading,
// not inside an existing link. Returns the rewritten HTML, or null if no linkable spot was found
// (e.g. the phrase only appears inside a heading, or straddles inline tags).
export function wrapAnchor(html: string, anchor: string, slug: string): string | null {
  const needle = String(anchor || "").trim();
  if (!needle) return null;
  const tokens = tokenizeHtml(html);
  const aLower = needle.toLowerCase();
  const href = postHref(slug);
  let inHeading = 0, inAnchor = 0, done = false;
  for (const tok of tokens) {
    if (tok.t === "tag") {
      const tag = tok.v.toLowerCase();
      if (/^<h[1-6][\s/>]/.test(tag)) inHeading++;
      else if (/^<\/h[1-6]\s*>/.test(tag)) inHeading = Math.max(0, inHeading - 1);
      else if (/^<a[\s>]/.test(tag)) inAnchor++;
      else if (/^<\/a\s*>/.test(tag)) inAnchor = Math.max(0, inAnchor - 1);
      continue;
    }
    if (done || inHeading || inAnchor) continue;
    const idx = tok.v.toLowerCase().indexOf(aLower);
    if (idx >= 0) {
      const orig = tok.v.slice(idx, idx + needle.length); // preserve the body's own casing
      tok.v = `${tok.v.slice(0, idx)}<a href="${href}">${orig}</a>${tok.v.slice(idx + needle.length)}`;
      done = true;
    }
  }
  return done ? tokens.map((t) => t.v).join("") : null;
}

// Turn a plain sentence into HTML with `anchor` (a substring of it) wrapped in a link.
export function linkifySentence(sentence: string, anchor: string, slug: string): string {
  const s = String(sentence || "");
  const a = String(anchor || "").trim();
  const i = a ? s.toLowerCase().indexOf(a.toLowerCase()) : -1;
  if (i < 0) return escapeHtml(s);
  return `${escapeHtml(s.slice(0, i))}<a href="${postHref(slug)}">${escapeHtml(s.slice(i, i + a.length))}</a>${escapeHtml(s.slice(i + a.length))}`;
}

// Insert a NEW paragraph (the linkified new sentence) after the block that contains `insertAfter`
// (a verbatim heading/paragraph-tail hint). Falls back to after the first block if the hint misses.
export function insertSentence(html: string, newSentence: string, anchor: string, insertAfter: string, slug: string): string | null {
  const inner = linkifySentence(newSentence, anchor, slug);
  if (!/<a /.test(inner)) return null; // anchor wasn't inside the sentence — bail rather than add a link-less line
  const para = `<p>${inner}</p>`;
  const closeRe = /<\/(h[1-6]|p|ul|ol|blockquote|figure)>/gi;
  let pos = -1;
  const hint = String(insertAfter || "").trim();
  if (hint) {
    const hi = html.toLowerCase().indexOf(hint.toLowerCase());
    if (hi >= 0) { closeRe.lastIndex = hi; const m = closeRe.exec(html); if (m) pos = m.index + m[0].length; }
  }
  if (pos < 0) { const m = /<\/(h[1-6]|p)>/i.exec(html); pos = m ? m.index + m[0].length : html.length; }
  return html.slice(0, pos) + para + html.slice(pos);
}

// Resolve the blog collection's BODY (RichText) field slug — mirrors toPosts' detection, but for a
// single item we pick the richest RichText field on THAT item (excluding the summary field).
function resolveBodySlug(fields: WfField[], fieldData: Record<string, unknown>): string | null {
  const bySlug = (re: RegExp) => fields.find((f) => re.test(f.slug) || re.test(f.displayName || ""))?.slug;
  const summarySlug = bySlug(/summary|excerpt|subtitle/i);
  const named = bySlug(/post.?body|^body$|content|article/i);
  if (named) return named;
  const rich = fields.filter((f) => /richtext/i.test(f.type) && f.slug !== summarySlug);
  let best = -1, slug: string | null = null;
  for (const f of rich) { const len = String(fieldData[f.slug] || "").length; if (len > best) { best = len; slug = f.slug; } }
  return slug;
}

export type ApplyResult = { ok: boolean; error?: string; published?: boolean; preview?: string };

// Apply one opportunity to its source post. publish=false stages the edit in the CMS (review in
// Webflow Designer / publish later); publish=true also pushes it live. dryRun returns the rewrite
// without writing. Idempotent-ish: a row already marked inserted is not re-applied.
export async function applyCrosslink(id: string, opts: { publish: boolean; dryRun?: boolean }): Promise<ApplyResult> {
  if (!webflowConfigured()) return { ok: false, error: "Webflow not configured" };
  if (!opts.dryRun && !webflowCanWrite()) return { ok: false, error: "Webflow token is read-only — set a write token (WEBFLOW_API_TOKEN) to insert links" };
  const collectionId = process.env.WEBFLOW_BLOG_POSTS_ID;
  if (!collectionId) return { ok: false, error: "WEBFLOW_BLOG_POSTS_ID not set" };

  const { data: opp } = await getDb().from(LINKS).select("*").eq("id", id).maybeSingle();
  if (!opp) return { ok: false, error: "Opportunity not found" };
  if (opp.status === "inserted") return { ok: false, error: "Already inserted" };

  const [coll, item] = await Promise.all([getCollection(collectionId), getItem(collectionId, opp.source_id)]);
  const fields = coll.data?.fields || [];
  const fieldData = item.data?.fieldData || {};
  if (!item.ok || !item.data) return { ok: false, error: item.error || "Could not load the source post" };
  const bodySlug = resolveBodySlug(fields, fieldData);
  if (!bodySlug) return { ok: false, error: "Could not find the post body field" };
  const html = String(fieldData[bodySlug] || "");
  if (!html) return { ok: false, error: "Source post body is empty" };

  const rewritten = opp.kind === "add_sentence"
    ? insertSentence(html, opp.new_sentence || "", opp.anchor || "", opp.context || "", opp.target_slug || "")
    : wrapAnchor(html, opp.anchor || "", opp.target_slug || "");
  if (rewritten == null) {
    return { ok: false, error: opp.kind === "add_sentence" ? "Could not build the new sentence" : "Couldn't place the link in body prose (the phrase may only appear in a heading or across formatting) — insert manually" };
  }
  if (rewritten === html) return { ok: false, error: "No change produced" };
  if (opts.dryRun) return { ok: true, preview: rewritten };

  const upd = await updateItem(collectionId, opp.source_id, { [bodySlug]: rewritten }, { live: false });
  if (!upd.ok) return { ok: false, error: upd.error || "Webflow update failed" };
  let published = false;
  if (opts.publish) { const p = await publishItems(collectionId, [opp.source_id]); published = p.ok; }
  await getDb().from(LINKS).update({ status: "inserted" }).eq("id", id);
  return { ok: true, published };
}
