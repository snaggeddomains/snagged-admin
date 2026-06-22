#!/usr/bin/env python3
"""Tighten the brandables list to the cleanest, most word-like, unambiguous names.

Rules tuned to Ambrino-style picks: no double letters, no spelling-trap letters
(c/x/q dropped — 'c' sounds like k OR s; soft-g, y-as-vowel, ph/gh/ck/wh/ch
digraphs dropped), no adjacent-vowel blur, pure easy CV structure. Ranked by how
word-like the actual letter sequences are (mean log bigram frequency from the
68K english_words list) so they "sound like words."
"""
import csv, re, math
from functools import lru_cache

VOWELS = set("aeiou")
CONS = set("bdfghjklmnprstvwz")          # note: c, x, q, y deliberately excluded
ALLOWED = VOWELS | CONS                  # the full allowed alphabet

# ---- word-likeness model: bigram + trigram log-freq from the wordlist ----
WORDS = []
with open("/tmp/words.tsv") as f:
    next(f, None)
    for line in f:
        w = line.strip().lower()
        if w.isalpha():
            WORDS.append(w)
WORDSET = set(WORDS)

from collections import Counter
bg = Counter(); tg = Counter()
for w in WORDS:
    p = f"^{w}$"
    for i in range(len(p) - 1):
        bg[p[i:i+2]] += 1
    for i in range(len(p) - 2):
        tg[p[i:i+3]] += 1
bg_tot = sum(bg.values()); tg_tot = sum(tg.values())
def bg_lp(s): return math.log((bg.get(s, 0) + 1) / bg_tot)
def tg_lp(s): return math.log((tg.get(s, 0) + 1) / tg_tot)
BG_MIN = math.log(1 / bg_tot)            # floor for an unseen bigram

def wordlikeness(sld):
    """Mean log-prob of the name's bigrams+trigrams (with ^/$ boundaries).
    Higher = letter sequences look like real English words."""
    p = f"^{sld}$"
    bs = [bg_lp(p[i:i+2]) for i in range(len(p) - 1)]
    ts = [tg_lp(p[i:i+3]) for i in range(len(p) - 2)]
    return (sum(bs) / len(bs)) * 0.5 + (sum(ts) / len(ts)) * 0.5

# ---- structural / pronounceability gates ----
OK_ONSET2 = {"bl","br","dr","fl","fr","gl","gr","pl","pr","sl","sm","sn","sp",
             "st","sw","tr","tw","th","sh","vr"}
OK_TRIPLE = ("mbr","ndr","ntr","str","ngl","mbl","ldr","mpr","ntl","nstr")
BAD_DIGRAPH = ("ph","gh","ck","wh","ch","ck","kn","gn","ps","pn","mn")

def has_double(s):
    return any(s[i] == s[i+1] for i in range(len(s)-1))

def adjacent_vowels(s):
    return any(s[i] in VOWELS and s[i+1] in VOWELS for i in range(len(s)-1))

def soft_g(s):
    return any(s[i] == "g" and i+1 < len(s) and s[i+1] in "ei" for i in range(len(s)))

def cons_runs_ok(s):
    i, n = 0, len(s)
    while i < n:
        if s[i] in CONS:
            j = i
            while j < n and s[j] in CONS:
                j += 1
            run = s[i:j]
            if len(run) >= 4 or (len(run) == 3 and run not in OK_TRIPLE):
                return False
            i = j
        else:
            i += 1
    return True

def onset_ok(s):
    k = 0
    while k < len(s) and s[k] in CONS:
        k += 1
    onset = s[:k]
    if len(onset) <= 1:
        return True
    if len(onset) == 2:
        return onset in OK_ONSET2
    return False

def syllables(s):
    return len(re.findall(r"[aeiou]+", s))

