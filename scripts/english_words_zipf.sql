-- Add a word-frequency column to english_words so SNAP Research (and anything else) can
-- order the dictionary "most-common first". Populated by wordfreq via the
-- backfill-english-zipf GitHub Action (scripts/backfill_english_zipf.py).
-- Run ONCE on the NAMING project (snagged-naming-universe) before dispatching the Action.

alter table english_words add column if not exists zipf real;

-- Ordering index: most-common first (high zipf), NULLs (not-yet-backfilled) last.
create index if not exists idx_english_words_zipf on english_words (zipf desc nulls last);
