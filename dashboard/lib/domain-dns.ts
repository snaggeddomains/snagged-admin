// Live per-domain lookups for the SNAP Names report: current registrar (RDAP) +
// authoritative nameservers (DNS) + a friendly "where the NS point" provider label.
// Node runtime only. Every call is fail-open (returns nulls, never throws) and
// results are memoized in-process with a TTL so a warm instance answers repeats
// instantly. The client also caches per-domain in localStorage.

import { promises as dns } from "node:dns";

export interface DomainLive {
  registrar: string | null;
  nameservers: string[];
  ns_provider: string | null; // friendly label for where the NS point (Cloudflare, Dan, GoDaddy DNS…)
  checked_at: string;
}

// NS-suffix → friendly provider. Mirrors the research app's GENERIC_NS map so the
// two stay consistent. Marketplace/parking hosts are flagged as such.
const NS_PROVIDER: Record<string, string> = {
  "cloudflare.com": "Cloudflare",
  "afternic.com": "Afternic (marketplace)",
  "sedoparking.com": "Sedo parking",
  "sedo.com": "Sedo",
  "bodis.com": "Bodis parking",
  "parkingcrew.net": "ParkingCrew",
  "above.com": "Above/Trellian parking",
  "dan.com": "Dan marketplace",
  "undeveloped.com": "Dan/Undeveloped",
  "fabulous.com": "Fabulous parking",
  "hugedomains.com": "HugeDomains",
  "voodoo.com": "Voodoo parking",
  "domaincontrol.com": "GoDaddy DNS",
  "registrar-servers.com": "Namecheap DNS",
  "dnsowl.com": "Namecheap/Hostinger DNS",
  "sav.com": "Sav",
  "name.com": "Name.com DNS",
  "spaceship.net": "Spaceship DNS",
  "spaceship.com": "Spaceship DNS",
  "dynadot.com": "Dynadot DNS",
  "porkbun.com": "Porkbun DNS",
  "awsdns": "AWS Route 53",
  "googledomains.com": "Google Domains DNS",
  "google.com": "Google Cloud DNS",
  "nsone.net": "NS1",
  "vercel-dns.com": "Vercel DNS",
  "digitalocean.com": "DigitalOcean DNS",
  "azure-dns": "Azure DNS",
  "wixdns.net": "Wix DNS",
  "squarespacedns.com": "Squarespace DNS",
  "shopify.com": "Shopify",
  "ui-dns": "IONOS DNS",
  "efty.com": "Efty",
  "atom.com": "Atom (marketplace)",
  "hostinger.com": "Hostinger DNS",
};

function providerFor(nameservers: string[]): string | null {
  const ns = nameservers.map((n) => n.toLowerCase());
  for (const [suf, label] of Object.entries(NS_PROVIDER)) {
    if (ns.some((n) => n === suf || n.endsWith("." + suf) || n.includes(suf))) return label;
  }
  // Fall back to the registrable NS domain (e.g. ns1.EXAMPLE.com → example.com).
  const first = ns[0];
  if (first) {
    const parts = first.split(".").filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join(".");
  }
  return null;
}

// ── RDAP bootstrap (tld → RDAP base URL), cached ────────────────────────────
let bootstrap: Map<string, string> | null = null;
let bootstrapAt = 0;
// ccTLDs that run RDAP but aren't always in IANA's bootstrap.
const CCTLD_RDAP: Record<string, string> = {
  io: "https://rdap.identitydigital.services/rdap/",
  sh: "https://rdap.identitydigital.services/rdap/",
  ac: "https://rdap.identitydigital.services/rdap/",
  co: "https://rdap.nic.co/",
  vc: "https://rdap.identitydigital.services/rdap/",
};

async function rdapBaseFor(tld: string): Promise<string | null> {
  const now = Date.now();
  if (!bootstrap || now - bootstrapAt > 24 * 3600 * 1000) {
    try {
      const res = await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(8000) });
      const j = (await res.json()) as { services?: [string[], string[]][] };
      const map = new Map<string, string>();
      for (const [tlds, urls] of j.services || []) {
        const base = (urls || []).find((u) => u.startsWith("https://")) || urls?.[0];
        if (!base) continue;
        for (const t of tlds) map.set(t.toLowerCase(), base.endsWith("/") ? base : base + "/");
      }
      bootstrap = map;
      bootstrapAt = now;
    } catch {
      if (!bootstrap) bootstrap = new Map();
    }
  }
  return bootstrap.get(tld) || CCTLD_RDAP[tld] || null;
}

function registrarFromRdap(j: unknown): string | null {
  const obj = j as { entities?: Array<{ roles?: string[]; vcardArray?: unknown; publicIds?: Array<{ type?: string; identifier?: string }> }> };
  const ents = obj?.entities || [];
  for (const e of ents) {
    if (!(e.roles || []).map((r) => r.toLowerCase()).includes("registrar")) continue;
    // vcardArray: ["vcard", [ ["fn", {}, "text", "GoDaddy.com, LLC"], ... ]]
    const vc = Array.isArray(e.vcardArray) ? (e.vcardArray[1] as unknown[]) : null;
    if (Array.isArray(vc)) {
      const fn = vc.find((f) => Array.isArray(f) && (f as unknown[])[0] === "fn") as unknown[] | undefined;
      if (fn && typeof fn[3] === "string" && fn[3].trim()) return fn[3].trim();
    }
  }
  return null;
}

async function rdapRegistrar(domain: string): Promise<string | null> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  const base = await rdapBaseFor(tld);
  if (!base) return null;
  try {
    const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    return registrarFromRdap(await res.json());
  } catch {
    return null;
  }
}

async function resolveNs(domain: string): Promise<string[]> {
  try {
    const ns = await dns.resolveNs(domain);
    return [...new Set(ns.map((n) => n.toLowerCase()))].sort();
  } catch {
    return [];
  }
}

// ── memoized single-domain resolve ──────────────────────────────────────────
const CACHE = new Map<string, DomainLive>();
const TTL = 6 * 3600 * 1000;

export async function resolveDomainLive(domain: string): Promise<DomainLive> {
  const d = domain.trim().toLowerCase();
  const hit = CACHE.get(d);
  if (hit && Date.now() - Date.parse(hit.checked_at) < TTL) return hit;
  const [registrar, nameservers] = await Promise.all([rdapRegistrar(d), resolveNs(d)]);
  const info: DomainLive = {
    registrar,
    nameservers,
    ns_provider: providerFor(nameservers),
    checked_at: new Date().toISOString(),
  };
  CACHE.set(d, info);
  return info;
}

// Resolve many with bounded concurrency. Returns a map keyed by domain.
export async function resolveMany(domains: string[], concurrency = 8): Promise<Record<string, DomainLive>> {
  const out: Record<string, DomainLive> = {};
  const queue = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const d = queue[i++];
      out[d] = await resolveDomainLive(d);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
