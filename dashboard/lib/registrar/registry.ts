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

export type ProviderId = "spaceship" | "porkbun" | "dynadot" | "namesilo" | "godaddy" | "namecheap" | "cloudflare" | "namebright";

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
// For Namecheap the ApiUser and UserName are the same login username, so either
// NAMECHEAP_USERNAME_* or NAMECHEAP_API_USER_* supplies both.
export interface NamecheapAccount { account: "berserk" | "rob" | "default"; apiUser: string; apiKey: string; username: string; }
export function namecheapAccounts(e: NodeJS.ProcessEnv): NamecheapAccount[] {
  const out: NamecheapAccount[] = [];
  const userB = e.NAMECHEAP_USERNAME_BERSERK || e.NAMECHEAP_API_USER_BERSERK;
  const userR = e.NAMECHEAP_USERNAME_ROB || e.NAMECHEAP_API_USER_ROB;
  const userD = e.NAMECHEAP_USERNAME || e.NAMECHEAP_API_USER;
  if (e.NAMECHEAP_API_KEY_BERSERK && userB) out.push({ account: "berserk", apiKey: e.NAMECHEAP_API_KEY_BERSERK, apiUser: userB, username: userB });
  if (e.NAMECHEAP_API_KEY_ROB && userR) out.push({ account: "rob", apiKey: e.NAMECHEAP_API_KEY_ROB, apiUser: userR, username: userR });
  if (!out.length && e.NAMECHEAP_API_KEY && userD) out.push({ account: "default", apiKey: e.NAMECHEAP_API_KEY, apiUser: userD, username: userD });
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
  // NameBright (TurnCommerce) — OAuth2 client_credentials (30-min bearer). Note:
  // NameBright IP-allowlists per API client, and Vercel egress rotates, so if the
  // account's whitelist is enforced this must egress from the Fixie static IPs — set
  // NAMEBRIGHT_USE_PROXY=1 (reuses FIXIE_URL) and whitelist those IPs in NameBright.
  namebright: {
    id: "namebright",
    label: "NameBright",
    canNS: true,
    canDNS: true,
    hasKeys: (e) => !!(e.NAMEBRIGHT_CLIENT_ID && e.NAMEBRIGHT_CLIENT_SECRET),
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
    // so "wired" also needs a static-IP proxy (Fixie) + a whitelisted ClientIp.
    hasKeys: (e) => namecheapAccounts(e).length > 0 && !!(e.FIXIE_URL || e.NAMECHEAP_PROXY_URL) && !!e.NAMECHEAP_CLIENT_IP,
  },
  // Cloudflare is a DNS host, not a registrar (canNS:false). Domains on our
  // ns1/ns2.snagged.com vanity nameservers are Cloudflare-backed, so their DNS is
  // managed here. Bearer-token auth — no proxy needed.
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    canNS: false,
    canDNS: true,
    hasKeys: (e) => !!(e.CLOUDFLARE_API_TOKEN_DNS || e.CLOUDFLARE_API_TOKEN),
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
  namebright: ["dns1.name-services.com", "dns2.name-services.com"], // NameBright/eNom-family default DNS
  godaddy: null, // assigned per-domain (nsXX.domaincontrol.com)
  cloudflare: null, // DNS host, not a registrar — no registrar-default NS
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
  // NameBright/DropCatch (TurnCommerce) — the operator label our RDAP mapping produces,
  // plus the raw shell/brand names, all route to the NameBright API adapter.
  [/namebright|turncommerce|dropcatch/i, "namebright"],
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
  // Drop-catch / back-order shell FAMILIES. These operators each accredit HUNDREDS of
  // whimsically-named registrar shells (a name-by-name list can't keep up), so the real
  // grouping is by OPERATOR — detected from the RDAP IANA Registrar ID / abuse URL via
  // operatorForIanaId / operatorFromRegistrarUrl below (which auto-catches every shell,
  // present + future). These name patterns are a best-effort fallback for the WHOIS path
  // when only a bare registrar NAME (no id/url) is available.
  [/dropcatch|namebright|turncommerce|glamdomains|namebake/i, "NameBright/DropCatch"],
  [/network solutions|snapnames|\bhanging curve\b/i, "Network Solutions"],
  [/park\.io|zhuimi/i, "park.io"],
  [/gname/i, "Gname"],
  [/instra/i, "Instra"],
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

// ── Operator unification (authoritative, from RDAP) ──────────────────────────
// A registrar's whimsical name ("Hanging Curve Domains LLC", "Abbey Road Domains LLC")
// hides who really operates it. The stable signal is the IANA Registrar ID (from RDAP
// publicIds) or the registrar's abuse URL — both tie a shell to its parent. operator-ids
// .json maps every known shell's IANA id → the canonical operator label; it's generated
// from IANA's registrar-ids list, grouped by each registrar's RDAP endpoint (526 Newfold/
// Network Solutions shells via snapnames/networksolutions, 1252 NameBright/DropCatch via
// namebright, park.io via park.io). Regenerate when Newfold/TurnCommerce add shells.
import OPERATOR_IDS from "./operator-ids.json";
const OP_BY_ID = (OPERATOR_IDS as { map: Record<string, string> }).map || {};

// IANA Registrar ID → canonical operator label (null if not a grouped shell family).
export function operatorForIanaId(id: string | number | null | undefined): string | null {
  const key = String(id ?? "").trim();
  return key && OP_BY_ID[key] ? OP_BY_ID[key] : null;
}

// Registrar abuse/registrar URL (or abuse email) → operator label. The WHOIS-fallback
// signal when there's no IANA id, and a backstop for RDAP records missing publicIds.
const OP_BY_URL: [RegExp, string][] = [
  [/networksolutions\.com|snapnames\.com|newfold\.com/i, "Network Solutions"],
  [/namebright\.com|turncommerce\.com|dropcatch\.com/i, "NameBright/DropCatch"],
  [/park\.io/i, "park.io"],
];
export function operatorFromRegistrarUrl(url: string | null | undefined): string | null {
  const s = String(url || "");
  if (!s) return null;
  for (const [re, label] of OP_BY_URL) if (re.test(s)) return label;
  return null;
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
  [/namebright|name-services\.com/i, "namebright"],
  // Our ns1/ns2.snagged.com vanity nameservers are Cloudflare-backed, as is a real
  // *.ns.cloudflare.com pair → manage DNS via the Cloudflare API.
  [/cloudflare|snagged\.com/i, "cloudflare"],
];

export function providerForNsHost(nsProvider: string | null | undefined): ProviderId | null {
  const s = String(nsProvider || "");
  for (const [re, id] of NSHOST_MATCH) if (re.test(s)) return id;
  return null;
}