# ---- negativity gate: drop names that read as / rhyme with negative or icky words ----
# Icky/negative ROOTS — reject if contained as a substring (depus -> "pus").
NEG_SUBSTR = {
    "doom","dumb","dum","pus","piss","pis","fart","crap","damn","hell","dead","die",
    "kill","sick","fail","loss","lose","scam","fraud","scum","slum","bum","rot","germ",
    "tox","mort","necro","vomit","vom","puke","puk","barf","gore","grim","dread","dire",
    "bleak","gloom","grief","hate","ugly","dirt","dung","decay","worm","leech","slug",
    "creep","sewer","trash","waste","junk","numb","dull","sour","war","bomb","drug",
    "debt","mold","muck","smut","scar","sore","pest","vile","grime","sludge","stink",
    "reek","stench","fetus","feces","anus","mucus","snot","turd","poop","butt","ass",
    "hag","curse","demon","devil","evil","sin","crime","jail","pain","ache","pox","wart",
    "scab","maim","slay","mourn","tomb","grave","rust","blight","plague","virus","fungus",
    "moron","idiot","dork","derp","lame","weak","sag","droop","murk","dreary",
}
# Full negative/taboo WORDS — reject if within one edit (detus~fetus, dumer~dumber).
NEG_WORDS = {
    "fetus","dumber","doomer","doom","gloom","tumor","sewer","vomit","feces","anus",
    "mucus","virus","fungus","bogus","puss","slum","scum","dumb","numb","grim","dire",
    "vile","sour","dull","sick","fail","loser","demon","devil","evil","curse","death",
    "dead","kill","hate","ugly","dirty","nasty","gross","creep","leech","slug","worm",
    "germ","toxic","poison","crime","jail","plague","blight","rotten","moldy","murky",
    "dreary","gloomy","moron","idiot","lamer","weaker","sadder","sicker","badder","damn",
}

