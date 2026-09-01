// Verify a domain's LIVE Afternic Buy-It-Now price.
//
// The Afternic partner FEED price can go stale between refreshes: a seller raises
// the storefront BIN but our cached feed still carries the old number. For a
// value-÷-cost pick that's dangerous — a stale-LOW cost INFLATES the ratio and
// manufactures a FALSE bargain (e.g. sauce.ai was fed $75k while the live Afternic
// BIN was $295k → a fake 2.4× "worth a look" pick). The picks builder re-prices
// afternic-sourced candidates against this live read before ranking.
//
// Fail-open everywhere: any error / no match → null → the caller keeps the feed price.
// Dependency-free (Node fetch), mirrors the research app's sweep.js afternicBin parse.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Live BIN in whole USD for one domain, or null if unreadable / not a firm BIN. */
export async function afternicBin(domain: string, timeoutMs = 6000): Promise<number | null> {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://www.afternic.com/domain/${encodeURIComponent(d)}`, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html,*/*" },
    });
    if (!res.ok) return null;
    const body = await res.text();
    // The Next.js lander embeds "buyNow":<micros> (price × 1e6). ≥6 digits = ≥$1, so a
    // stray small number can't match; the domain's own BIN is the first occurrence.
    const m = body.match(/"buyNow"\s*:\s*(\d{6,})/i);
    if (!m) return null;
    const usd = Math.round(Number(m[1]) / 1e6);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a batch with bounded concurrency. Returns a domain→liveBIN map holding ONLY
 * the domains we could read (fail-open per domain — an unreadable one is simply absent,
 * so the caller falls back to the feed price).
 */
export async function afternicBins(domains: string[], concurrency = 8): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(domains.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))];
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const d = uniq[i++];
      const bin = await afternicBin(d);
      if (bin != null) out.set(d, bin);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, () => worker()));
  return out;
}
