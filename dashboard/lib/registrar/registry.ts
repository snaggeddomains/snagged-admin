// Registrar / DNS-host capability registry for SNAP Names bulk updates.
//
// Two kinds of write exist and go to DIFFERENT providers:
//   • Nameservers  → set at the REGISTRAR the domain is registered with.
//   • DNS records  → set at the DNS HOST the nameservers point to.
// So a row's "wired?" is judged against the registrar (for NS) or the NS provider
// (for DNS). A provider is "wired" only if we have an adapter AND its API keys are
// present in the environment. Everything here is capability/plumbing metadata — the
// actual write calls live in the per-provider adapters (added when we enable live
// writes; today the flow is preview-only).

export type ProviderId = "spaceship" | "porkbun" | "dynadot" | "namesilo" | "godaddy" | "namecheap";

export interface Provider {
  id: ProviderId;
  label: string;
  canNS: boolean; // can set nameservers via API
  canDNS: boolean; // can set DNS records via API
  hasKeys: (env: NodeJS.ProcessEnv) => boolean;
  // A caveat that makes a write conditionally fail (shown in the preview).
  nsCaveat?: string;
}

// ── Multi-account credentials (business + personal) ─────────────────────────
// A registrar key only controls the domains IN that account, and we may hold two
// GoDaddy / Namecheap accounts. These resolvers return the available accounts in
// TRY ORDER (business → personal → single fallback); the write adapter routes by a
// domain→account map and cascades through this order when the map misses.
// Accounts are tried in this order: Berserk (business) → Rob (personal) → single
// fallback. First success wins (option A cascade).
export interface GodaddyAccount { account: "berserk" | "rob" | "default"; key: string; secret: string; }
export function godaddyAccounts(e: NodeJS.ProcessEnv): GodaddyAccount[] {
  const out: GodaddyAccount[] = [];
  if (e.GODADDY_API_KEY_BERSERK && e.GODADDY_API_SECRET_BERSERK) out.push({ account: "berserk", key: e.GODADDY_API_KEY_BERSERK, secret: e.GODADDY_API_SECRET_BERSERK });
  if (e.GODADDY_API_KEY_ROB && e.GODADDY_API_SECRET_ROB) out.push({ account: "rob", key: e.GODADDY_API_KEY_ROB, secret: e.GODADDY_API_SECRET_ROB });
  if (!out.length && e.GODADDY_API_KEY && e.GODADDY_API_SECRET) out.push({ account: "default", key: e.GODADDY_API_KEY, secret: e.GODADDY_API_SECRET });
  return out;
}
export interface NamecheapAccount { account: "berserk" | "rob" | "default"; apiUser: string; apiKey: string; username: string; }
export function namecheapAccounts(e: NodeJS.ProcessEnv): NamecheapAccount[] {
  const out: NamecheapAccount[] = [];
  if (e.NAMECHEAP_API_KEY_BERSERK && e.NAMECHEAP_API_USER_BERSERK) out.push({ account: "berserk", apiKey: e.NAMECHEAP_API_KEY_BERSERK, apiUser: e.NAMECHEAP_API_USER_BERSERK, username: e.NAMECHEAP_USERNAME_BERSERK || e.NAMECHEAP_API_USER_BERSERK });
  if (e.NAMECHEAP_API_KEY_ROB && e.NAMECHEAP_API_USER_ROB) out.push({ account: "rob", apiKey: e.NAMECHEAP_API_KEY_ROB, apiUser: e.NAMECHEAP_API_USER_ROB, username: e.NAMECHEAP_USERNAME_ROB || e.NAMECHEAP_API_USER_ROB });
  if (!out.length && e.NAMECHEAP_API_KEY && e.NAMECHEAP_API_USER) out.push({ account: "default", apiKey: e.NAMECHEAP_API_KEY, apiUser: e.NAMECHEAP_API_USER, username: e.NAMECHEAP_USERNAME || e.NAMECHEAP_API_USER });
  return out;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  spaceship: {
    id: "spaceship",
    label: "Spaceship",
    canNS: true,
    canDNS: true,
    hasKeys: (e) => !!(e.SPACESHIP_API_KEY && e.SPACESHIP_API_SECRET),
  },
  porkbun: {
    id: "porkbun",
    label: "Porkbun",
    canNS: true,
    canDNS: true,
    hasKeys: (e) => !!((e.PORKBUN_API_KEY || e.PORKBUN_KEY) && (e.PORKBUN_SECRET_KEY || e.PORKBUN_SECRET)),
  },
  dynadot: {
    id: "dynadot",
    label: "Dynadot",
    canNS: true,
    canDNS: true,
    // Dynadot's RESTful API signs each request with the secret, so both are needed.
    hasKeys: (e) => !!(e.DYNADOT_API_KEY && (e.DYNADOT_API_SECRET || e.DYNADOT_SECRET_KEY)),
  },
  namesilo: {
    id: "namesilo",
    label: "NameSilo",
    canNS: true,
    canDNS: true,
    hasKeys: (e) => !!(e.NAMESILO_API_KEY),
  },
  godaddy: {
    id: "godaddy",
    label: "GoDaddy",
    canNS: true,
    canDNS: true,
    // We may hold TWO GoDaddy accounts (business + personal); the domain could be in
    // either. "Wired" = at least one account's keys present. The write adapter builds
    // a domain→account map (list each account once) and routes to the right key,
    // falling back to a business→personal cascade.
    hasKeys: (e) => godaddyAccounts(e).length > 0,
    nsCaveat: "Nameserver changes on protected / high-value domains require 2FA, which GoDaddy's API doesn't support — those may be rejected.",
  },
  namecheap: {
    id: "namecheap",
    label: "Namecheap",
    canNS: true,
    canDNS: true,
    // Two accounts possible AND Namecheap requires an IP-allowlisted static egress —
    // so "wired" also needs a proxy configured.
    hasKeys: (e) => namecheapAccounts(e).length > 0 && !!e.NAMECHEAP_PROXY_URL,
  },
};

