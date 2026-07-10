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

import { createHmac, randomUUID } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { godaddyAccounts, namecheapAccounts, type ProviderId } from "./registry";
import { namecheapDispatcher } from "./adapters";

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
  const requestId = randomUUID();
  const sig = createHmac("sha256", secret).update(`${key}\n${path}\n${requestId}\n`).digest("base64");
  try {
    const res = await timed(`https://api.dynadot.com${path}`, {
      headers: { Authorization: `Bearer ${key}`, "X-Signature": sig, "X-Request-Id": requestId, Accept: "application/json" },
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
// Dynadot's list shape isn't fully pinned; pull records from the known containers
// defensively so a shape tweak doesn't silently return nothing.
function extractDynadotDomains(j: unknown): DomainRecord[] {
  const out: DomainRecord[] = [];
  const containers: unknown[] = [];
  const root = (j as Record<string, unknown>) || {};
  const data = (root.data as Record<string, unknown>) || root;
  for (const k of ["domains", "domainInfo", "domainList", "list"]) {
    const v = (data as Record<string, unknown>)?.[k] ?? (root as Record<string, unknown>)?.[k];
    if (Array.isArray(v)) containers.push(...v);
  }
  for (const item of containers) {
    if (typeof item === "string") { out.push({ domain: item }); continue; }
    const o = item as Record<string, unknown>;
    const d = o?.domainName || o?.name || o?.domain;
    if (typeof d !== "string") continue;
    const expires = (o?.expiration || o?.expirationDate || o?.expires || o?.expiredDate) as string | undefined;
    const renew = o?.autoRenew ?? o?.renewOption ?? o?.renew_option;
    out.push({ domain: d, expires: typeof expires === "string" ? expires : null, autoRenew: asBool(renew) });
  }
  return out;
}

// ── NameSilo: GET listDomains (names only; success code 300) ─────────────────
// listDomains returns names without expiry/auto-renew (those need a per-domain
// getDomainInfo call — too many); those fields stay blank for NameSilo.
async function namesiloInventory(e: NodeJS.ProcessEnv): Promise<AccountInventory> {
  const base: Omit<AccountInventory, "domains"> = { provider: "namesilo", label: "NameSilo", account: "", ok: false };
  if (!e.NAMESILO_API_KEY) return { ...base, error: "not configured", domains: [] };
  const params = new URLSearchParams({ version: "1", type: "json", key: e.NAMESILO_API_KEY });
  try {
    const res = await timed(`https://www.namesilo.com/api/listDomains?${params.toString()}`, { method: "GET" });
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
