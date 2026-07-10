// Live registrar write adapters — set nameservers / DNS records via each provider's
// API. Server-only. Every call returns { ok, error?, account? } and never throws.
// Implemented + tested-by-shape: Porkbun, Spaceship, NameSilo, GoDaddy (Berserk→Rob
// cascade). Dynadot execute is not enabled yet (RESTful signing unconfirmed) — its
// preview still works; execute returns a clear not-enabled error.
//
// SAFETY: these mutate real production domains. Callers must gate on the write
// permission + explicit confirm, and log every attempt (see lib/snap-writes.ts).

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { godaddyAccounts, namecheapAccounts, type ProviderId } from "./registry";

export interface WriteResult {
  ok: boolean;
  error?: string;
  account?: string; // which multi-account credential succeeded (GoDaddy)
}
export interface DnsRecordInput {
  type: string;
  host: string; // "@" for root
  value: string;
  ttl?: number;
}

async function timedFetch(url: string, init: RequestInit, ms = 15000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// ── Porkbun ─────────────────────────────────────────────────────────────────
function porkbunCreds(e: NodeJS.ProcessEnv) {
  return {
    apikey: e.PORKBUN_API_KEY || e.PORKBUN_KEY || "",
    secretapikey: e.PORKBUN_SECRET_KEY || e.PORKBUN_SECRET || "",
  };
}
async function porkbunSetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const creds = porkbunCreds(e);
  try {
    const res = await timedFetch(`https://api.porkbun.com/api/json/v3/domain/updateNs/${encodeURIComponent(domain)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, ns }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.status === "SUCCESS") return { ok: true };
    return { ok: false, error: j.message || `Porkbun HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}
async function porkbunSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const creds = porkbunCreds(e);
  try {
    const res = await timedFetch(`https://api.porkbun.com/api/json/v3/dns/create/${encodeURIComponent(domain)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, name: rec.host === "@" ? "" : rec.host, type: rec.type, content: rec.value, ttl: String(rec.ttl || 600) }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.status === "SUCCESS") return { ok: true };
    return { ok: false, error: j.message || `Porkbun HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── Spaceship ───────────────────────────────────────────────────────────────
function spaceshipHeaders(e: NodeJS.ProcessEnv) {
  return { "X-Api-Key": e.SPACESHIP_API_KEY || "", "X-Api-Secret": e.SPACESHIP_API_SECRET || "", "Content-Type": "application/json" };
}
async function spaceshipSetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  try {
    const res = await timedFetch(`https://spaceship.dev/api/v1/domains/${encodeURIComponent(domain)}/nameservers`, {
      method: "PUT",
      headers: spaceshipHeaders(e),
      body: JSON.stringify({ provider: "custom", hosts: ns }),
    });
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => "");
    return { ok: false, error: `Spaceship HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ""}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── NameSilo (key-in-URL GET; success code 300) ─────────────────────────────
async function namesiloSetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const key = e.NAMESILO_API_KEY || "";
  const params = new URLSearchParams({ version: "1", type: "json", key, domain });
  ns.slice(0, 13).forEach((n, i) => params.set(`ns${i + 1}`, n));
  try {
    const res = await timedFetch(`https://www.namesilo.com/api/changeNameServers?${params.toString()}`, { method: "GET" });
    const j = await res.json().catch(() => ({}));
    const code = j?.reply?.code;
    if (String(code) === "300") return { ok: true };
    return { ok: false, error: j?.reply?.detail || `NameSilo code ${code ?? res.status}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── GoDaddy (v1 PATCH; cascade Berserk → Rob; 404 = not in this account) ─────
async function godaddySetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const accounts = godaddyAccounts(e);
  if (!accounts.length) return { ok: false, error: "No GoDaddy API key configured" };
  let lastErr = "";
  for (const acct of accounts) {
    try {
      const res = await timedFetch(`https://api.godaddy.com/v1/domains/${encodeURIComponent(domain)}`, {
        method: "PATCH",
        headers: { Authorization: `sso-key ${acct.key}:${acct.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ nameServers: ns }),
      });
      if (res.ok) return { ok: true, account: acct.account };
      if (res.status === 404) {
        lastErr = "not found in any configured GoDaddy account";
        continue; // domain not in this account — try the next
      }
      const t = await res.text().catch(() => "");
      // Domain IS in this account but the write failed (e.g. 2FA on a premium name).
      return { ok: false, account: acct.account, error: `GoDaddy HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ""}` };
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  return { ok: false, error: lastErr || "GoDaddy write failed" };
}

// ── Namecheap (via Fixie static-IP proxy; cascade Berserk → Rob) ────────────
// Namecheap IP-allowlists, so calls MUST egress from a whitelisted IP — we route
// through the same Fixie proxy the research app uses. ClientIp must be a whitelisted
// IP (a Fixie outbound IP).
function namecheapDispatcher(e: NodeJS.ProcessEnv): ProxyAgent | null {
  const raw = e.NAMECHEAP_PROXY_URL || e.FIXIE_URL || "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const opts: { uri: string; token?: string } = { uri: `${u.protocol}//${u.host}` };
    if (u.username || u.password) {
      const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      opts.token = `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    return new ProxyAgent(opts);
  } catch {
    return null;
  }
}
function ncError(xml: string): string {
  const m = xml.match(/<Error[^>]*>([^<]+)<\/Error>/i);
  return m ? m[1].trim() : "";
}
async function namecheapSetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const accounts = namecheapAccounts(e);
  if (!accounts.length) return { ok: false, error: "No Namecheap account configured" };
  const dispatcher = namecheapDispatcher(e);
  if (!dispatcher) return { ok: false, error: "No Fixie/proxy configured (FIXIE_URL) for Namecheap" };
  const clientIp = (e.NAMECHEAP_CLIENT_IP || "").split(",")[0].trim();
  if (!clientIp) return { ok: false, error: "NAMECHEAP_CLIENT_IP not set (a whitelisted Fixie IP)" };
  const dot = domain.lastIndexOf(".");
  const sld = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  let lastErr = "";
  for (const a of accounts) {
    const params = new URLSearchParams({
      ApiUser: a.apiUser, ApiKey: a.apiKey, UserName: a.username, ClientIp: clientIp,
      Command: "namecheap.domains.dns.setCustom", SLD: sld, TLD: tld, Nameservers: ns.join(","),
    });
    try {
      const res = await undiciFetch(`https://api.namecheap.com/xml.response?${params.toString()}`, { dispatcher, signal: AbortSignal.timeout(20000) });
      const xml = await res.text();
      if (/Status="OK"/i.test(xml) && /Updated="true"/i.test(xml)) return { ok: true, account: a.account };
      const err = ncError(xml) || `HTTP ${res.status}`;
      // Domain not in this account → cascade to the next; other errors stop.
      if (/not\s*associated|domain.*not.*found|not exist|does not belong|is not associated/i.test(err)) { lastErr = err; continue; }
      return { ok: false, account: a.account, error: `Namecheap: ${err}` };
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  return { ok: false, error: lastErr || "Namecheap write failed (domain not in any configured account?)" };
}

// ── GoDaddy DNS (append a record via v1 /records; Berserk→Rob cascade) ───────
async function godaddySetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const accounts = godaddyAccounts(e);
  if (!accounts.length) return { ok: false, error: "No GoDaddy API key configured" };
  const body = [{ data: rec.value, name: rec.host || "@", ttl: Math.max(600, rec.ttl || 600), type: rec.type }];
  let lastErr = "";
  for (const acct of accounts) {
    try {
      const res = await timedFetch(`https://api.godaddy.com/v1/domains/${encodeURIComponent(domain)}/records`, {
        method: "PATCH",
        headers: { Authorization: `sso-key ${acct.key}:${acct.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true, account: acct.account };
      if (res.status === 404) { lastErr = "not found in any configured GoDaddy account"; continue; }
      const t = await res.text().catch(() => "");
      return { ok: false, account: acct.account, error: `GoDaddy HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ""}` };
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  return { ok: false, error: lastErr || "GoDaddy DNS write failed" };
}

// ── dispatch ────────────────────────────────────────────────────────────────
const NS_EXECUTABLE: ProviderId[] = ["porkbun", "spaceship", "namesilo", "godaddy", "namecheap"];
export function nsExecutable(provider: ProviderId): boolean {
  return NS_EXECUTABLE.includes(provider);
}
const DNS_EXECUTABLE: ProviderId[] = ["porkbun", "godaddy"];
export function dnsExecutable(provider: ProviderId): boolean {
  return DNS_EXECUTABLE.includes(provider);
}

export async function setNameservers(provider: ProviderId, domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  switch (provider) {
    case "porkbun": return porkbunSetNs(domain, ns, e);
    case "spaceship": return spaceshipSetNs(domain, ns, e);
    case "namesilo": return namesiloSetNs(domain, ns, e);
    case "godaddy": return godaddySetNs(domain, ns, e);
    case "namecheap": return namecheapSetNs(domain, ns, e);
    default: return { ok: false, error: `${provider} nameserver execute not enabled yet` };
  }
}

export async function setDnsRecord(provider: ProviderId, domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  switch (provider) {
    case "porkbun": return porkbunSetDns(domain, rec, e);
    case "godaddy": return godaddySetDns(domain, rec, e);
    default: return { ok: false, error: `${provider} DNS-record execute not enabled yet` };
  }
}
