// Live registrar write adapters — set nameservers / DNS records via each provider's
// API. Server-only. Every call returns { ok, error?, account? } and never throws.
// Implemented + tested-by-shape: Porkbun, Spaceship, NameSilo, GoDaddy (Berserk→Rob
// cascade), Namecheap (Fixie proxy), Cloudflare (DNS), Dynadot (RESTful v2, HMAC-
// signed).
//
// SAFETY: these mutate real production domains. Callers must gate on the write
// permission + explicit confirm, and log every attempt (see lib/snap-writes.ts).

import { createHmac, randomUUID } from "node:crypto";
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
      const t = await res.text().catch(() => "");
      // GoDaddy returns 404 OR 403 ACCESS_DENIED when the domain isn't in this
      // account — cascade to the next account. Any other error stops.
      if (res.status === 404 || res.status === 403) {
        lastErr = `GoDaddy HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ""}`;
        continue;
      }
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
      const t = await res.text().catch(() => "");
      if (res.status === 404 || res.status === 403) { lastErr = `GoDaddy HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ""}`; continue; }
      return { ok: false, account: acct.account, error: `GoDaddy HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ""}` };
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  return { ok: false, error: lastErr || "GoDaddy DNS write failed" };
}

// ── Cloudflare DNS (bearer token; resolve zone by name → append record) ──────
async function cloudflareSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const token = e.CLOUDFLARE_API_TOKEN_DNS || e.CLOUDFLARE_API_TOKEN || "";
  if (!token) return { ok: false, error: "No Cloudflare API token configured" };
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const zr = await timedFetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}&status=active`, { method: "GET", headers: H });
    const zj = (await zr.json().catch(() => ({}))) as { result?: { id: string }[]; errors?: { message: string }[] };
    const zone = zj.result?.[0];
    if (!zone?.id) return { ok: false, error: `Cloudflare: zone not found for ${domain}${zj.errors?.[0] ? ` (${zj.errors[0].message})` : ""}` };
    // Cloudflare wants the FQDN as name; "@"/root → the domain itself.
    const host = rec.host === "@" || !rec.host ? domain : rec.host.endsWith(domain) ? rec.host : `${rec.host}.${domain}`;
    const cr = await timedFetch(`https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ type: rec.type, name: host, content: rec.value, ttl: rec.ttl || 3600 }),
    });
    const cj = (await cr.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[] };
    if (cr.ok && cj.success) return { ok: true, account: "cloudflare" };
    return { ok: false, error: `Cloudflare: ${cj.errors?.[0]?.message || `HTTP ${cr.status}`}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── Spaceship DNS (PUT is UPSERT per docs — safe single-record append) ───────
function spaceshipRecordItem(rec: DnsRecordInput): Record<string, unknown> {
  const t = rec.type.toUpperCase();
  const base = { type: t, name: rec.host === "@" ? "@" : rec.host, ttl: rec.ttl || 3600 };
  if (t === "A" || t === "AAAA") return { ...base, address: rec.value };
  if (t === "CNAME") return { ...base, cname: rec.value };
  if (t === "MX") return { ...base, exchange: rec.value, preference: 10 };
  return { ...base, value: rec.value }; // TXT + fallback
}
async function spaceshipSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  try {
    const res = await timedFetch(`https://spaceship.dev/api/v1/dns/records/${encodeURIComponent(domain)}`, {
      method: "PUT",
      headers: spaceshipHeaders(e),
      body: JSON.stringify({ force: true, items: [spaceshipRecordItem(rec)] }),
    });
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => "");
    // A name that's parked on Spaceship's MARKETPLACE nameservers (launch1/2.spaceship.net)
    // — typical for a domain registered elsewhere and listed for sale on Spaceship — has no
    // user-editable DNS zone, so the record PUT 404s "Zone file … hasn't been found". We do
    // NOT auto-provision, because that would repoint the nameservers and wipe the listing.
    // Surface a clear, actionable message instead.
    if (res.status === 404 && /zone file/i.test(t)) {
      return { ok: false, error: "Spaceship has no editable DNS zone for this name (it's on marketplace nameservers). Point it to nameservers whose DNS we control (e.g. ns1/ns2.snagged.com → Cloudflare) and add the record there." };
    }
    return { ok: false, error: `Spaceship HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ""}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── Namecheap DNS (setHosts REPLACES all — so read-merge: getHosts → add → set) ─
function ncHostAttr(attrs: string, key: string): string {
  const m = attrs.match(new RegExp(`${key}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}
