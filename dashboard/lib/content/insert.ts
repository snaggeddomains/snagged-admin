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

// Decode the same entities stripHtml decodes, so anchor matching lines up with the text the
// analysis validated the anchor against (which was the decoded, whitespace-collapsed body).
const decodeEntities = (s: string): string =>
  String(s || "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;/gi, '"');

// Build a normalized, lowercased "flat" view of the HTML's text where each flat char is mapped back
// to its raw byte range: whitespace runs collapse to one space, the entities stripHtml decodes are
// decoded, and text inside skipped regions (headings, existing links) is omitted. This mirrors
// exactly what the analysis validated the anchor against, so a valid anchor is always found — while
// the raw offsets let us splice a link into the ORIGINAL html (inline tags inside the span survive).
type Span = { rawStart: number; rawEnd: number };
function flatten(html: string, skip: { headings?: boolean; anchors?: boolean }): { flat: string; spans: Span[] } {
  const tokens = tokenizeHtml(html);
  let raw = 0, inHeading = 0, inAnchor = 0, flat = "";
  const spans: Span[] = [];
  for (const tok of tokens) {
    if (tok.t === "tag") {
      const tag = tok.v.toLowerCase();
      if (/^<h[1-6][\s/>]/.test(tag)) inHeading++;
      else if (/^<\/h[1-6]\s*>/.test(tag)) inHeading = Math.max(0, inHeading - 1);
      else if (/^<a[\s>]/.test(tag)) inAnchor++;
      else if (/^<\/a\s*>/.test(tag)) inAnchor = Math.max(0, inAnchor - 1);
      raw += tok.v.length;
      continue;
    }
    const skipHere = Boolean((skip.headings && inHeading) || (skip.anchors && inAnchor));
    const re = /&(?:nbsp|amp|lt|gt|quot|#39|rsquo|lsquo);|\s+|[\s\S]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tok.v))) {
      if (skipHere) continue;
      const piece = m[0];
      const start = raw + m.index, end = start + piece.length;
      const ch = /^\s+$/.test(piece) ? " " : (piece[0] === "&" ? decodeEntities(piece) : piece);
      flat += ch.toLowerCase();
      spans.push({ rawStart: start, rawEnd: end });
    }
    raw += tok.v.length;
  }
  return { flat, spans };
}

// Locate the FIRST linkable occurrence of `anchor` (ordinary body text — not a heading, not an
// existing link) as a raw byte range, OR a precise reason it can't be placed (so the UI can say
// WHY: only-in-heading / already-a-link / edited-out / spans-formatting, instead of one vague line).
type Placement = { rawStart: number; rawEnd: number } | { reason: string };
export function anchorPlacement(html: string, anchor: string): Placement {
  const needle = String(anchor || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) return { reason: "empty anchor" };
  const { flat, spans } = flatten(html, { headings: true, anchors: true });
  const i = flat.indexOf(needle);
  if (i >= 0) {
    const rawStart = spans[i].rawStart, rawEnd = spans[i + needle.length - 1].rawEnd;
    const inner = html.slice(rawStart, rawEnd);
    // Never wrap across a block boundary, heading, or existing link (inline tags like <strong> are fine).
    if (/<\/?(?:p|h[1-6]|ul|ol|li|blockquote|div|figure|a)\b/i.test(inner)) return { reason: "the anchor spans across paragraphs/formatting" };
    return { rawStart, rawEnd };
  }
  // Couldn't place in body prose — narrow down why by relaxing each exclusion.
  if (!flatten(html, {}).flat.includes(needle)) return { reason: "the anchor phrase is no longer in the post body (it may have been edited)" };
  if (!flatten(html, { headings: true }).flat.includes(needle)) return { reason: "the anchor phrase only appears in a heading (headings aren't linked)" };
  if (!flatten(html, { anchors: true }).flat.includes(needle)) return { reason: "the anchor phrase is already a link in the post" };
  return { reason: "the anchor phrase spans across formatting" };
}

// Wrap the FIRST linkable occurrence of `anchor` in a link, or null if it can't be placed.
export function wrapAnchor(html: string, anchor: string, slug: string): string | null {
  const p = anchorPlacement(html, anchor);
  if ("reason" in p) return null;
  return `${html.slice(0, p.rawStart)}<a href="${postHref(slug)}">${html.slice(p.rawStart, p.rawEnd)}</a>${html.slice(p.rawEnd)}`;
}

// True if the anchor phrase is ALREADY hyperlinked to the target post (the cross-link effectively
// exists — e.g. an episode-list item whose domain name already links to that post). We then treat
// the opportunity as done rather than erroring or double-linking.
export function alreadyLinkedToTarget(html: string, anchor: string, targetSlug: string): boolean {
  const slug = String(targetSlug || "").trim();
  if (!slug) return false;
  const needle = String(anchor || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) return false;
  const { flat, spans } = flatten(html, {}); // include existing-link text
  const i = flat.indexOf(needle);
  if (i < 0) return false;
  const rawStart = spans[i].rawStart, rawEnd = spans[i + needle.length - 1].rawEnd;
  const region = html.slice(Math.max(0, rawStart - 240), rawEnd + 40); // catch an <a> opening just before the phrase
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`href=["'][^"']*/post/${esc}`, "i").test(region);
}