def _edit_le1(a, b):
    """True if a and b are within one insertion/deletion/substitution."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        return sum(x != y for x, y in zip(a, b)) == 1
    if la > lb:
        a, b = b, a                      # ensure a is the shorter
    i = j = diff = 0
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            diff += 1
            if diff > 1:
                return False
            j += 1                       # skip the extra char in the longer string
        else:
            i += 1; j += 1
    return True

def negative(s):
    if any(r in s for r in NEG_SUBSTR):
        return True
    return any(_edit_le1(s, w) for w in NEG_WORDS)

def clean(s):
    if not (4 <= len(s) <= 8):
        return False
    if any(ch not in ALLOWED for ch in s):   # kills c, x, q, y, and anything odd
        return False
    if has_double(s):
        return False
    if adjacent_vowels(s):                    # no ai/ea/io blur — pure CV reads clean
        return False
    if not (VOWELS & set(s)):
        return False
    # intervocalic 's' (voices to /z/: derosa->"deroza") and 'l' (invites doubling:
    # demila->"demilla", darilo->"darillo") break the sound<->spelling lock.
    if any(s[i] in "sl" and s[i-1] in VOWELS and s[i+1] in VOWELS
           for i in range(1, len(s) - 1)):
        return False
    if soft_g(s):
        return False
    if negative(s):                           # sounds negative / has an icky root
        return False
    if any(d in s for d in BAD_DIGRAPH):
        return False
    if not cons_runs_ok(s) or not onset_ok(s):
        return False
    if s in WORDSET:                          # must be made-up
        return False
    # reject clean splits into two real words
    for i in range(2, len(s) - 1):
        if s[:i] in WORDSET and s[i:] in WORDSET:
            return False
    syl = syllables(s)
    if syl < 2 or syl > 3:
        return False
    return True

NICE_END = ("ino", "ina", "ano", "ana", "eno", "ena", "elo", "ora", "aro",
            "ello"[:3], "io"[:0] or "elo", "o", "a", "us", "is", "el", "an", "on")
NICE_END = tuple(sorted(set(e for e in NICE_END if e), key=len, reverse=True))
EASY = set("bdflmnprstv")   # cleanest, most word-like consonants

def score(s):
    syl = syllables(s)
    sc = 0.0
    sc += wordlikeness(s) * 8            # sounds like a word (common letter sequences)
    # distinctness — punish dull repetition (dened, deding, dedet) that the raw
    # bigram model over-rewards; great brands use varied letters (karina, ambrino)
    distinct = len(set(s)) / len(s)
    sc += distinct * 10
    from collections import Counter as _C
    rep = sum(v - 1 for ch, v in _C(s).items() if ch in CONS and v > 1)
    sc -= rep * 2.5
    sc += {4: 4, 5: 7, 6: 7, 7: 5, 8: 2}.get(len(s), 0)
    sc += {2: 6, 3: 5}.get(syl, 0)
    # pure CV alternation (every consonant single) = maximally easy
    if all(not (s[i] in CONS and s[i+1] in CONS) for i in range(len(s)-1)):
        sc += 4
    if s.endswith(NICE_END):
        sc += 3
    if s[-1] in VOWELS:
        sc += 1.5
    sc += min(4, sum(c in EASY for c in s)) * 0.8     # easy/clean consonants
    sc -= sum(c in "jwz" for c in s) * 1.5            # readable but less word-like
    return sc

# Universal, always-resolving link: GoDaddy domain search shows availability +
# the live aftermarket BIN/make-offer for any .com (GoDaddy aggregates Afternic).
def buy_link(dom):
    return f"https://www.godaddy.com/domainsearch/find?domainToCheck={dom}"

# ---- load existing candidate pool (the prior full set already has price/source) ----
rows = list(csv.DictReader(open("scripts/brandables/brandables_full.csv")))
out = []
for r in rows:
    dom = r["domain"]
    sld = dom[:-4] if dom.endswith(".com") else dom
    if not clean(sld):
        continue
    out.append((round(score(sld), 3), sld, dom, r["ask_price_usd"], r["source"], buy_link(dom)))

# Floor: keep only names at least as clean/word-like as Ambrino (the gold-standard
# example). Computed on the same raw model so the bar is principled, not arbitrary.
FLOOR_NAME = "ambrino"
floor = score(FLOOR_NAME)
before = len(out)
out = [t for t in out if t[0] >= floor]
print(f"Ambrino floor: raw {round(floor,3)} — kept {len(out)} of {before} (>= Ambrino)")

out.sort(key=lambda x: -x[0])
# rescale raw scores to a friendly 0-100 "ease" scale for display
if out:
    hi = out[0][0]; lo = out[-1][0]; rng = (hi - lo) or 1
    out = [(round(60 + 40 * (sc - lo) / rng, 1), sld, dom, price, source, link)
           for sc, sld, dom, price, source, link in out]
print("tightened candidates:", len(out))
print("\nTOP 60:")
for sc, sld, dom, price, source, link in out[:60]:
    print(f"  {dom:<14} {sc:>6}  {price:>10}  {source}")

# diverse top 100 (cap per 2-letter prefix)
def curated(rows, n=100, per=5):
    res, seen = [], {}
    for row in rows:
        pre = row[1][:2]
        if seen.get(pre, 0) >= per:
            continue
        seen[pre] = seen.get(pre, 0) + 1
        res.append(row)
        if len(res) >= n:
            break
    return res

topset = {r[1] for r in curated(out, 100, 5)}

def write_csv(path, rows, top_only=False):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "domain", "wordlike_score", "ask_price_usd", "source", "link"]
                   if top_only else
                   ["rank", "domain", "curated_top100", "wordlike_score", "ask_price_usd", "source", "link"])
        rank = 0
        for sc, sld, dom, price, source, link in rows:
            rank += 1
            if top_only:
                w.writerow([rank, dom, sc, price, source, link])
            else:
                w.writerow([rank, dom, "★" if sld in topset else "", sc, price, source, link])

write_csv("scripts/brandables/brandables_full.csv", out, top_only=False)
write_csv("scripts/brandables/brandables_top100.csv", curated(out, 100, 5), top_only=True)
print(f"\nwrote full ({len(out)}) + curated top ({len(topset)})")
