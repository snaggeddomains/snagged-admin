// Voice profile for the reply drafter — pulls Rob's actual writing from the snagged.com
// blog (posts live at /post/<slug>, listed in the sitemap) so drafts match his tone,
// cadence, and recurring viewpoints. Fetches a sample of posts, excerpts each, caps the
// total, and caches in-process. Fail-open → "" (drafts still work, less voice-grounded).

const SITEMAP = "https://www.snagged.com/sitemap.xml";
const UA = "Mozilla/5.0 (compatible; SnaggedVoice/1.0; +https://snagged.com)";
const MAX_POSTS = 14; // how many blog posts to sample
const PER_POST = 850; // chars of each post to keep
const TOTAL_CAP = 12000; // total voice-profile chars injected
const TTL_MS = 12 * 60 * 60 * 1000; // 12h in-process cache

let cache: { text: string; exp: number } | null = null;

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&#8217;": "'", "&#8216;": "'", "&#8220;": '"', "&#8221;": '"', "&#8211;": "-", "&#8212;": "-", "&hellip;": "..." };
function decode(s: string): string {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ""; } })
    .replace(/&[a-z]+;/gi, (m) => ENT[m] || m);
}
function stripHtml(s: string): string {
  return decode(String(s || "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function get(url: string, timeout = 15000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml" }, signal: ctrl.signal });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function postUrls(): Promise<string[]> {
  const xml = await get(SITEMAP);
  if (!xml) return [];
  const locs = (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map((m) => m.replace(/<\/?loc>/gi, "").trim());
  return locs.filter((u) => /\/post\//i.test(u));
}

// The article prose, skipping the site nav + byline chrome.
function articleExcerpt(html: string): string {
  let text = stripHtml(html);
  if (text.length < 400) return "";
  // Anchor past the repeated nav ("... Back to All Blog Posts <category> <title>").
  const nav = text.lastIndexOf("Back to All Blog Posts");
  if (nav >= 0) text = text.slice(nav + "Back to All Blog Posts".length);
  // Skip a "Written by: Name <date>" byline if present.
  text = text.replace(/^[\s\S]{0,120}?Written by:[^0-9]*\d{4}\s*/i, "").trim();
  if (text.length < 200) return "";
  return text.slice(0, PER_POST);
}

/** Distilled excerpts of Rob's blog writing (cached). "" if the blog can't be read. */
export async function blogVoiceProfile(): Promise<string> {
  if (cache && cache.exp > Date.now()) return cache.text;
  const urls = await postUrls();
  if (!urls.length) { cache = { text: "", exp: Date.now() + 30 * 60 * 1000 }; return ""; }
  // Sample across the archive (every Nth) so the voice isn't skewed to one topic.
  const step = Math.max(1, Math.floor(urls.length / MAX_POSTS));
  const picked: string[] = [];
  for (let i = 0; i < urls.length && picked.length < MAX_POSTS; i += step) picked.push(urls[i]);

  const parts: string[] = [];
  let total = 0;
  // Bounded concurrency over the sampled posts.
  const results = await Promise.all(picked.map(async (u) => {
    const html = await get(u, 12000);
    const title = decode((html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").replace(/\s*[|·-]\s*Snagged.*$/i, "").trim());
    return { title, excerpt: articleExcerpt(html) };
  }));
  for (const r of results) {
    if (!r.excerpt) continue;
    const block = `# ${r.title}\n${r.excerpt}`;
    if (total + block.length > TOTAL_CAP) break;
    parts.push(block);
    total += block.length;
  }
  const text = parts.join("\n\n");
  cache = { text, exp: Date.now() + (text ? TTL_MS : 30 * 60 * 1000) };
  return text;
}
