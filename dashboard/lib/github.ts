// Minimal GitHub Contents API client. Reads files and directory listings
// from snaggeddomains/snagged-admin@main. Requires GITHUB_TOKEN env var
// (fine-grained PAT with read access to the repo).
//
// All reads are revalidated every 60 seconds — the source state files
// update at most every few minutes when sources run, so this is plenty.

const OWNER = "snaggeddomains";
const REPO = "snagged-admin";
const REF = "main";
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;
const REVALIDATE_SEC = 60;

function authHeaders(): HeadersInit | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

// A transient GitHub blip (secondary rate-limit 403/429, a 5xx, or a dropped
// connection) must NOT take down the whole page — every admin surface reads its
// config/status through here at render time, so a single failed fetch used to
// bubble up as a full "server-side exception". We retry briefly to absorb a
// momentary blip, then DEGRADE (return null) so callers render an empty/unknown
// state instead of crashing. The 60s revalidate self-heals once GitHub recovers.
// A 404 (missing file) is a normal, non-error null.
const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 800];

async function ghFetch(path: string, accept: string): Promise<Response | null> {
  const headers = authHeaders();
  if (!headers) return null;
  const url = `${BASE}/${path}?ref=${REF}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, Accept: accept },
        next: { revalidate: REVALIDATE_SEC },
      });
      if (res.ok || res.status === 404) return res;
      if (RETRY_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      // Persistent non-ok — log and degrade rather than crash the page.
      console.error(`[github] ${res.status} for ${path} (degrading to empty)`);
      return null;
    } catch (e) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      console.error(`[github] fetch failed for ${path} (degrading to empty):`, e);
      return null;
    }
  }
}

/** Fetch a single file's raw contents. Returns null on 404, no token, or a
 *  persistent GitHub error (degrades so a blip can't crash the admin page). */
export async function getFile(path: string): Promise<string | null> {
  const res = await ghFetch(path, "application/vnd.github.v3.raw");
  if (!res || res.status === 404) return null;
  return res.text();
}

/** List directory contents. Returns [] on 404, no token, or a persistent error. */
export async function listDirectory(
  path: string,
): Promise<Array<{ name: string; type: "file" | "dir" }>> {
  const res = await ghFetch(path, "application/vnd.github.v3+json");
  if (!res || res.status === 404) return [];
  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items
    .filter((i) => i.type === "file" || i.type === "dir")
    .map((i) => ({ name: i.name, type: i.type as "file" | "dir" }));
}