async function namecheapSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
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
    try {
      const common = { ApiUser: a.apiUser, ApiKey: a.apiKey, UserName: a.username, ClientIp: clientIp, SLD: sld, TLD: tld };
      // 1) read existing hosts (so setHosts doesn't wipe them)
      const gp = new URLSearchParams({ ...common, Command: "namecheap.domains.dns.getHosts" });
      const gr = await undiciFetch(`https://api.namecheap.com/xml.response?${gp.toString()}`, { dispatcher, signal: AbortSignal.timeout(20000) });
      const gxml = await gr.text();
      if (!/Status="OK"/i.test(gxml)) {
        const err = ncError(gxml) || `HTTP ${gr.status}`;
        if (/not\s*associated|domain.*not.*found|not exist|does not belong|is not associated/i.test(err)) { lastErr = err; continue; }
        return { ok: false, account: a.account, error: `Namecheap getHosts: ${err}` };
      }
      // preserve the domain's email routing type across the replace
      const emailType = (gxml.match(/DomainDNSGetHostsResult[^>]*EmailType="([^"]*)"/i) || [])[1] || "NONE";
      const hosts = [...gxml.matchAll(/<host\b([^>]*?)\/?>/gi)].map((m) => ({
        HostName: ncHostAttr(m[1], "Name") || "@",
        RecordType: ncHostAttr(m[1], "Type"),
        Address: ncHostAttr(m[1], "Address"),
        MXPref: ncHostAttr(m[1], "MXPref") || "10",
        TTL: ncHostAttr(m[1], "TTL") || "1799",
      })).filter((h) => h.RecordType);
      hosts.push({ HostName: rec.host === "@" ? "@" : rec.host, RecordType: rec.type, Address: rec.value, MXPref: "10", TTL: String(rec.ttl || 1799) });
      // 2) write the FULL set back
      const sp = new URLSearchParams({ ...common, Command: "namecheap.domains.dns.setHosts", EmailType: emailType });
      hosts.forEach((h, i) => {
        const n = i + 1;
        sp.set(`HostName${n}`, h.HostName);
        sp.set(`RecordType${n}`, h.RecordType);
        sp.set(`Address${n}`, h.Address);
        sp.set(`MXPref${n}`, h.MXPref);
        sp.set(`TTL${n}`, h.TTL);
      });
      const sr = await undiciFetch(`https://api.namecheap.com/xml.response?${sp.toString()}`, { dispatcher, signal: AbortSignal.timeout(20000) });
      const sxml = await sr.text();
      if (/Status="OK"/i.test(sxml) && /IsSuccess="true"/i.test(sxml)) return { ok: true, account: a.account };
      return { ok: false, account: a.account, error: `Namecheap setHosts: ${ncError(sxml) || `HTTP ${sr.status}`}` };
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  return { ok: false, error: lastErr || "Namecheap DNS write failed (domain not in any configured account?)" };
}

