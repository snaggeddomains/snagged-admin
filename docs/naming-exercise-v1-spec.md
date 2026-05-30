# Naming Exercise v1 — Implementation Spec (Research Repo Handoff)

**Status:** Ready to build. All data + schema work is complete on the
admin side. This doc is the single source of truth for the research-repo
session that wires the existing `/naming` page to live data.

**Audience:** Future Claude session pointed at `snaggeddomains/snagged-research`,
or any human implementer.

---

## 1. What exists today

### 1.1 Existing GUI placeholder

The research app already has a `/naming` route at `research.snagged.com/naming`
with a textarea-style brief input and a "Coming soon" button. The shell is
in place; we just need to make the button do work.

### 1.2 The data layer (Supabase, separate project from Snagged main)

Project: `snagged-naming-universe` (separate from the existing Snagged
Supabase). All universe data lives in one table, `name_universe`.

**Schema** (relevant columns for the naming exercise):

```sql
domain              text PRIMARY KEY           -- e.g., "table.com"
sld                 text                       -- "table"
tld                 text                       -- ".com"
sld_length          smallint                   -- 5
zipf_score          numeric(4,2)               -- e.g., 5.13 (English frequency)
sources             text[]                     -- ['afternic', 'atom_daily', ...]
best_price          numeric(12,2)              -- cheapest across all sources
best_price_source   text                       -- which source has the cheapest
num_words           smallint                   -- 1 or 2 (per our dict-word filter)
num_syllables       smallint
is_dictionary_word  boolean                    -- true if num_words == 1
quality_score       numeric(5,2)               -- zipf × tld_weight (0-7 typical)
deal_score          integer                    -- (zipf × tld_weight) / price × 10000, int
source_tier         smallint                   -- 1 = owned, 2 = market
first_seen          date
last_seen           date
```

**Foreign data wrapper (FDW)** to the existing Snagged Supabase exposes
`master_domain_list` (curated metadata: category, keywords, emotions,
root_words, dictionary_word, etc.). Available as table
`master_domain_list` on the naming Supabase — just JOIN by `domain`.

**Size today:** ~6.27M domains across all sources. Tier-1 (owned) is in
the low thousands; tier-2 is the bulk.

### 1.3 Tier model (important — re-confirmed with Rob 2026-05-30)

Tier-1 = owned inventory only:
- `snagged_snap_sheet` (Snagged-owned)
- `rob_purchases_sheet` (Rob-owned)
- `snagged_marketplace_sheet` (Snagged-brokered)

Tier-2 = everything else: Atom, Afternic, Namecheap BIN, Sedo, Efty,
Spaceship, Dynadot Dump, and eventually Oxley.

**Tier-1 gets preference but NOT exclusivity.** A high-quality tier-2
name should still surface near the top alongside tier-1 results. Use the
ordering pattern in §3.3 below — quality dominates, tier breaks ties.

---

## 2. Brief intake → structured filters

### 2.1 The brief shape (from the playbook §7.1)

The user pastes a free-form brief. Typical inputs:

- Buyer/company description (e.g., "tech startup, premium feel, B2B SaaS")
- Budget range (e.g., "under $5,000" or "up to $50K")
- Preferred TLDs (default `.com`, can include `.ai`, `.co`, etc.)
- Word count (one word / one-or-two words / open)
- Tone (premium, trustworthy, playful, technical, financial, etc.)
- Constraints (dictionary word only, no compounds, easy to spell, etc.)
- Stretch names? (include north-star names over budget? default yes)

### 2.2 LLM call to parse the brief into a JSON filter object

Recommended approach: one Claude API call to convert the free-form brief
into a structured filter object the query engine can consume.

**API:** Anthropic Claude API. Model: `claude-haiku-4-5` is plenty for
this — fast, cheap. (~$0.001 per brief.)

**System prompt sketch:**

> You are parsing a domain-naming brief into a JSON filter object. The
> downstream system queries a Postgres table of domain marketplace
> candidates. Return ONLY valid JSON matching this schema:
> ```
> {
>   "tlds": [".com"],                   // array, default ['.com']
>   "sld_length_min": 4,                // integer, default null
>   "sld_length_max": 10,               // integer, default null
>   "num_words": 1,                     // 1, 2, or null (any)
>   "dictionary_word_only": true,       // boolean
>   "max_price": 5000,                  // integer USD, null for no cap
>   "min_quality_score": 3.0,           // float, default 0
>   "semantic_keywords": ["tech", "B2B", "saas"],  // free-form hints
>   "include_stretch": true             // boolean, default true
> }
> ```
> If the user is vague, infer sensible defaults. If they specify
> "premium", set `max_price` high (50000+). If they say "easy to spell",
> set `dictionary_word_only: true` and `num_words: 1`. Always include at
> least `.com` in `tlds`.

The `semantic_keywords` field is used for fuzzy matching against
`master_domain_list.keywords` (and eventually the LLM-enriched `keywords`
column on `name_universe` in Phase 2).

### 2.3 Validation

