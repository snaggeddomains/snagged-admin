// Registrar-account INVENTORY — list every domain actually held in each registrar
// account (with its expiration + auto-renew), so SNAP Names can VERIFY possession
// (a name is truly in an account we control) rather than infer the registrar from
// RDAP. Read-only; every provider fail-open (an unreachable/unkeyed account
// contributes nothing, never throws).
//
// Every registrar we can write to also exposes a "list domains in this account"
// endpoint that returns expiration + auto-renew per domain; multi-account registrars
// (GoDaddy, Namecheap) are listed per account. The whole snapshot is cached (see
// lib/snap-inventory.ts) because a rebuild is a burst of paginated API calls.

import { fetch as undiciFetch } from "undici";
import { godaddyAccounts, namecheapAccounts, type ProviderId } from "./registry";
import { namecheapDispatcher, dynadotSignature, namebrightApi } from "./adapters";

export interface DomainRecord {
  domain: string; // lowercased
  expires?: string | null; // registrar-reported expiration (ISO or MM/DD/YYYY)
  autoRenew?: boolean | null;
}
export interface AccountInventory {
  provider: ProviderId;
  label: string; // "GoDaddy (rob)"
  account: string; // berserk | rob | default | ""
  ok: boolean;
  error?: string;
  domains: DomainRecord[];
  capped?: boolean; // hit the page cap (list may be incomplete)
}

const timed = (url: string, init: RequestInit, ms = 20000): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
const norm = (s: unknown) => String(s || "").trim().toLowerCase();
const asBool = (v: unknown): boolean | null => {
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  if (typeof v === "string") { if (/^(true|yes|on|auto)$/i.test(v)) return true; if (/^(false|no|off|manual|donot)/i.test(v)) return false; }
  return null;
};
const PAGE_CAP = 40; // safety bound on pagination loops

// dedupe by domain (first wins), preserving expiry/autorenew.
function collect(map: Map<string, DomainRecord>, rec: DomainRecord) {
  const d = norm(rec.domain);
  if (d && !map.has(d)) map.set(d, { ...rec, domain: d });
}

// ── Porkbun: POST domain/listAll (offset paging, up to 1000/page) ────────────
async function porkbunInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const apikey = e.PORKBUN_API_KEY || e.PORKBUN_KEY || "";
  const secretapikey = e.PORKBUN_SECRET_KEY || e.PORKBUN_SECRET || "";
  const base: Omit<AccountInventory, "domains"> = { provider: "porkbun", label: "Porkbun", account: "", ok: false };
  const map = new Map<string, DomainRecord>();
  if (!apikey || !secretapikey) return { ...base, error: "not configured", domains: [] };
  try {
    for (let page = 0; page < PAGE_CAP; page++) {
      const res = await timed("https://api.porkbun.com/api/json/v3/domain/listAll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey, secretapikey, start: String(page * 1000), includeLabels: "no" }),
      });
      const j = (await res.json().catch(() => ({}))) as { status?: string; message?: string; domains?: { domain?: string; expireDate?: string; autoRenew?: unknown }[] };
      if (j.status !== "SUCCESS") return { ...base, error: j.message || `HTTP ${res.status}`, ok: map.size > 0, domains: [...map.values()] };
      const rows = j.domains || [];
      for (const r of rows) if (r.domain) collect(map, { domain: r.domain, expires: r.expireDate || null, autoRenew: asBool(r.autoRenew) });
      if (rows.length < 1000) return { ...base, ok: true, domains: [...map.values()] };
      if (page === PAGE_CAP - 1) return { ...base, ok: true, domains: [...map.values()], capped: true };
    }
    return { ...base, ok: true, domains: [...map.values()] };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err), ok: map.size > 0, domains: [...map.values()] };
  }
}

// ── Spaceship: GET /api/v1/domains (take/skip paging) ────────────────────────
async function spaceshipInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const base: Omit<AccountInventory, "domains"> = { provider: "spaceship", label: "Spaceship", account: "", ok: false };
  if (!e.SPACESHIP_API_KEY || !e.SPACESHIP_API_SECRET) return { ...base, error: "not configured", domains: [] };
  const headers = { "X-Api-Key": e.SPACESHIP_API_KEY, "X-Api-Secret": e.SPACESHIP_API_SECRET };
  const map = new Map<string, DomainRecord>();
  const take = 100;
  try {
    for (let page = 0; page < PAGE_CAP; page++) {
      const res = await timed(`https://spaceship.dev/api/v1/domains?take=${take}&skip=${page * take}`, { headers });
      if (!res.ok) { const t = await res.text().catch(() => ""); return { ...base, error: `HTTP ${res.status}${t ? `: ${t.slice(0, 100)}` : ""}`, ok: map.size > 0, domains: [...map.values()] }; }
      const j = (await res.json().catch(() => ({}))) as { items?: { name?: string; unicodeName?: string; expirationDate?: string; autoRenew?: unknown }[]; total?: number };
      const items = j.items || [];
      for (const it of items) { const d = it.name || it.unicodeName; if (d) collect(map, { domain: d, expires: it.expirationDate || null, autoRenew: asBool(it.autoRenew) }); }
      if (items.length < take) return { ...base, ok: true, domains: [...map.values()] };
      if (page === PAGE_CAP - 1) return { ...base, ok: true, domains: [...map.values()], capped: true };
    }
    return { ...base, ok: true, domains: [...map.values()] };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err), ok: map.size > 0, domains: [...map.values()] };
  }
}

