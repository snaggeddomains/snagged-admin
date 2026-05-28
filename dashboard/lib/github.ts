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

/** Fetch a single file's raw contents. Returns null if 404 or no token. */
export async function getFile(path: string): Promise<string | null> {
  const headers = authHeaders();
  if (!headers) return null;

  const url = `${BASE}/${path}?ref=${REF}`;
  const res = await fetch(url, {
    headers: { ...headers, Accept: "application/vnd.github.v3.raw" },
    next: { revalidate: REVALIDATE_SEC },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub Contents API ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.text();
}

/** List directory contents. Returns array of {name, type}. */
export async function listDirectory(
  path: string,
): Promise<Array<{ name: string; type: "file" | "dir" }>> {
  const headers = authHeaders();
  if (!headers) return [];

  const url = `${BASE}/${path}?ref=${REF}`;
  const res = await fetch(url, {
    headers: { ...headers, Accept: "application/vnd.github.v3+json" },
    next: { revalidate: REVALIDATE_SEC },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub Contents API ${res.status} for ${path}: ${await res.text()}`);
  }
  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items
    .filter((i) => i.type === "file" || i.type === "dir")
    .map((i) => ({ name: i.name, type: i.type as "file" | "dir" }));
}
