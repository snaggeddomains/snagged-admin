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
    hasKeys: (e) => !!(e.DYNADOT_API_KEY),
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
    hasKeys: (e) => !!(e.GODADDY_API_KEY && e.GODADDY_API_SECRET),
    nsCaveat: "Nameserver changes on protected / high-value domains require 2FA, which GoDaddy's API doesn't support — those may be rejected.",
  },
  namecheap: {
    id: "namecheap",
    label: "Namecheap",
    canNS: true,
    canDNS: true,
    // Needs an IP-allowlisted static egress; not wired yet.
    hasKeys: () => false,
  },
};

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