// ── NameSilo DNS (dnsAddRecord; key-in-URL; success code 300) ────────────────
async function namesiloSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const key = e.NAMESILO_API_KEY || "";
  const params = new URLSearchParams({
    version: "1", type: "json", key, domain,
    rrtype: rec.type, rrhost: rec.host === "@" ? "" : rec.host, rrvalue: rec.value, rrttl: String(Math.max(3600, rec.ttl || 3600)),
  });
  try {
    const res = await timedFetch(`https://www.namesilo.com/api/dnsAddRecord?${params.toString()}`, { method: "GET" });
    const j = (await res.json().catch(() => ({}))) as { reply?: { code?: string | number; detail?: string } };
    if (String(j?.reply?.code) === "300") return { ok: true };
    return { ok: false, error: j?.reply?.detail || `NameSilo code ${j?.reply?.code ?? res.status}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

// ── Dynadot (RESTful v2 — Bearer key + HMAC-SHA256 X-Signature) ──────────────
// Auth: Authorization: Bearer <apiKey>, plus X-Signature = base64(HMAC-SHA256(secret,
// `${apiKey}\n${pathAndQuery}\n${requestId}\n${body}`)). requestId is sent as the
// X-Request-Id header and MUST match what's signed. Docs:
// https://www.dynadot.com/domain/api-document (v2.0.0).
function dynadotCreds(e: NodeJS.ProcessEnv) {
  return { key: e.DYNADOT_API_KEY || "", secret: e.DYNADOT_API_SECRET || e.DYNADOT_SECRET_KEY || "" };
}
async function dynadotRequest(
  method: "PUT" | "POST",
  path: string,
  bodyObj: unknown,
  e: NodeJS.ProcessEnv
): Promise<WriteResult> {
  const { key, secret } = dynadotCreds(e);
  if (!key || !secret) return { ok: false, error: "Dynadot key/secret not configured" };
  const body = JSON.stringify(bodyObj);
  const requestId = randomUUID();
  const toSign = `${key}\n${path}\n${requestId}\n${body}`;
  const sig = createHmac("sha256", secret).update(toSign).digest("base64");
  try {
    const res = await timedFetch(`https://api.dynadot.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Signature": sig,
        "X-Request-Id": requestId,
      },
      body,
    });
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => "");
    return { ok: false, error: `Dynadot HTTP ${res.status}${t ? `: ${t.slice(0, 180)}` : ""}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}
async function dynadotSetNs(domain: string, ns: string[], e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const path = `/restful/v2/domains/${encodeURIComponent(domain)}/nameserver`;
  return dynadotRequest("PUT", path, { nameservers: ns.map((host) => ({ host })) }, e);
}
async function dynadotSetDns(domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  const path = `/restful/v2/domains/${encodeURIComponent(domain)}/dns`;
  // Dynadot models a root record with an empty host (its legacy "main record"); a
  // subdomain carries its label. POST /dns ADDS the record (append), which is what we
  // want for an Afternic verification TXT.
  const body = {
    type: rec.type.toUpperCase(),
    host: rec.host === "@" ? "" : rec.host,
    value: rec.value,
    ttl: rec.ttl || 3600,
  };
  return dynadotRequest("POST", path, body, e);
}

// ── dispatch ────────────────────────────────────────────────────────────────
const NS_EXECUTABLE: ProviderId[] = ["porkbun", "spaceship", "namesilo", "godaddy", "namecheap", "dynadot"];
export function nsExecutable(provider: ProviderId): boolean {
  return NS_EXECUTABLE.includes(provider);
}
const DNS_EXECUTABLE: ProviderId[] = ["porkbun", "godaddy", "cloudflare", "namesilo", "spaceship", "namecheap", "dynadot"];
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
    case "dynadot": return dynadotSetNs(domain, ns, e);
    default: return { ok: false, error: `${provider} nameserver execute not enabled yet` };
  }
}

export async function setDnsRecord(provider: ProviderId, domain: string, rec: DnsRecordInput, e: NodeJS.ProcessEnv): Promise<WriteResult> {
  switch (provider) {
    case "porkbun": return porkbunSetDns(domain, rec, e);
    case "godaddy": return godaddySetDns(domain, rec, e);
    case "cloudflare": return cloudflareSetDns(domain, rec, e);
    case "namesilo": return namesiloSetDns(domain, rec, e);
    case "spaceship": return spaceshipSetDns(domain, rec, e);
    case "namecheap": return namecheapSetDns(domain, rec, e);
    case "dynadot": return dynadotSetDns(domain, rec, e);
    default: return { ok: false, error: `${provider} DNS-record execute not enabled yet` };
  }
}