// ── Dynadot: RESTful v2 GET /restful/v2/domains (HMAC-signed) ────────────────
async function dynadotInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const key = e.DYNADOT_API_KEY || "";
  const secret = e.DYNADOT_API_SECRET || e.DYNADOT_SECRET_KEY || "";
  const base: Omit<AccountInventory, "domains"> = { provider: "dynadot", label: "Dynadot", account: "", ok: false };
  if (!key || !secret) return { ...base, error: "not configured", domains: [] };
  const path = "/restful/v2/domains";
  const sig = dynadotSignature(key, secret, path, "");
  try {
    const res = await timed(`https://api.dynadot.com${path}`, {
      headers: { Authorization: `Bearer ${key}`, "X-Signature": sig, Accept: "application/json" },
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); return { ...base, error: `HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ""}`, domains: [] }; }
    const j = await res.json().catch(() => ({}));
    const map = new Map<string, DomainRecord>();
    for (const rec of extractDynadotDomains(j)) collect(map, rec);
    return { ...base, ok: true, domains: [...map.values()] };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err), domains: [] };
  }
}
// Dynadot's list wraps results in {Code, Message, Data} (PascalCase) and its exact
// nesting/field casing isn't pinned — so walk the whole JSON tree case-insensitively
// and collect every object that carries a domain-name field, reading expiry/renew from
// the same object. Robust to Data vs data, DomainName vs domainName, and deeper nesting.
function extractDynadotDomains(j: unknown): DomainRecord[] {
  const out: DomainRecord[] = [];
  const seen = new Set<string>();
  const NAME_KEYS = ["domainname", "domain_name", "domain"]; // domain-specific (avoids NS "name")
  const EXP_KEYS = ["expiration", "expirationdate", "expiration_date", "expires", "expireddate", "expiredate"];
  const RENEW_KEYS = ["autorenew", "auto_renew", "renewoption", "renew_option", "renewmode", "renew"];
  const ci = (o: Record<string, unknown>, keys: string[]): unknown => {
    for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase())) return o[k];
    return undefined;
  };
  const looksDomain = (s: unknown): s is string => typeof s === "string" && s.includes(".") && !/\s/.test(s);
  const add = (o: Record<string, unknown>, name: string) => {
    const domain = name.toLowerCase();
    if (seen.has(domain)) return;
    seen.add(domain);
    const exp = ci(o, EXP_KEYS);
    out.push({ domain, expires: looksDomain(exp) || typeof exp === "string" ? String(exp) : typeof exp === "number" ? String(exp) : null, autoRenew: asBool(ci(o, RENEW_KEYS)) });
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const name = ci(o, NAME_KEYS);
    if (looksDomain(name)) add(o, name);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(j);
  // Fallback: if domain-specific keys found nothing, accept a bare "name" but only on
  // objects that also carry an expiration field (so it's a domain row, not a nameserver).
  if (!out.length) {
    const walk2 = (node: unknown) => {
      if (Array.isArray(node)) { for (const x of node) walk2(x); return; }
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const name = ci(o, ["name"]);
      if (looksDomain(name) && ci(o, EXP_KEYS) !== undefined) add(o, name);
      for (const v of Object.values(o)) if (v && typeof v === "object") walk2(v);
    };
    walk2(j);
  }
  return out;
}

// Collect bare domain-name strings anywhere in a JSON tree (fallback for a list that
// returns ["a.com","b.com"] instead of objects). Domain-shaped = has a dot, no spaces.
function bareDomainStrings(j: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") { if (n.includes(".") && !/\s/.test(n) && /^[a-z0-9.-]+$/i.test(n)) out.push(n); return; }
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n && typeof n === "object") for (const v of Object.values(n)) walk(v);
  };
  walk(j);
  return out;
}

