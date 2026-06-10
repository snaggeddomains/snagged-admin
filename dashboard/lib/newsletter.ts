// Newsletter feature attribution — which CURRENT marketplace listings were
// featured in which MailChimp sends, with dates. Two flavors:
//   • for_sale — the monthly "Domain Spotlight" / "[New Domains]: A, B, C" send
//   • content  — the weekly story send, where listings are promoted in a small
//                mention / CTA at the BOTTOM of the email body (NOT the subject —
//                the subject domain is the story, which we ignore).
// So we scan each campaign's HTML BODY, keep only domains that are live listings,
// and classify by campaign type. Scanning ~130 bodies is too slow per report view,
// so a cron backfills the newsletter_features cache (scripts/newsletter_cache.sql)
// and the Marketplace report reads from it. Incremental: campaigns already in
// newsletter_scanned are never re-fetched.
//
// Env: MAILCHIMP_API_KEY (MailChimp) + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (cache).

import { getDb, isDbConfigured } from "./supabase";
import { marketplaceListingDomains } from "./ga";

function mcConfig(): { key: string; dc: string } {
  const key = (process.env.MAILCHIMP_API_KEY || "").trim();
  const dc = key.includes("-") ? key.split("-").pop() || "" : "";
  return { key, dc };
}
export function newsletterConfigured(): boolean {
  const { key, dc } = mcConfig();
  return Boolean(key && dc && isDbConfigured());
}
async function mc<T = unknown>(path: string): Promise<T> {
  const { key, dc } = mcConfig();
  if (!key || !dc) throw new Error("MAILCHIMP_API_KEY missing or malformed");
  const auth = Buffer.from(`anystring:${key}`).toString("base64");
  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, {
    headers: { Authorization: `Basic ${auth}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Mailchimp ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as T;
}

export type NewsletterType = "for_sale" | "content";
export type NewsletterFeature = { date: string | null; type: NewsletterType; subject: string; archiveUrl: string | null };
export type NewsletterSummary = { count: number; forSale: number; content: number; lastDate: string | null; dates: string[] };

const DOMAIN_RE = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|co|xyz|app|st|me|tv|so))\b/gi;
type McCampaign = { id: string; send_time?: string; long_archive_url?: string; settings?: { subject_line?: string; title?: string } };

// Pull every domain-looking token out of a campaign's body (anchor text, hrefs,
// plain text), lowercased + de-duped.
function domainsInHtml(html: string): string[] {
  return [...new Set((String(html || "").match(DOMAIN_RE) || []).map((d) => d.toLowerCase()))];
}

// Scan sent campaigns, keep only current-listing domains, upsert to the cache.
// Incremental by default (skips campaigns already in newsletter_scanned); pass
// { rescan: true } to re-scan everything (e.g. after the listing set changes).
export async function syncNewsletterFeatures(opts: { rescan?: boolean } = {}): Promise<{ scanned: number; featured: number }> {
  const db = getDb();
  const listings = new Set((await marketplaceListingDomains()).map((d) => d.toLowerCase()));

  const seen = new Set<string>();
  if (!opts.rescan) {
    const { data } = await db.from("newsletter_scanned").select("campaign_id");
    for (const r of data || []) seen.add(r.campaign_id as string);
  }

  const list = await mc<{ campaigns?: McCampaign[] }>("/campaigns?count=1000&status=sent&sort_field=send_time&sort_dir=DESC");
  const campaigns = (list.campaigns || []).filter((c) => !seen.has(c.id));

  let featured = 0;
  // Bounded concurrency so a backfill doesn't hammer the MailChimp API.
  const queue = [...campaigns];
  const featureRows: { domain: string; campaign_id: string; send_date: string | null; subject: string; type: NewsletterType; archive_url: string | null }[] = [];
  const scannedRows: { campaign_id: string; send_date: string | null }[] = [];
  async function worker() {
    while (queue.length) {
      const c = queue.shift()!;
      const subject = c.settings?.subject_line || "";
      const title = c.settings?.title || "";
      const date = (c.send_time || "").slice(0, 10) || null;
      const isForSale = /domain spotlight/i.test(title) || /\[?new domains/i.test(subject);
      let html = "";
      try { html = (await mc<{ html?: string }>(`/campaigns/${c.id}/content`)).html || ""; } catch { html = ""; }
      const hits = domainsInHtml(html).filter((d) => listings.has(d));
      for (const domain of hits) {
        featureRows.push({ domain, campaign_id: c.id, send_date: date, subject: subject.slice(0, 160), type: isForSale ? "for_sale" : "content", archive_url: c.long_archive_url || null });
        featured++;
      }
      scannedRows.push({ campaign_id: c.id, send_date: date });
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, campaigns.length) || 1 }, worker));

  // Chunked upserts (PostgREST payload limits).
  const chunk = <T,>(a: T[], n: number) => a.length ? Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n)) : [];
  // Resilient to the archive_url column not existing yet (pre-migration): on a
  // missing-column error, retry the chunk without it.
  const missingCol = (e: { message?: string; code?: string } | null) => !!e && /archive_url|column|PGRST204|42703|schema cache/i.test(`${e.message || ""} ${e.code || ""}`);
  for (const part of chunk(featureRows, 500)) {
    const { error } = await db.from("newsletter_features").upsert(part, { onConflict: "domain,campaign_id" });
    if (missingCol(error)) await db.from("newsletter_features").upsert(part.map(({ archive_url: _x, ...r }) => r), { onConflict: "domain,campaign_id" });
  }
  for (const part of chunk(scannedRows, 500)) await db.from("newsletter_scanned").upsert(part, { onConflict: "campaign_id" });

  return { scanned: campaigns.length, featured };
}

// Read the cache → domain (lowercased) → its newsletter appearances.
export async function getNewsletterFeatures(): Promise<Record<string, NewsletterFeature[]>> {
  if (!isDbConfigured()) return {};
  const db = getDb();
  const { data, error } = await db.from("newsletter_features").select("*"); // '*' so archive_url rides along when present
  if (error || !data) return {};
  const out: Record<string, NewsletterFeature[]> = {};
  for (const r of data) {
    const d = String(r.domain).toLowerCase();
    (out[d] ||= []).push({ date: r.send_date as string | null, type: (r.type as NewsletterType) || "content", subject: (r.subject as string) || "", archiveUrl: (r.archive_url as string) || null });
  }
  for (const d of Object.keys(out)) out[d].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}

export function summarizeNewsletter(items: NewsletterFeature[] | undefined): NewsletterSummary {
  const arr = items || [];
  const dates = arr.map((i) => i.date).filter((x): x is string => !!x).sort();
  return {
    count: arr.length,
    forSale: arr.filter((i) => i.type === "for_sale").length,
    content: arr.filter((i) => i.type === "content").length,
    lastDate: dates.length ? dates[dates.length - 1] : null,
    dates: [...new Set(dates)].reverse(),
  };
}
