// SNAP Names report — aggregate every domain we've purchased / hold for sale
// across the two owner spreadsheets into ONE list. Read-only (Google Sheets via
// the shared service account). Columns are matched by HEADER NAME (tolerant of
// reordering / renames), so the report survives small sheet edits.
//
// Sources:
//  - "SNAP Tracker (Berserk)" → Purchases tab      → label "Berserk"
//  - "SNAP / Rob Schutz Domain Purchases":
//       SNAP Domains tab   → label "SNAP"
//       Rob Purchases tab  → label "Rob"
//
// V1 = pull everything into one report. V2 (later) will go LIVE-look-up the
// Spaceship / marketplace / registrar / nameserver state per name.

import { getSheetValues } from "./sheets";

const SHEET_BERSERK = "1oHfG8FYlTTclnB-gi0IkkhbqnXXYfeewOBiZn9Hds4M";
const SHEET_SNAP_ROB = "1KaxYUgBFALe_T0F8-6D0kb7mWy-eU5CkIbX6BGmyK4g";

// The Snagged.com marketplace is a Webflow CMS site that server-renders every
// listed domain as a card with aria-label="<Domain.tld>". Scraping that page is
// the AUTHORITATIVE "is it live on our marketplace" check (the nameserver proxy
// disagreed for some names). Cached in-process for an hour — it's one catalog.
let mktSet: Set<string> | null = null;
let mktAt = 0;
export async function snaggedMarketplaceSet(): Promise<Set<string>> {
  if (mktSet && Date.now() - mktAt < 3600 * 1000) return mktSet;
  try {
    const res = await fetch("https://www.snagged.com/marketplace", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const html = await res.text();
    const set = new Set<string>();
    for (const m of html.matchAll(/aria-label="([^"]+\.[a-z]{2,})"/gi)) {
      const d = m[1].trim().toLowerCase();
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) set.add(d);
    }
    if (set.size) {
      mktSet = set;
      mktAt = Date.now();
    }
    return mktSet || set;
  } catch {
    return mktSet || new Set(); // fail-open: keep last good, else empty
  }
}

export type SnapSource = "Berserk" | "SNAP" | "Rob";

export interface SnapName {
  domain: string;
  source: SnapSource;
  tld: string;
  date_purchased: string | null;
  purchase_price: number | null;
  internal_price: number | null;
  spaceship_price: number | null;
  atom_price: string | null; // raw — mixed ("No BIN", "4995 (listed in Afternic)", "$21,500")
  on_marketplace: boolean | null; // Marketplace? Yes/No
  platform: string | null; // registrar
  still_owned: string | null; // Yes / SOLD / No (raw)
  sold: boolean;
  sold_for: number | null;
  sale_date: string | null;
  fees: number | null; // Rob tab
  net_sale_price: number | null; // Rob tab
  list_for_sale: string | null; // Rob tab
  snagged_rep: string | null;
  premium: string | null;
  active: string | null;
  notes: string | null;
  also_in: SnapSource[]; // other lists this domain also appears on (dedupe trail)
  also_spellings: string[]; // typo variants folded in (e.g. a misspelling in one sheet)
  on_snagged_marketplace: boolean; // authoritative: scraped from snagged.com/marketplace
}

export interface SnapNamesReport {
  rows: SnapName[];
  summary: {
    total: number;
    owned: number;
    sold: number;
    on_marketplace: number;
    total_internal_value: number; // sum internal_price of still-owned
    total_sold_for: number; // sum sold_for
    bySource: Record<SnapSource, number>;
    generatedAt: string;
  };
}

// ── parsing helpers ─────────────────────────────────────────────────────────

function parseMoney(v: string | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.replace(/[$,]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function yesNo(v: string | undefined): boolean | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|x|✓)$/.test(s)) return true;
  if (/^(n|no|false)$/.test(s)) return false;
  return null;
}

const clean = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

function tldOf(domain: string): string {
  const i = domain.lastIndexOf(".");
  return i < 0 ? "" : domain.slice(i + 1).toLowerCase();
}

const sldOf = (domain: string): string => domain.slice(0, domain.lastIndexOf(".") || domain.length);