Sanity-check the parsed filter before querying:
- `tlds` is a non-empty array of valid TLD strings starting with `.`
- `sld_length_min` / `max` are within [2, 14]
- `max_price` is positive or null
- Default `min_quality_score` to 2.5 if not set

---

## 3. Query execution

### 3.1 Connection setup

The research app needs three secrets (add to `.env.local` for dev, and
Vercel env vars for prod):

```bash
SUPABASE_NAMING_URL=https://vsrjpwocunduwusjtrek.supabase.co
SUPABASE_NAMING_ANON_KEY=<anon key from new project>      # for read-only frontend
SUPABASE_NAMING_SERVICE_KEY=<service role key>            # for backend-only routes
ANTHROPIC_API_KEY=<your existing key>
```

Use the service role key from API routes (backend), never from the
browser. The anon key can stay client-side if you want browser-only reads
(with row-level security disabled, which is fine for internal tooling).

### 3.2 The SQL query template

For each parsed brief, run a query like:

```sql
SELECT
  u.domain,
  u.sld,
  u.tld,
  u.sld_length,
  u.num_words,
  u.num_syllables,
  u.is_dictionary_word,
  u.best_price,
  u.best_price_source,
  u.sources,
  u.quality_score,
  u.deal_score,
  u.source_tier,
  -- master_domain_list fields (NULL if not in the curated list)
  m.category,
  m.keywords,
  m.emotions,
  m.dictionary_word
FROM name_universe u
LEFT JOIN master_domain_list m USING (domain)
WHERE
  u.tld = ANY ($1::text[])                         -- tlds from filter
  AND ($2::int IS NULL OR u.sld_length >= $2)      -- sld_length_min
  AND ($3::int IS NULL OR u.sld_length <= $3)      -- sld_length_max
  AND ($4::int IS NULL OR u.num_words = $4)        -- num_words
  AND (NOT $5 OR u.is_dictionary_word = TRUE)      -- dictionary_word_only
  AND ($6::numeric IS NULL OR u.best_price <= $6 OR u.best_price IS NULL)
  AND ($7::numeric IS NULL OR u.quality_score >= $7)
  -- Phase 2: AND fuzzy match against keywords
ORDER BY
  u.source_tier ASC,           -- tier-1 first as a tiebreaker
  u.quality_score DESC NULLS LAST,
  u.deal_score DESC NULLS LAST
LIMIT 100;
```

Note the ORDER BY: source_tier ASC ahead of quality_score DESC means
tier-1 wins when quality is equal. To make tier-1 always win, swap to
`source_tier ASC, quality_score DESC` (current). To make quality always
win, swap to `quality_score DESC, source_tier ASC, deal_score DESC`.
Rob's preference per the 2026-05-30 conversation: **quality dominates,
tier breaks ties at similar quality.** So actually use:

```sql
ORDER BY
  quality_score DESC NULLS LAST,
  source_tier ASC,
  deal_score DESC NULLS LAST
LIMIT 100;
```

### 3.3 Semantic keyword filtering (best-effort with master_domain_list)

If the brief includes `semantic_keywords`, add to the WHERE clause:

```sql
AND (
  -- if the domain has master_domain_list metadata, fuzzy-match against it
  m.keywords ILIKE ANY (
    SELECT '%' || k || '%' FROM unnest($8::text[]) AS k
  )
  OR
  -- otherwise allow it through (we don't have category data for it yet)
  m.domain IS NULL
)
```

This is approximate — Phase 2 (LLM enrichment of `name_universe.keywords`
column) makes it precise.

### 3.4 Split into buy-ready vs stretch

After fetching the top N rows, split in the application layer:

- **Buy-ready:** `best_price IS NOT NULL AND best_price <= max_price`
  (where `max_price` comes from the brief; if `max_price` is null, all
  priced rows are buy-ready)
- **Stretch:** everything else — price unknown ("TBD") or above the cap,
  but still high-quality enough to surface as a north-star option

Show Buy-ready first, then a separate "Stretch" section below.

---

## 4. Result rendering (the 9-column playbook format)

### 4.1 Sheet columns (per playbook §3.5)

| # | Column | Source field | Notes |
|---|---|---|---|
| 1 | Domain | `domain` | Mono font, link to lander if known |
| 2 | Price / Quote | `best_price` (USD formatted) | "TBD" if null |
| 3 | Source | derived from `sources[]` and `source_tier` | See §4.2 |
| 4 | Status | derived (TBD until lander validation lands) | Default "For Sale" |
| 5 | Brandability Score | `quality_score` (round to 1 decimal) | Every row gets a number |
| 6 | Bucket | "Buy-ready" / "Stretch" | Section header |
| 7 | Why it works | LLM-generated (Phase 3) | Empty in v1 |
| 8 | Notes / Next step | empty editable | User fills in |
| 9 | Link | `best_price_source` + `domain` → URL | Format per source |

### 4.2 Source column formatting

Per playbook: "If it is a Snagged name, include the actual owner name in
Source — Example: Snagged (Dan Adamson)".

For v1:
- If `'snagged_snap_sheet' = ANY(sources)` → "Snagged (SNAP)"
- If `'snagged_marketplace_sheet' = ANY(sources)` → "Snagged (Marketplace)"
- If `'rob_purchases_sheet' = ANY(sources)` → "Rob Schutz"
- Otherwise → name of `best_price_source` (e.g., "Afternic", "Atom")