// ── NameBright: GET account/domains (OAuth2 bearer; page/domainsPerPage paging) ─
// Reuses the shared OAuth token + REST helper in adapters.ts. The list wrapper's exact
// shape/casing isn't pinned, so we reuse the same case-insensitive domain walk as
// Dynadot (DomainName / ExpirationDate / AutoRenew → domain/expires/autoRenew).
async function namebrightInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const base: Omit<AccountInventory, "domains"> = { provider: "namebright", label: "NameBright", account: "", ok: false };
  if (!e.NAMEBRIGHT_CLIENT_ID || !e.NAMEBRIGHT_CLIENT_SECRET) return { ...base, error: "not configured", domains: [] };
  const map = new Map<string, DomainRecord>();
  const perPage = 500; // few requests (rate limit is 30/30s); a modest owned account fits in 1-2 pages
  try {
    for (let page = 1; page <= PAGE_CAP; page++) {
      const res = await namebrightApi("GET", `account/domains?page=${page}&domainsPerPage=${perPage}`, e);
      if (!res) return { ...base, error: "auth failed (token / IP whitelist?)", ok: map.size > 0, domains: [...map.values()] };
      if (!res.ok) { const t = await res.text().catch(() => ""); return { ...base, error: `HTTP ${res.status}${t ? `: ${t.slice(0, 100)}` : ""}`, ok: map.size > 0, domains: [...map.values()] }; }
      const j = await res.json().catch(() => null);
      // Object rows (DomainName/ExpirationDate/AutoRenew, any wrapper/casing) via the
      // generic walk; PLUS a fallback for a bare array of domain-name strings.
      const rows = extractDynadotDomains(j);
      for (const r of rows) collect(map, r);
      if (!rows.length) for (const s of bareDomainStrings(j)) collect(map, { domain: s });
      if (rows.length < perPage) return { ...base, ok: true, domains: [...map.values()] };
      if (page === PAGE_CAP) return { ...base, ok: true, domains: [...map.values()], capped: true };
    }
    return { ...base, ok: true, domains: [...map.values()] };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err), ok: map.size > 0, domains: [...map.values()] };
  }
}

// ── NameSilo: GET listDomains (names only; success code 300) ─────────────────
// listDomains returns names without expiry/auto-renew (those need a per-domain
// getDomainInfo call — too many); those fields stay blank for NameSilo. NameSilo
// IP-allowlists API access, and Vercel IPs rotate, so route through the Fixie static
// IPs (whitelisted in NameSilo's API Manager) when available.
async function namesiloInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const base: Omit<AccountInventory, "domains"> = { provider: "namesilo", label: "NameSilo", account: "", ok: false };
  if (!e.NAMESILO_API_KEY) return { ...base, error: "not configured", domains: [] };
  const params = new URLSearchParams({ version: "1", type: "json", key: e.NAMESILO_API_KEY });
  const dispatcher = namecheapDispatcher(e); // reuses FIXIE_URL
  try {
    const res = dispatcher
      ? await undiciFetch(`https://www.namesilo.com/api/listDomains?${params.toString()}`, { dispatcher, signal: AbortSignal.timeout(20000) })
      : await timed(`https://www.namesilo.com/api/listDomains?${params.toString()}`, { method: "GET" });
    const j = (await res.json().catch(() => ({}))) as { reply?: { code?: string | number; detail?: string; domains?: { domain?: string | string[] } } };
    if (String(j?.reply?.code) !== "300") return { ...base, error: j?.reply?.detail || `code ${j?.reply?.code ?? res.status}`, domains: [] };
    const raw = j.reply?.domains?.domain;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const map = new Map<string, DomainRecord>();
    for (const d of list) collect(map, { domain: String(d) });
    return { ...base, ok: true, domains: [...map.values()] };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err), domains: [] };
  }
}

