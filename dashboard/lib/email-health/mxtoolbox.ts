// MXToolbox API v1 client — https://mxtoolbox.com/api/api-reference
// Read-only email-deliverability checks for our sending domains (MX / SPF / DKIM / DMARC /
// blacklist / DNS health). Dependency-free, mirrors the shape of lib/webflow.ts: every call
// returns {ok,status,data,error} so nothing throws, and it's fail-open when unconfigured.
//
// Auth: MXTOOLBOX_API_KEY (a plain UUID) sent as the `Authorization` header (NO "Bearer").
// Quotas reset daily 00:00 UTC. DNS commands consume DnsRequests; network commands (blacklist,
// http, smtp, …) consume NetworkRequests — the FREE plan has 0 network requests, so blacklist
// needs a paid key (a 429/quota there degrades to "unavailable", never an error).

const BASE = "https://api.mxtoolbox.com/api/v1";

export function mxtoolboxConfigured(): boolean {
  return Boolean(process.env.MXTOOLBOX_API_KEY);
}

// One MXToolbox Lookup result array item (Failed / Warnings / Passed / Timeouts).
export type MxItem = { ID?: number; Name?: string; Info?: string; Url?: string };
export type MxLookup = {
  UID?: string;
  Command?: string;
  CommandArgument?: string;
  TimeRecorded?: string;
  ReportingNameServer?: string;
  Failed?: MxItem[];
  Warnings?: MxItem[];
  Passed?: MxItem[];
  Timeouts?: MxItem[];
  Information?: Record<string, unknown>[];
};
export type MxResult<T = MxLookup> = { ok: boolean; status: number; data: T | null; error: string | null };

// Low-level GET. Retries once on 429 (quota/rate) honoring a short backoff. Never throws.
async function mx<T = MxLookup>(path: string, attempt = 0): Promise<MxResult<T>> {
  const key = process.env.MXTOOLBOX_API_KEY;
  if (!key) return { ok: false, status: 0, data: null, error: "MXTOOLBOX_API_KEY not set" };
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { Authorization: key, accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return mx<T>(path, attempt + 1);
    }
    const text = await res.text();
    let data: T | null = null;
    try { data = text ? (JSON.parse(text) as T) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = res.status === 429 ? "quota exceeded (429)"
        : res.status === 401 ? "invalid API key (401)"
        : `HTTP ${res.status}`;
      return { ok: false, status: res.status, data, error: msg };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String((e as Error)?.message || e) };
  }
}

// A Lookup by command. `argument` is the domain/IP (for DKIM it's `domain:selector`).
export function lookup(command: string, argument: string): Promise<MxResult> {
  return mx(`/Lookup/${encodeURIComponent(command)}/?argument=${encodeURIComponent(argument)}`);
}

export const mxLookup = {
  mx: (domain: string) => lookup("mx", domain),
  spf: (domain: string) => lookup("spf", domain),
  dkim: (domain: string, selector: string) => lookup("dkim", `${domain}:${selector}`),
  dmarc: (domain: string) => lookup("dmarc", domain),
  dns: (domain: string) => lookup("dns", domain),
  blacklist: (domain: string) => lookup("blacklist", domain),
};

// Current quota consumption — DnsRequests/DnsMax, NetworkRequests/NetworkMax.
export type MxUsage = { DnsRequests?: number; DnsMax?: number; NetworkRequests?: number; NetworkMax?: number };
export function usage(): Promise<MxResult<MxUsage>> {
  return mx<MxUsage>("/Usage");
}
