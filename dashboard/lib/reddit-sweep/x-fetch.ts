// X (Twitter) v2 recent-search fetch for the domain-opportunity sweep. App-only auth:
// prefer a stored X_BEARER_TOKEN, else mint one from X_API_KEY + X_API_SECRET via the
// OAuth2 client-credentials endpoint (cached in-process). Recent search requires the
// Basic tier or higher — Free returns 403.

const UA = "snagged-admin/1.0 (domain opportunity sweep; +https://snagged.com)";
const SEARCH = "https://api.twitter.com/2/tweets/search/recent";
const TOKEN_URL = "https://api.twitter.com/oauth2/token";

export type XPost = {
  source: string; // the query that surfaced it
  title: string; // tweet text (first line)
  link: string; // https://x.com/<user>/status/<id>
  author: string; // @username
  published: string | null;
  content: string; // full tweet text
};

// High-intent domain-acquisition queries (buy-side leans; -is:retweet, English). Kept
// small — recent search is rate-limited (Basic: 60 req / 15 min, app-auth).
export function xQueries(): string[] {
  const env = (process.env.X_SWEEP_QUERIES || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  return [
    `("good domain broker" OR "best domain broker" OR "reliable domain broker" OR "recommend a domain broker" OR "need a domain broker" OR "looking for a domain broker") -is:retweet lang:en`,
    `("buy this domain" OR "acquire this domain" OR "buy the domain") (startup OR company OR brand OR business) -is:retweet lang:en`,
    `("owner not responding" OR "can't contact the owner") (domain OR ".com") -is:retweet lang:en`,
    `("looking to acquire" OR "trying to buy") (".com" OR "the domain") -is:retweet lang:en`,
    `("domain is taken" OR ".com is taken" OR "the .com is taken") -is:retweet lang:en`,
    `("rebranding our" OR "renaming our" OR "new name for our") (startup OR company OR brand) -is:retweet lang:en`,
  ];
}

let cachedBearer: { token: string; exp: number } | null = null;

async function bearer(): Promise<string | null> {
  const direct = process.env.X_BEARER_TOKEN;
  if (direct) return direct;
  const now = Date.now();
  if (cachedBearer && cachedBearer.exp > now) return cachedBearer.token;
  const key = process.env.X_API_KEY, secret = process.env.X_API_SECRET;
  if (!key || !secret) return null;
  const basic = Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": UA },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`X token HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("X token: no access_token");
  cachedBearer = { token: j.access_token, exp: now + 90 * 60_000 }; // app tokens are long-lived; re-mint hourly-ish
  return j.access_token;
}

/** One recent-search query → posts. Throws on auth/tier/HTTP error so the caller buckets it. */
export async function searchX(query: string): Promise<XPost[]> {
  const token = await bearer();
  if (!token) throw new Error("X not configured (need X_BEARER_TOKEN or X_API_KEY+X_API_SECRET)");
  const url = `${SEARCH}?query=${encodeURIComponent(query)}&max_results=25` +
    `&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let body: { data?: unknown[]; includes?: { users?: unknown[] } };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, "user-agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`X search HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(t);
  }
  const users = new Map<string, string>();
  for (const u of body.includes?.users || []) {
    const uu = u as { id?: string; username?: string };
    if (uu.id && uu.username) users.set(uu.id, uu.username);
  }
  const out: XPost[] = [];
  for (const d of body.data || []) {
    const tw = d as { id?: string; text?: string; author_id?: string; created_at?: string };
    if (!tw.id) continue;
    const username = tw.author_id ? users.get(tw.author_id) || "" : "";
    const text = String(tw.text || "").replace(/\s+/g, " ").trim();
    out.push({
      source: query,
      title: text.slice(0, 140),
      link: `https://x.com/${username || "i"}/status/${tw.id}`,
      author: username ? `@${username}` : "",
      published: tw.created_at || null,
      content: text,
    });
  }
  return out;
}