// ── GoDaddy: GET /v1/domains (marker paging), per account ────────────────────
async function godaddyInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory[]> {
  const accounts = godaddyAccounts(e);
  if (!accounts.length) return [{ provider: "godaddy", label: "GoDaddy", account: "", ok: false, domains: [], error: "not configured" }];
  return Promise.all(accounts.map(async (acct): Promise<AccountInventory> => {
    const base: Omit<AccountInventory, "domains"> = { provider: "godaddy", label: `GoDaddy (${acct.account})`, account: acct.account, ok: false };
    const map = new Map<string, DomainRecord>();
    let marker = "";
    try {
      for (let page = 0; page < PAGE_CAP; page++) {
        const url = `https://api.godaddy.com/v1/domains?limit=1000&statuses=ACTIVE${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
        const res = await timed(url, { headers: { Authorization: `sso-key ${acct.key}:${acct.secret}`, Accept: "application/json" } });
        if (!res.ok) { const t = await res.text().catch(() => ""); return { ...base, error: `HTTP ${res.status}${t ? `: ${t.slice(0, 100)}` : ""}`, ok: map.size > 0, domains: [...map.values()] }; }
        const rows = (await res.json().catch(() => [])) as { domain?: string; expires?: string; renewAuto?: unknown }[];
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) if (r.domain) collect(map, { domain: r.domain, expires: r.expires || null, autoRenew: asBool(r.renewAuto) });
        if (rows.length < 1000) return { ...base, ok: true, domains: [...map.values()] };
        marker = rows[rows.length - 1].domain || "";
        if (!marker) break;
        if (page === PAGE_CAP - 1) return { ...base, ok: true, domains: [...map.values()], capped: true };
      }
      return { ...base, ok: true, domains: [...map.values()] };
    } catch (err) {
      return { ...base, error: String((err as Error)?.message || err), ok: map.size > 0, domains: [...map.values()] };
    }
  }));
}

// ── Namecheap: GET domains.getList via Fixie proxy, per account (page paging) ─
async function namecheapInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory[]> {
  const accounts = namecheapAccounts(e);
  const dispatcher = namecheapDispatcher(e);
  const clientIp = (e.NAMECHEAP_CLIENT_IP || "").split(",")[0].trim();
  if (!accounts.length || !dispatcher || !clientIp) {
    return [{ provider: "namecheap", label: "Namecheap", account: "", ok: false, domains: [], error: !accounts.length ? "no account" : !dispatcher ? "no proxy (FIXIE_URL)" : "no NAMECHEAP_CLIENT_IP" }];
  }
  return Promise.all(accounts.map(async (a): Promise<AccountInventory> => {
    const base: Omit<AccountInventory, "domains"> = { provider: "namecheap", label: `Namecheap (${a.account})`, account: a.account, ok: false };
    const map = new Map<string, DomainRecord>();
    try {
      for (let page = 1; page <= PAGE_CAP; page++) {
        const params = new URLSearchParams({
          ApiUser: a.apiUser, ApiKey: a.apiKey, UserName: a.username, ClientIp: clientIp,
          Command: "namecheap.domains.getList", PageSize: "100", Page: String(page),
        });
        const res = await undiciFetch(`https://api.namecheap.com/xml.response?${params.toString()}`, { dispatcher, signal: AbortSignal.timeout(20000) });
        const xml = await res.text();
        if (!/Status="OK"/i.test(xml)) { const m = xml.match(/<Error[^>]*>([^<]+)<\/Error>/i); return { ...base, error: `Namecheap: ${m ? m[1].trim() : `HTTP ${res.status}`}`, ok: map.size > 0, domains: [...map.values()] }; }
        const tags = [...xml.matchAll(/<Domain\b([^>]*)>/gi)].map((m) => m[1]);
        for (const attrs of tags) {
          const name = attrs.match(/\bName="([^"]+)"/i)?.[1];
          if (!name) continue;
          collect(map, { domain: name, expires: attrs.match(/\bExpires="([^"]*)"/i)?.[1] || null, autoRenew: asBool(attrs.match(/\bAutoRenew="([^"]*)"/i)?.[1]) });
        }
        const total = Number(xml.match(/<TotalItems>(\d+)<\/TotalItems>/i)?.[1] || tags.length);
        if (page * 100 >= total || tags.length < 100) return { ...base, ok: true, domains: [...map.values()] };
        if (page === PAGE_CAP) return { ...base, ok: true, domains: [...map.values()], capped: true };
      }
      return { ...base, ok: true, domains: [...map.values()] };
    } catch (err) {
      return { ...base, error: String((err as Error)?.message || err), ok: map.size > 0, domains: [...map.values()] };
    }
  }));
}

// Build the full multi-account inventory (every provider in parallel, fail-open).
export async function listAllInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory[]> {
  const settled = await Promise.allSettled<AccountInventory | AccountInventory[]>([
    porkbunInventory(e),
    spaceshipInventory(e),
    dynadotInventory(e),
    namesiloInventory(e),
    godaddyInventory(e),
    namecheapInventory(e),
    namebrightInventory(e),
  ]);
  const out: AccountInventory[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    if (Array.isArray(s.value)) out.push(...s.value);
    else out.push(s.value);
  }
  return out;
}

// A domain → the account it was found in + its expiry/auto-renew (first hit wins).
export interface OwnedAt {
  provider: ProviderId;
  label: string;
  account: string;
  expires?: string | null;
  autoRenew?: boolean | null;
}
export function ownershipMap(inv: AccountInventory[]): Record<string, OwnedAt> {
  const map: Record<string, OwnedAt> = {};
  for (const acc of inv) {
    if (!acc.ok) continue;
    for (const r of acc.domains) if (!map[r.domain]) map[r.domain] = { provider: acc.provider, label: acc.label, account: acc.account, expires: r.expires ?? null, autoRenew: r.autoRenew ?? null };
  }
  return map;
}