// Damerau-Levenshtein distance capped at 2 (transposition counts as 1). Used only
// to decide "these two SLDs differ by a single typo" — cheap for short strings.
function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return 99;
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[la][lb];
}

// Build a header→index map. Match is case-insensitive and by first header cell
// whose normalized text CONTAINS the wanted token (so "Marketplace?" matches
// "marketplace"). Returns a getter over a data row.
function columnGetter(header: string[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const idx = header.map(norm);
  return (row: string[], ...wanted: string[]): string | undefined => {
    for (const w of wanted) {
      const key = norm(w);
      // exact first, then contains
      let at = idx.indexOf(key);
      if (at < 0) at = idx.findIndex((h) => h === key);
      if (at < 0) at = idx.findIndex((h) => h.includes(key) && key.length >= 3);
      if (at >= 0) return row[at];
    }
    return undefined;
  };
}

// ── per-tab normalizers ─────────────────────────────────────────────────────

function normalizeRows(values: string[][], source: SnapSource): SnapName[] {
  if (!values || values.length < 2) return [];
  const header = values[0] || [];
  const get = columnGetter(header);
  const out: SnapName[] = [];
  for (const row of values.slice(1)) {
    const domain = clean(get(row, "domain", "asset name", "asset"))?.toLowerCase() || "";
    if (!domain || !domain.includes(".")) continue;
    const ownedRaw = clean(get(row, "still owned", "still owned?"));
    const soldForRaw = get(row, "sold for");
    const soldFor = parseMoney(soldForRaw);
    const sold = /sold/i.test(ownedRaw || "") || soldFor != null;
    out.push({
      domain,
      source,
      tld: tldOf(domain),
      date_purchased: clean(get(row, "date")),
      purchase_price: parseMoney(get(row, "purchase price", "purchase")),
      internal_price: parseMoney(get(row, "internal price", "internal")),
      spaceship_price: parseMoney(get(row, "spaceship price", "spaceship")),
      atom_price: clean(get(row, "atom current price", "atom")),
      on_marketplace: yesNo(get(row, "marketplace", "marketplace?")),
      platform: clean(get(row, "platform", "registrar")),
      still_owned: ownedRaw,
      sold,
      sold_for: soldFor,
      sale_date: clean(get(row, "sale date")),
      fees: parseMoney(get(row, "fees")),
      net_sale_price: parseMoney(get(row, "net sale price", "net sale")),
      list_for_sale: clean(get(row, "list for sale", "list for sale?")),
      snagged_rep: clean(get(row, "snagged rep", "snagged rep?")),
      premium: clean(get(row, "premium", "premium?")),
      active: clean(get(row, "active", "active?")),
      notes: clean(get(row, "notes")),
      also_in: [],
      also_spellings: [],
      on_snagged_marketplace: false,
    });
  }
  return out;
}

// ── report builder ──────────────────────────────────────────────────────────

export async function buildSnapNames(): Promise<SnapNamesReport> {
  const [berserk, snap, rob, marketplace] = await Promise.all([
    getSheetValues(SHEET_BERSERK, "'Purchases'!A1:Z5000").catch(() => [] as string[][]),
    getSheetValues(SHEET_SNAP_ROB, "'SNAP Domains'!A1:Z5000").catch(() => [] as string[][]),
    getSheetValues(SHEET_SNAP_ROB, "'Rob Purchases'!A1:Z5000").catch(() => [] as string[][]),
    snaggedMarketplaceSet(),
  ]);

  const all: SnapName[] = [
    ...normalizeRows(berserk, "Berserk"),
    ...normalizeRows(snap, "SNAP"),
    ...normalizeRows(rob, "Rob"),
  ];

  // De-dupe to ONE row per domain. Precedence Berserk > SNAP > Rob: the highest-
  // precedence row is the base ("default to whatever is on the Berserk list"), and
  // any field it leaves null is filled from the lower-precedence duplicate so we
  // don't lose data the base row happens to be missing (Berserk rows carry no
  // Platform/Atom, which SNAP does). `also_in` records the other lists it's on.
  const RANK: Record<SnapSource, number> = { Berserk: 0, SNAP: 1, Rob: 2 };
  const byDomain = new Map<string, SnapName>();
  for (const r of all) {
    const existing = byDomain.get(r.domain);
    if (!existing) {
      byDomain.set(r.domain, { ...r });
      continue;
    }
    const [win, lose] = RANK[r.source] < RANK[existing.source] ? [r, existing] : [existing, r];
    const merged: SnapName = { ...win };
    // fill nulls on the winner from the loser
    for (const k of Object.keys(merged) as (keyof SnapName)[]) {
      if ((merged[k] == null || merged[k] === "") && lose[k] != null && lose[k] !== "") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[k] = lose[k];
      }
    }
    merged.source = win.source;
    merged.sold = win.sold || lose.sold;
    const others = new Set<SnapSource>([...(existing.also_in || []), ...(r.also_in || []), existing.source, r.source]);
    others.delete(win.source);
    merged.also_in = [...others];
    byDomain.set(r.domain, merged);
  }
  let rows: SnapName[] = [...byDomain.values()];
  // Authoritative "live on the Snagged marketplace" from the scraped catalog.
  for (const r of rows) r.on_snagged_marketplace = marketplace.has(r.domain);

  // Fold in TYPO variants — the same deal entered with a misspelling in one sheet
  // (e.g. spiltter.com vs splitter.com). VERY tight guard so we never merge two
  // genuinely different names: same TLD + EXACT same purchase price + SLDs differ
  // by a single edit/transposition. Canonical = the marketplace-listed spelling,
  // else the higher-precedence source; the loser's spelling is kept in
  // also_spellings for transparency.
  {
    const used = new Set<string>();
    const merged: SnapName[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (used.has(rows[i].domain)) continue;
      const a = rows[i];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (used.has(b.domain)) continue;
        if (a.tld !== b.tld) continue;
        if (a.purchase_price == null || b.purchase_price == null || a.purchase_price !== b.purchase_price) continue;
        if (editDistance(sldOf(a.domain), sldOf(b.domain)) > 1) continue;
        // b is a near-duplicate of a. Choose the canonical spelling (marketplace-
        // listed wins, else higher-precedence source), but ALWAYS survive in a's
        // slot (b is the absorbed one) so the outer loop's bookkeeping stays sound.
        const canon = a.on_snagged_marketplace || (!b.on_snagged_marketplace && RANK[a.source] <= RANK[b.source]) ? a : b;
        const other = canon === a ? b : a;
        const mergedRow: SnapName = { ...canon };
        for (const k of Object.keys(mergedRow) as (keyof SnapName)[]) {
          if ((mergedRow[k] == null || mergedRow[k] === "") && other[k] != null && other[k] !== "") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (mergedRow as any)[k] = other[k];
          }
        }
        mergedRow.on_snagged_marketplace = a.on_snagged_marketplace || b.on_snagged_marketplace;
        mergedRow.also_spellings = [...new Set([...(a.also_spellings || []), ...(b.also_spellings || []), other.domain])];
        mergedRow.also_in = [...new Set([...(a.also_in || []), ...(b.also_in || []), other.source])].filter((s) => s !== mergedRow.source) as SnapSource[];
        Object.assign(a, mergedRow); // a's slot now holds the canonical merged row
        used.add(b.domain);
      }
      merged.push(a);
    }
    rows = merged;
  }

  const bySource: Record<SnapSource, number> = { Berserk: 0, SNAP: 0, Rob: 0 };
  let owned = 0;
  let sold = 0;
  let onMkt = 0;
  let internalValue = 0;
  let soldForTotal = 0;
  for (const r of rows) {
    bySource[r.source] += 1;
    if (r.sold) {
      sold += 1;
      if (r.sold_for) soldForTotal += r.sold_for;
    } else {
      owned += 1;
      if (r.internal_price) internalValue += r.internal_price;
    }
    if (r.on_snagged_marketplace) onMkt += 1; // authoritative live-on-marketplace count
  }

  return {
    rows,
    summary: {
      total: rows.length,
      owned,
      sold,
      on_marketplace: onMkt,
      total_internal_value: internalValue,
      total_sold_for: soldForTotal,
      bySource,
      generatedAt: new Date().toISOString(),
    },
  };
}
