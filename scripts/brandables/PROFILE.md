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
- **No adjacent vowels** — no `ai`/`ea`/`io` blur; vowels sit between consonants.
- Valid word-initial consonant onsets only; medial consonant runs ≤2 **unless** a
  comfortable blend (`mbr`,`ndr`,`ntr`,`str`,`ngl`,`mbl`,`ldr`,`mpr`,`ntl`,`nstr`).

**Sound↔spelling lock — banned letters/patterns (each breaks the 1:1 mapping)**
- **`c`** — sounds like K or S (cat/cent). **`k`** — a hard `/k/` can't be spelled
  unambiguously by ear (Karina/Carina, Kerema/Cerema). So the `/k/` phoneme is out
  entirely.
- **`x`** (ks/z), **`q`** (needs qu), **`y`** (vowel/consonant ambiguity).
- **Soft `g`** — no `g` before `e`/`i` (gem vs get).
- **Digraphs** `ph`,`gh`,`ck`,`wh`,`ch` (+ silent `kn`/`gn`/`ps`/`pn`/`mn`).
- **Intervocalic `s`** — voices to /z/ (`derosa`→"deroza").
- **Intervocalic `l`** — invites doubling (`demila`→"demilla", `darilo`→"darillo").
  (Word-**final** `l`/`s` are fine: `gonel`, `arinos`.)
- **Back vowel before a cluster** — `o`/`u` followed by 2+ consonants flips by ear
  (`prontus`→"prawntis"). (`a`/`e`/`i` before a cluster are stable — Ambrino's "am".)
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
`wordlike_score` is computed for every candidate; we keep only names scoring **≥
Ambrino** (`floor = score("ambrino")`). Ambrino is the calibration point — at or
above it = clean enough.

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

## Re-run
```
python3 scripts/tighten_brandables.py            # regenerate the two CSVs
# then publish (CI has the service-account creds):
#   workflow "brandable-sheet.yml", input spreadsheet_id=<existing sheet> to update in place
```
