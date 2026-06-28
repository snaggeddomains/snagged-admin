// Internal server-to-server endpoint so the research app's SNAP Eval can pull
// REAL transaction comps from the Snagged Domain Tracker's "Master Txns List" tab
// — every recorded transaction (domain + the price it changed hands at). These are
// actual sale prices, the gold-standard comp (vs marketplace asking prices).
// Columns are auto-detected by content (domain-like + money-like) so the tab's
// exact headers don't have to be hard-coded.
//
// Auth: shared secret header `x-internal-secret` == RESEARCH_INTERNAL_SECRET
// (same machine-to-machine pattern as /api/internal/email-threads). Read-only.
//
//   GET ?sld=outline&tld=ai&len=7[&max=25]
//     -> { configured, deals:[{domain,price,status,relation}], total_priced, generated_at }
//
// `relation`: "same_sld" (the exact word on any TLD — strongest), "same_tld"
// (same extension, similar length), or "other" (kept only if nothing better).

import { NextResponse, type NextRequest } from "next/server";
import { getSheetValues } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SHEET_ID = process.env.SNAGGED_TRACKER_SHEET_ID || "1TVAJ2ef_rM03pHZ9rq8C3W4BgyiSBiOc5j7jAbFzGTA";
// The "Master Txns List" tab — every recorded transaction. Quote the tab name
// (it has spaces); getSheetValues URL-encodes the range.
const TXNS_RANGE = process.env.SNAGGED_TXNS_RANGE || "'Master Txns List'!A1:Z20000";

type Deal = { domain: string; sld: string; tld: string; price: number; status: string; date: string };

function configured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64);
}

function authStatus(req: NextRequest): "ok" | "unconfigured" | "mismatch" {
  const secret = process.env.RESEARCH_INTERNAL_SECRET || "";
  if (!secret) return "unconfigured";
  const got = (req.headers.get("x-internal-secret") || "").trim();
  return got === secret.trim() ? "ok" : "mismatch";
}

function money(v: string | undefined): number {
  if (!v) return 0;
  const x = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

const normDomain = (v: string | undefined): string =>
  String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.[a-z][a-z.]+$/;

// Pick the domain column + the (sale) price column by CONTENT, so the tab's exact
// headers don't matter: the domain column is whichever has the most domain-shaped
// values; the price column is whichever non-domain column has the most money-shaped
// values, preferring a header that names a sale price.
function detectColumns(rows: string[][]): { domainCol: number; priceCol: number; dateCol: number } {
  const header = (rows[0] || []).map((h) => String(h || "").toLowerCase());
  const sample = rows.slice(1, 250);
  const cols = Math.max(...rows.slice(0, 250).map((r) => r.length), 0);
  let domainCol = -1, domainHits = 0;
  const moneyHits: number[] = [];
  for (let c = 0; c < cols; c++) {
    let dh = 0, mh = 0;
    for (const r of sample) {
      if (DOMAIN_RE.test(normDomain(r[c]))) dh++;
      if (money(r[c]) > 50) mh++;
    }
    moneyHits[c] = mh;
    if (dh > domainHits) { domainHits = dh; domainCol = c; }
  }
  // Price column: prefer a header naming a price/amount/sale; else the most
  // money-dense non-domain column.
  let priceCol = -1;
  let bestHeaderScore = -1;
  for (let c = 0; c < cols; c++) {
    if (c === domainCol) continue;
    const h = header[c] || "";
    const headerScore = /sale|sold|final|price|amount|paid|usd|value/.test(h) ? (/sale|sold|final/.test(h) ? 3 : /price|amount/.test(h) ? 2 : 1) : 0;
    const score = headerScore * 1000 + (moneyHits[c] || 0);
    if ((moneyHits[c] || 0) > 0 && score > bestHeaderScore) { bestHeaderScore = score; priceCol = c; }
  }
  // Optional date column by header.
  let dateCol = -1;
  for (let c = 0; c < cols; c++) { if (/date|closed|when/.test(header[c] || "")) { dateCol = c; break; } }
  return { domainCol, priceCol, dateCol };
}

// Parse the Master Txns List into priced transactions. Cached in-memory for 5 min
// so a batch of SNAP Eval runs doesn't re-read the whole sheet per domain.
let CACHE: { at: number; deals: Deal[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function loadDeals(now: number): Promise<Deal[]> {
  if (CACHE && now - CACHE.at < TTL_MS) return CACHE.deals;
  const rows = await getSheetValues(SHEET_ID, TXNS_RANGE);
  const deals: Deal[] = [];
  if (rows.length > 1) {
    const { domainCol, priceCol, dateCol } = detectColumns(rows);
    if (domainCol >= 0 && priceCol >= 0) {
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const raw = normDomain(r[domainCol]);
        const price = money(r[priceCol]);
        if (!raw || price <= 0 || !DOMAIN_RE.test(raw)) continue;
        const dot = raw.indexOf(".");
        const sld = raw.slice(0, dot);
        const tld = raw.slice(dot + 1);
        deals.push({ domain: raw, sld, tld, price, status: "", date: dateCol >= 0 ? String(r[dateCol] || "").trim() : "" });
      }
    }
  }
  CACHE = { at: now, deals };
  return deals;
}

export async function GET(req: NextRequest) {
  const auth = authStatus(req);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "Server has no RESEARCH_INTERNAL_SECRET configured (set it on snagged-admin and redeploy)." }, { status: 503 });
  }
  if (auth === "mismatch") {
    return NextResponse.json({ error: "Secret mismatch — set RESEARCH_INTERNAL_SECRET to the same value in both projects." }, { status: 401 });
  }
  if (!configured()) {
    return NextResponse.json({ configured: false, deals: [], total_priced: 0 }, { status: 200 });
  }

  const sld = String(req.nextUrl.searchParams.get("sld") || "").trim().toLowerCase();
  const tld = String(req.nextUrl.searchParams.get("tld") || "").trim().toLowerCase().replace(/^\./, "");
  const len = Number(req.nextUrl.searchParams.get("len")) || (sld ? sld.length : 0);
  const max = Math.min(Math.max(Number(req.nextUrl.searchParams.get("max")) || 25, 1), 50);

  try {
    // Date.now() is fine here (admin app, not a workflow script).
    const deals = await loadDeals(Date.now());
    const scored = deals
      .map((d) => {
        let relation: "same_sld" | "same_tld" | "other" = "other";
        let rank = 0;
        if (sld && d.sld === sld) { relation = "same_sld"; rank = 100; } // exact word, any TLD
        else if (tld && d.tld === tld && len && Math.abs(d.sld.length - len) <= 2) { relation = "same_tld"; rank = 60 - Math.abs(d.sld.length - len); }
        else if (tld && d.tld === tld) { relation = "same_tld"; rank = 30; }
        return { ...d, relation, rank };
      })
      .filter((d) => d.rank > 0)
      .sort((a, b) => b.rank - a.rank || b.price - a.price)
      .slice(0, max)
      .map((d) => ({ domain: d.domain, price: d.price, date: d.date, relation: d.relation }));

    return NextResponse.json({
      configured: true,
      deals: scored,
      total_priced: deals.length,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ configured: true, deals: [], total_priced: 0, error: String((e as Error)?.message || e) }, { status: 200 });
  }
}
