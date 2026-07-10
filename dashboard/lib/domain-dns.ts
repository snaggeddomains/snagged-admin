// Live per-domain lookups for the SNAP Names report: current registrar (RDAP) +
// authoritative nameservers (DNS) + a friendly "where the NS point" provider label.
// Node runtime only. Every call is fail-open (returns nulls, never throws) and
// results are memoized in-process with a TTL so a warm instance answers repeats
// instantly. The client also caches per-domain in localStorage.

import { promises as dns } from "node:dns";
import net from "node:net";

export interface DomainLive {
  registrar: string | null;
  nameservers: string[];
  ns_provider: string | null; // friendly label for where the NS point (Cloudflare, Dan, GoDaddy DNS…)
  // Live marketplace listing scrapes (fail-open → null = couldn't determine):
  afternic: { listed: boolean; price: number | null } | null; // afternic.com (NS-independent)
  spaceship_price: number | null; // Spaceship buy-now (from the domain's DOMAIN_CONFIG lander)
  spaceship_min_offer: number | null; // Spaceship minimum-offer floor (no firm buy-now)
  checked_at: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function fetchText(url: string, timeoutMs = 7000, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Afternic BIN — NS-independent (Afternic's fast-transfer network lists a name even
// when its nameservers point elsewhere). The forsale lander embeds isForSale + the
// buyNow price in micros. Mirrors the research app's proven scraper.
async function afternicBin(domain: string): Promise<{ listed: boolean; price: number | null } | null> {
  const body = await fetchText(`https://www.afternic.com/domain/${domain}`);
  if (body == null) return null;
  const forSale = /"isForSale":\s*true/.test(body);
  if (!forSale) return { listed: false, price: null };
  const m = body.match(/"buyNow":\s*(\d{6,})/);
  const price = m ? Math.round(Number(m[1]) / 1e6) : null;
  return { listed: true, price: price && price >= 100 && price <= 5_000_000 ? price : null };
}

// Spaceship lander — served in-place on the domain when its NS point to Spaceship.
// window.DOMAIN_CONFIG carries the authoritative terms: a firm buy-now (ltoConfig
// totalPrice / buy-it-now) vs a minimum-offer floor. Mirrors research parseSpaceship.
function parseSpaceship(body: string): { price: number | null; min_offer: number | null } | null {
  if (!/DOMAIN_CONFIG/.test(body) || !/spaceship/i.test(body)) return null;
  const money = (s: string | undefined): number | null => {
    if (!s) return null;
    const n = Number(String(s).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n >= 100 && n <= 5_000_000 ? Math.round(n) : null;
  };
  const bool = (k: string): boolean | null => {
    const m = body.match(new RegExp(k + "\\s*:\\s*(true|false)"));
    return m ? m[1] === "true" : null;
  };
  const buyNow = money((body.match(/totalPrice:\s*'([^']+)'/) || [])[1]);
  const minOffer =
    money((body.match(/minOfferPrice:\s*parseFloat\('([\d.]+)'\)/) || body.match(/minOfferPrice:\s*'?([\d.]+)'?/) || [])[1]) ||
    money((body.match(/formattedMinOfferPrice:\s*'([^']+)'/) || [])[1]);
  if (buyNow) return { price: buyNow, min_offer: null };
  if (bool("offerEnabled") && minOffer) return { price: null, min_offer: minOffer };
  if (minOffer) return { price: null, min_offer: minOffer };
  return { price: null, min_offer: null };
}

async function spaceshipListing(domain: string): Promise<{ price: number | null; min_offer: number | null } | null> {
  for (const url of [`https://${domain}`, `http://${domain}`]) {
    const body = await fetchText(url, 7000);
    if (body == null) continue;
    const parsed = parseSpaceship(body);
    if (parsed) return parsed;
    return null; // resolved a page but it's not a Spaceship lander
  }
  return null;
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
// ccTLDs that run RDAP but aren't always in IANA's bootstrap (all Identity Digital).
// NOTE: some ccTLDs (e.g. .co) publish NO reachable public RDAP at all — their
// registrar simply can't be read this way, so the column shows "—" for them.
const CCTLD_RDAP: Record<string, string> = {
  io: "https://rdap.identitydigital.services/rdap/",
  sh: "https://rdap.identitydigital.services/rdap/",
  ac: "https://rdap.identitydigital.services/rdap/",
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

// ── WHOIS (port 43) fallback for TLDs with NO working RDAP ───────────────────
// .co (CentralNic) publishes no RDAP domain objects — its registrar is only on
// port-43 WHOIS. Node serverless (Vercel) can open a raw TCP socket, so we fall
// back to WHOIS for these. NOTE: this sandbox/proxy blocks port 43, so this path
// is exercised in PRODUCTION only.
const WHOIS_SERVER: Record<string, string> = {
  co: "whois.registry.co",
};

function whoisQuery(host: string, query: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const socket = net.createConnection(43, host);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(query + "\r\n"));
    socket.on("data", (b) => {
      data += b.toString("utf8");
    });
    socket.on("end", () => finish(data || null));
    socket.on("timeout", () => finish(data || null));
    socket.on("error", () => finish(null));
  });
}

function registrarFromWhois(text: string | null): string | null {
  if (!text) return null;
  // ICANN-standard WHOIS: a "Registrar:" line with the colon right after the word
  // (so it doesn't match "Registrar URL / WHOIS Server / IANA ID / Abuse ...").
  const m = text.match(/^\s*Registrar:\s*(.+?)\s*$/im) || text.match(/^\s*Sponsoring Registrar:\s*(.+?)\s*$/im);
  const name = m && m[1] ? m[1].trim() : "";
  return name && !/^whois\b/i.test(name) ? name : null;
}

async function whoisRegistrar(domain: string): Promise<string | null> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  const server = WHOIS_SERVER[tld];
  if (!server) return null;
  try {
    return registrarFromWhois(await whoisQuery(server, domain));
  } catch {
    return null;
  }
}

// Registrar via RDAP, falling back to port-43 WHOIS for no-RDAP TLDs (.co).
async function lookupRegistrar(domain: string): Promise<string | null> {
  const viaRdap = await rdapRegistrar(domain);
  if (viaRdap) return viaRdap;
  return whoisRegistrar(domain);
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
  const [registrar, nameservers, afternic] = await Promise.all([lookupRegistrar(d), resolveNs(d), afternicBin(d)]);
  const ns_provider = providerFor(nameservers);
  // Only fetch the domain's own page for a Spaceship BIN when its NS actually point
  // to Spaceship (that's when it serves the DOMAIN_CONFIG lander) — saves a request.
  let ship: { price: number | null; min_offer: number | null } | null = null;
  if (ns_provider && /spaceship/i.test(ns_provider)) ship = await spaceshipListing(d);
  const info: DomainLive = {
    registrar,
    nameservers,
    ns_provider,
    afternic,
    spaceship_price: ship?.price ?? null,
    spaceship_min_offer: ship?.min_offer ?? null,
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
