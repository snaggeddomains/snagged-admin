# Profile: MUB — "Made-Up Brandable"

(aka "Made-Up Word, Brandable") — the saved definition for picking brandable, **coined** `.com` names that pass a
strict **two-way sound↔spelling lock** (you can spell it exactly from hearing it,
and pronounce it exactly from reading it — one way only), sound positive/neutral,
and read like a name a startup would actually use.

Gold-standard example: **Ambrino** (`am-bri-no`). Other in-profile picks: `batino`,
`boga`, `ditora`, `pentero`, `daturo`, `bamena`.

Implemented in `scripts/tighten_brandables.py`; published to the Google Sheet via
`scripts/make_brand_sheet.py` + `.github/workflows/brandable-sheet.yml`.

---

## Hard gates (a name is dropped if it fails any)

**Shape**
- `.com` only; length **4–8**; letters only.
- **2–3 syllables**.
- **No double letters** (no `tt`, `ll`, …).
- **Adjacent vowels** — clear two-syllable hiatus is allowed (`ia`/`io`/`eo`/`ua`/`uo`,
  e.g. lor-i-an, stud-io, vide-o); diphthong digraphs that blur to one ambiguous-to-
  spell sound (`ai`/`ea`/`oo`/`au`/`ou`/`oa`/`ei`/`ie`…) and any 3+ vowel run stay banned.
- Valid word-initial consonant onsets only; medial consonant runs ≤2 **unless** a
  comfortable blend (`mbr`,`ndr`,`ntr`,`str`,`ngl`,`mbl`,`ldr`,`mpr`,`ntl`,`nstr`).

**Sound↔spelling lock — banned letters/patterns (each breaks the 1:1 mapping)**
- **bare `c`** — sounds like K or S (cat/cent). **`k`** — a hard `/k/` can't be spelled
  unambiguously by ear (Karina/Carina, Kerema/Cerema). So the standalone `/k/` is out.
  **Exception: `ch` is allowed** (the /tʃ/ in arch — archmont); a `c` is permitted only
  when it's immediately followed by `h`.
- **`x`** (ks/z), **`q`** (needs qu), **`y`** (vowel/consonant ambiguity).
- **Soft `g`** — no `g` before `e`/`i` (gem vs get).
- **Digraphs** `ph`,`gh`,`ck`,`wh` (+ silent `kn`/`gn`/`ps`/`pn`/`mn`). (`ch` is allowed.)
- **Intervocalic `s`** — voices to /z/ (`derosa`→"deroza").
- **Intervocalic `l`** — invites doubling (`demila`→"demilla", `darilo`→"darillo").
  (Word-**final** `l`/`s` are fine: `gonel`, `arinos`.)
- **Back vowel before a consonant PILE-UP** — `o`/`u` followed by **3+** consonants
  (softened from 2+ so a 2-cluster like "mont"/"pront" passes — archmont).
- **Terminal `i`** — a final "ee" sound spelled `i` is i/y/ie ambiguous
  (`brandi`/Brandy).

**Made-up**
- Not a dictionary word, and not a clean split into two dictionary words
  (no `forfor`, no `lovejoy`).

**Connotation — positive or neutral only**
- Drop clearly **negative/icky** names: an icky root substring (`depus`→"pus"), or
  within one edit of a negative/taboo word (`detus`~fetus, `dumer`~dumber/doomer).
- Drop **awkward/suggestive** rhymes/near-matches (`habido`~libido) — sensitive-word
  list, matched on a shared rime (last 4 chars) or one edit.
- Drop anything the corpus connotation field rates `negative`/`somewhat negative`
  (committed map `scripts/brandables/connotation.json`; positive/neutral pass).

## The clarity floor (the gate)
`wordlike_score` is computed for every candidate; we keep only names scoring **≥ the
lowest user-blessed example** (`floor = min(score(b) for b in BLESSED)`, where
`BLESSED = ambrino, batino, boga, ditora, pentero, lorian, archmont`). Ambrino set the
original bar; **archmont is currently the lowest**, so it sets the floor. Add a new
blessed example below archmont and the floor (and the list) widens with it.

## Scores (both shown on the sheet)
- **`wordlike_score`** (0–100): how word-like the letter sequences are — mean log
  bigram+trigram frequency from the 68K `english_words` list, plus a distinctness
  bonus and a repetition penalty (so `dened`/`deding` don't win), length/syllable/
  pure-CV/nice-ending bonuses.
- **`brandable_score`** (0–100): would a startup name a company/product this? —
  punchy length (4–6), 2–3 syllables, smooth (few clusters), a modern vowel ending
  (`-o`/`-a`) or crisp consonant ending, a strong plosive onset, `v`/`z` "brand-y"
  letters, and letter variety. **The sheet is ranked by this.**

## Output
- Source pool: our corpora (`name_universe` + Master + marketplace feeds), `.com`,
  for-sale, priced.
- Columns: rank · domain · `brandable_score` · `wordlike_score` · ask price · source
  · link (GoDaddy domain-search URL — always resolves, shows the live aftermarket
  BIN/make-offer).
- Two tabs: **Top** (prefix-diversified, ≤5 per 2-letter prefix) + **All (ranked)**.

## Reuse in SNAP + auction runs
`marketplace_pipeline/filters/mub.py` is the runtime gate (same definition, faithful
to this sheet — verified all sheet names return `is_mub=True`). It is self-contained
and committed-data-driven: `scripts/brandables/mub_ngrams.json` for the word-likeness
floor and `scripts/brandables/words.txt` (the english_words set) for the made-up
check. **Do not use wordfreq for made-up** — it rates junk 3-letter fragments (amb,
rino, ino) as words and would falsely flag coined names (ambrino = amb+rino) as
concatenations. Wired in:
- **Auctions (morning report)** — `auctions/orchestrator.py` posts a **standalone
  "✨ MUB picks" message** (its own post, not mixed into the per-source sections):
  every MUB hit across all auction sources, deduped, ranked by `mub_brandable` (best
  first), each tagged with its source. The per-source watchlist sections stay clean.
- **SNAP good deals** — `namepros_marketplace` + `reddit_domains` mark MUB lines with ✨
  and add `· N ✨ MUB` to the headline.

`is_mub(domain)` (single-label `.com` only) · `mub_mark(domain)` → "✨ "/"" ·
`count_mub(domains)`.

## Re-run
```
python3 scripts/tighten_brandables.py            # regenerate the two CSVs
# then publish (CI has the service-account creds):
#   workflow "brandable-sheet.yml", input spreadsheet_id=<existing sheet> to update in place
```