// Each registrar's DEFAULT (registrar-hosted DNS) nameservers. Setting a name back
// to these makes the registrar authoritative for DNS, which is what you need before
// adding DNS records via that registrar's API. GoDaddy assigns a per-domain
// domaincontrol.com pair (no single fixed default), so it has none here.
export const PROVIDER_DEFAULT_NS: Record<ProviderId, string[] | null> = {
  porkbun: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com", "maceio.ns.porkbun.com", "salvador.ns.porkbun.com"],
  spaceship: ["launch1.spaceship.net", "launch2.spaceship.net"],
  dynadot: ["ns1.dynadot.com", "ns2.dynadot.com", "ns3.dynadot.com"],
  namesilo: ["ns1.namesilo.com", "ns2.namesilo.com"],
  namecheap: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
  godaddy: null, // assigned per-domain (nsXX.domaincontrol.com)
};

export function defaultNsForRegistrar(registrar: string | null | undefined): string[] | null {
  const id = providerForRegistrar(registrar);
  return id ? PROVIDER_DEFAULT_NS[id] : null;
}

// Match a registrar name (from RDAP/WHOIS) → provider id.
const REGISTRAR_MATCH: [RegExp, ProviderId][] = [
  [/spaceship/i, "spaceship"],
  [/porkbun/i, "porkbun"],
  [/dynadot/i, "dynadot"],
  [/namesilo/i, "namesilo"],
  [/godaddy/i, "godaddy"],
  [/namecheap/i, "namecheap"],
];

export function providerForRegistrar(registrar: string | null | undefined): ProviderId | null {
  const s = String(registrar || "");
  for (const [re, id] of REGISTRAR_MATCH) if (re.test(s)) return id;
  return null;
}

// Registrar names come back from RDAP/WHOIS in many spellings for the SAME company
// ("Porkbun LLC" vs "Porkbun", "NameCheap, Inc." vs "Namecheap Inc.", the numbered
// "DropCatch.com 421/382 LLC" shells). Collapse each to ONE canonical label so the
// column + filter show a single value per registrar. Unknown names get their
// corporate suffix trimmed for a cleaner single value.
const REG_CANON: [RegExp, string][] = [
  [/porkbun/i, "Porkbun"],
  [/namecheap/i, "Namecheap"],
  [/godaddy/i, "GoDaddy"],
  [/dynadot/i, "Dynadot"],
  [/name\s?silo/i, "NameSilo"],
  [/spaceship/i, "Spaceship"],
  [/atom\.com|atom domains/i, "Atom"],
  [/dropcatch/i, "DropCatch"],
  [/namebright|turncommerce/i, "NameBright"],
  [/network solutions/i, "Network Solutions"],
  [/gname/i, "Gname"],
  [/glamdomains/i, "GlamDomains"],
  [/hanging curve/i, "Hanging Curve Domains"],
  [/instra/i, "Instra"],
  [/zhuimi/i, "Zhuimi"],
  [/namebake/i, "NameBake"],
  [/humbly/i, "Humbly"],
  [/enom/i, "eNom"],
  [/tucows/i, "Tucows"],
  [/google/i, "Google Domains"],
  [/cloudflare/i, "Cloudflare"],
  [/sav\.com|sav,? llc/i, "Sav"],
  [/hostinger/i, "Hostinger"],
];

export function canonicalRegistrar(name: string | null | undefined): string | null {
  const s = String(name || "").trim();
  if (!s) return name ?? null;
  for (const [re, label] of REG_CANON) if (re.test(s)) return label;
  return s.replace(/[,.]?\s*(LLC|Inc\.?|Ltd\.?|Corp\.?|Corporation|Pty\.?\s*Ltd\.?|Co\.?|GmbH|S\.?A\.?S?\.?)\.?$/i, "").replace(/[,\s]+$/, "").trim() || s;
}

// Match a DNS-host label (our ns_provider string, e.g. "Spaceship DNS", "Porkbun
// DNS", "GoDaddy DNS", "snagged.com", "Cloudflare") → provider id, or null if it's
// a host we don't (yet) have a DNS adapter for (Cloudflare/Atom/Snagged/etc.).
const NSHOST_MATCH: [RegExp, ProviderId][] = [
  [/spaceship/i, "spaceship"],
  [/porkbun/i, "porkbun"],
  [/dynadot/i, "dynadot"],
  [/namesilo/i, "namesilo"],
  [/godaddy|domaincontrol/i, "godaddy"],
  [/namecheap|registrar-servers/i, "namecheap"],
];

export function providerForNsHost(nsProvider: string | null | undefined): ProviderId | null {
  const s = String(nsProvider || "");
  for (const [re, id] of NSHOST_MATCH) if (re.test(s)) return id;
  return null;
}