Future: read the actual rep / owner column from the tier-1 sheets at
display time and show "Snagged (Dan Adamson)" properly. For v1 the
generic labels above are fine.

### 4.3 Status column colors (per playbook)

Until lander validation lands, default every row to "For Sale" (green).
Phase 3 adds the actual lander check that fills in the four states:

| Status | Color | Hex |
|---|---|---|
| For Sale | green | `#16a34a` background, `#fff` text |
| In Use | light red | `#fecaca` background, `#7f1d1d` text |
| Big Owner | dark red | `#b91c1c` background, `#fff` text |
| Doesn't Resolve | yellow | `#fef08a` background, `#713f12` text |

### 4.4 UI layout sketch

```
┌──────────────────────────────────────────────────────┐
│ Naming Exercise                                       │
├──────────────────────────────────────────────────────┤
│ [Textarea: paste your brief here]                     │
│ [Find Names] button                                   │
├──────────────────────────────────────────────────────┤
│ Parsed filters: tlds [.com] · 4-10 chars · 1 word ·   │
│                 <$5K · tech/B2B/saas                  │
├──────────────────────────────────────────────────────┤
│ Buy-ready (N matches)                                 │
│ ┌─Domain─Price─Source─Status─Score─Bucket─Why─Notes─Link─┐
│ │ table.com    $1,500  Atom  ●For Sale  5.1 Buy-ready ...│
│ │ ocean.com    $2,800  Snagged...                       │
│ └────────────────────────────────────────────────────────┘
│ [Export to Google Sheet] [Copy as CSV]                  │
├──────────────────────────────────────────────────────┤
│ Stretch (N matches)                                   │
│ ┌─Domain─...─────────────────────────────────────────┐ │
│ │ tech.com  TBD  Big Owner  ●In Use  6.5  Stretch ...│ │
│ └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## 5. Sheet export

### 5.1 Export to Google Sheet

When user clicks "Export to Google Sheet":
1. Call a backend API route that:
   - Takes the current results in JSON
   - Uses the Google service account (same `GOOGLE_SERVICE_ACCOUNT_JSON`
     that admin uses) to create a new sheet
   - Or appends to a configured "Naming Exercises" parent sheet with the
     brief as the tab name + timestamp
2. Write rows in the 9-column format
3. Apply status colors (Sheets API supports conditional formatting)
4. Return the sheet URL to the user, open in new tab

### 5.2 Copy as CSV (simpler fallback)

Build a CSV string from the result rows in the browser; `window.URL` +
download trigger. No backend round-trip needed.

---

## 6. Phase 2+ TODOs (out of scope for v1)

These are tracked but explicitly NOT in scope for the first session:

- **LLM enrichment of `name_universe.category` / `industry` / `emotions` /
  `keywords`** for rows not in `master_domain_list` (admin-side, big
  backfill via Anthropic Batch API)
- **Lander validation worker** — mark For Sale / In Use / Big Owner /
  Doesn't Resolve on top candidates by hitting the lander URL
- **"Why it works" auto-generation** — Claude call per top-N row to
  generate the natural-language reasoning column
- **Semantic search via pgvector** — embeddings on SLD for true semantic
  matching (e.g., "pizza" → discovers `slice.com`, `oven.com`)
- **Owner attribution detail** — read actual rep/owner from tier-1
  sheets at render time so "Snagged (Dan Adamson)" shows properly

---

## 7. Quick reference — useful queries to validate

```sql
-- How many rows per tier
SELECT source_tier, COUNT(*) FROM name_universe GROUP BY source_tier ORDER BY source_tier;

-- Top quality 1-word .coms (what a basic brief should return)
SELECT domain, best_price, best_price_source, quality_score, deal_score
FROM name_universe
WHERE tld = '.com' AND num_words = 1 AND best_price <= 5000
ORDER BY quality_score DESC NULLS LAST, source_tier ASC, deal_score DESC NULLS LAST
LIMIT 20;

-- Tier-1 inventory matching brief
SELECT domain, best_price, sources, quality_score
FROM name_universe
WHERE source_tier = 1 AND tld = '.com' AND sld_length BETWEEN 4 AND 10
ORDER BY quality_score DESC NULLS LAST LIMIT 30;

-- With master_domain_list metadata where available
SELECT u.domain, u.best_price, u.quality_score, m.category, m.keywords
FROM name_universe u
LEFT JOIN master_domain_list m USING (domain)
WHERE u.tld = '.com' AND u.num_words = 1 AND u.quality_score >= 3.5
ORDER BY u.quality_score DESC LIMIT 25;
```

---

## 8. When you start the research session

Drop this into your context:

> I'm building the v1 naming exercise UI in this research repo. The
> handoff spec is at
> https://github.com/snaggeddomains/snagged-admin/blob/main/docs/naming-exercise-v1-spec.md
> — please read it first. The existing `/naming` placeholder page is
> the canvas; wire it to live data per §1–5 of the spec.
