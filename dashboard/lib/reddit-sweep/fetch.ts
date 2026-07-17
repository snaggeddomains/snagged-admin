// Reddit RSS fetch + Atom parse (spec §5.2/5.4/5.5). Reads /new/.rss?limit=25 per
// subreddit — lightweight, no auth. Reddit's Atom is very regular, so a per-<entry>
// regex extraction is sufficient (no XML dependency). A fetch/parse failure throws so
// the caller can bucket the subreddit as feed-error.

const UA = "snagged-admin/1.0 (domain opportunity sweep; +https://snagged.com)";
const LIMIT = 25;

export type RedditPost = {
  subreddit: string;
  title: string;
  link: string;
  author: string;
  published: string | null; // ISO
  content: string; // cleaned snippet
};

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
function decode(s: string): string {
  return String(s || "")
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => ENT[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripTags(s: string): string {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function tag(entry: string, name: string): string {
  const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// Reddit IP-blocks cloud/datacenter egress (403 from Vercel + this sandbox), so when
// SCRAPE_DO_TOKEN is set we route through scrape.do's residential super-proxy — the
// SAME mechanism namepros_marketplace.py uses for NamePros/Oxley. Without a token we
// try direct (works only from an allowed IP).
function proxied(target: string): string {
  const token = process.env.SCRAPE_DO_TOKEN;
  if (!token) return target;
  return `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(target)}&super=true&geoCode=us`;
}

export async function fetchSubreddit(sub: string): Promise<RedditPost[]> {
  const target = `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss?limit=${LIMIT}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let xml: string;
  try {
    const res = await fetch(proxied(target), { headers: { "user-agent": UA, accept: "application/atom+xml, application/xml, text/xml" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(t);
  }
  const posts: RedditPost[] = [];
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const e of entries) {
    const title = stripTags(tag(e, "title"));
    const linkMatch = e.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? decode(linkMatch[1]) : "";
    if (!link) continue;
    // Reddit author is <author><name>/u/username</name>...
    const author = stripTags(tag(e, "name")).replace(/^\/u\//, "");
    const published = (tag(e, "published") || tag(e, "updated")).trim() || null;
    const content = stripTags(tag(e, "content"));
    posts.push({ subreddit: sub, title, link, author, published: published ? published.slice(0, 25) : null, content });
  }
  return posts;
}