// Re-point an EXISTING link whose visible text is exactly the anchor to our internal target post.
// Only repoints a NON-internal link (an external/other href) — never hijacks an existing /post/
// cross-link. Returns the rewritten html, or null if there's no such repointable link.
export function repointAnchorLink(html: string, anchor: string, slug: string): string | null {
  const want = String(anchor || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!want || !slug) return null;
  const target = postHref(slug);
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const innerText = decodeEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().toLowerCase();
    if (innerText !== want) continue;
    const openEnd = m[0].indexOf(">") + 1;
    const openTag = m[0].slice(0, openEnd);
    const cur = openTag.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    if (/\/post\//i.test(cur)) return null;                 // already an internal cross-link — leave it
    const newOpen = /\bhref\s*=\s*["'][^"']*["']/i.test(openTag)
      ? openTag.replace(/\bhref\s*=\s*["'][^"']*["']/i, `href="${target}"`)
      : openTag.replace(/^<a\b/i, `<a href="${target}"`);
    return html.slice(0, m.index) + newOpen + m[2] + "</a>" + html.slice(m.index + m[0].length);
  }
  return null;
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
  const hint = String(insertAfter || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (hint) {
    // Locate the hint via the same normalized view (it's decoded heading/paragraph text), then
    // insert after the block it lives in. Fall back to a raw search, then to the first block.
    const { flat, spans } = flatten(html, {});
    const fi = flat.indexOf(hint);
    const rawAt = fi >= 0 ? spans[fi + hint.length - 1].rawEnd : html.toLowerCase().indexOf(hint);
    if (rawAt >= 0) { closeRe.lastIndex = rawAt; const m = closeRe.exec(html); if (m) pos = m.index + m[0].length; }
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

export type ApplyResult = { ok: boolean; error?: string; published?: boolean; preview?: string; alreadyLinked?: boolean; dismissed?: boolean; repointed?: boolean };

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

  const rw = computeRewrite(opp, html);
  if (rw.kind === "linked") {
    await getDb().from(LINKS).update({ status: "inserted" }).eq("id", id);
    return { ok: true, published: false, alreadyLinked: true };
  }
  if (rw.kind === "fail") {
    // A structural fail (already a link / only in a heading / spans formatting / edited out) can
    // never be auto-inserted — hide the row instead of leaving a red error the user keeps hitting.
    if (!opts.dryRun) await getDb().from(LINKS).update({ status: "dismissed" }).eq("id", id);
    return { ok: false, error: `Not placeable — ${rw.reason}. Hidden from the list.`, dismissed: true };
  }
  if (opts.dryRun) return { ok: true, preview: rw.html };

  const upd = await updateItem(collectionId, opp.source_id, { [bodySlug]: rw.html }, { live: false });
  if (!upd.ok) return { ok: false, error: upd.error || "Webflow update failed" };
  let published = false;
  if (opts.publish) { const p = await publishItems(collectionId, [opp.source_id]); published = p.ok; }
  await getDb().from(LINKS).update({ status: "inserted" }).eq("id", id);
  return { ok: true, published, repointed: rw.repoint };
}

// Pure decision for one opportunity against a body: already-linked / a new html / a failure reason.
type Opp = { kind?: string | null; anchor?: string | null; new_sentence?: string | null; context?: string | null; target_slug?: string | null };
type Rewrite = { kind: "linked" } | { kind: "html"; html: string; repoint?: boolean } | { kind: "fail"; reason: string };
function computeRewrite(opp: Opp, html: string): Rewrite {
  if (opp.kind === "add_sentence") {
    const rewritten = insertSentence(html, opp.new_sentence || "", opp.anchor || "", opp.context || "", opp.target_slug || "");
    if (rewritten == null || rewritten === html) return { kind: "fail", reason: "could not build the new sentence" };
    return { kind: "html", html: rewritten };
  }
  // anchor kind:
  if (alreadyLinkedToTarget(html, opp.anchor || "", opp.target_slug || "")) return { kind: "linked" };
  const wrapped = wrapAnchor(html, opp.anchor || "", opp.target_slug || "");
  if (wrapped && wrapped !== html) return { kind: "html", html: wrapped };
  // No unlinked occurrence in body prose — if the phrase is an existing (non-internal) link, repoint it.
  const repointed = repointAnchorLink(html, opp.anchor || "", opp.target_slug || "");
  if (repointed && repointed !== html) return { kind: "html", html: repointed, repoint: true };
  const p = anchorPlacement(html, opp.anchor || "");
  return { kind: "fail", reason: "reason" in p ? p.reason : "couldn't place the link" };
}

export type BulkResult = { id: string; ok: boolean; published?: boolean; alreadyLinked?: boolean; dismissed?: boolean; repointed?: boolean; error?: string };

// Insert MANY opportunities at once. Groups by source post so multiple links into the same post are
// applied to ONE body and written/published once (avoids read-modify-write clobbering). publish=true
// pushes each touched post live. Order within a post follows the requested id order.
export async function applyCrosslinksBulk(ids: string[], opts: { publish: boolean }): Promise<{ ok: boolean; error?: string; results: BulkResult[] }> {
  if (!webflowConfigured()) return { ok: false, error: "Webflow not configured", results: [] };
  if (!webflowCanWrite()) return { ok: false, error: "Webflow token is read-only", results: [] };
  const collectionId = process.env.WEBFLOW_BLOG_POSTS_ID;
  if (!collectionId) return { ok: false, error: "WEBFLOW_BLOG_POSTS_ID not set", results: [] };
  const uniq = [...new Set(ids)].slice(0, 200); // safety cap for the 300s function budget
  if (!uniq.length) return { ok: true, results: [] };

  const { data } = await getDb().from(LINKS).select("*").in("id", uniq);
  const byId = new Map((data as Record<string, unknown>[] || []).map((o) => [o.id as string, o]));
  const coll = await getCollection(collectionId);
  const fields = coll.data?.fields || [];

  // Group requested ids by source post, preserving order; skip missing / already-inserted.
  const groups = new Map<string, string[]>();
  for (const id of uniq) {
    const o = byId.get(id) as { source_id?: string; status?: string } | undefined;
    if (!o || o.status === "inserted") continue;
    const arr = groups.get(o.source_id!) || [];
    arr.push(id); groups.set(o.source_id!, arr);
  }

  const results: BulkResult[] = [];
  for (const [sourceId, groupIds] of groups) {
    const item = await getItem(collectionId, sourceId);
    const fieldData = item.data?.fieldData || {};
    if (!item.ok || !item.data) { for (const id of groupIds) results.push({ id, ok: false, error: item.error || "could not load post" }); continue; }
    const bodySlug = resolveBodySlug(fields, fieldData);
    if (!bodySlug) { for (const id of groupIds) results.push({ id, ok: false, error: "could not find the post body field" }); continue; }
    let html = String(fieldData[bodySlug] || "");
    const newlyInserted: string[] = [], linked: string[] = [], unplaceable: string[] = [];
    for (const id of groupIds) {
      const rw = computeRewrite(byId.get(id) as Opp, html);
      if (rw.kind === "linked") { linked.push(id); results.push({ id, ok: true, alreadyLinked: true }); }
      else if (rw.kind === "html") { html = rw.html; newlyInserted.push(id); results.push({ id, ok: true, repointed: rw.repoint }); }
      else { unplaceable.push(id); results.push({ id, ok: false, dismissed: true, error: rw.reason }); }
    }
    if (unplaceable.length) await getDb().from(LINKS).update({ status: "dismissed" }).in("id", unplaceable);
    let published = false;
    if (newlyInserted.length) {
      const upd = await updateItem(collectionId, sourceId, { [bodySlug]: html }, { live: false });
      if (!upd.ok) {
        for (const id of newlyInserted) { const r = results.find((x) => x.id === id)!; r.ok = false; r.error = upd.error || "Webflow update failed"; }
        // keep any already-linked rows as done below
      } else if (opts.publish) {
        published = (await publishItems(collectionId, [sourceId])).ok;
        for (const id of newlyInserted) { const r = results.find((x) => x.id === id)!; r.published = published; }
      }
    }
    const done = [...linked, ...newlyInserted.filter((id) => results.find((x) => x.id === id)!.ok)];
    if (done.length) await getDb().from(LINKS).update({ status: "inserted" }).in("id", done);
  }
  // Ids that weren't in any group (missing/already-inserted) — report them as skipped no-ops.
  for (const id of uniq) if (!results.find((r) => r.id === id)) results.push({ id, ok: true, alreadyLinked: false });
  return { ok: true, results };
}
