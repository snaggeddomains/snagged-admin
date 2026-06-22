"""MUB — "Made-Up Brandable" filter.  Full spec: scripts/brandables/PROFILE.md.

A reusable runtime gate so SNAP + auction runs can flag MUB-grade coined .coms
(the same definition the brandables sheet uses). Self-contained:

  * hard gates — pure string (banned letters c/k/x/q/y, soft-g, digraphs, double
    letters, adjacent vowels, intervocalic s/l, back-vowel-before-cluster, terminal
    i, valid onsets/clusters, 4-8 chars, 2-3 syllables),
  * made-up — wordfreq zipf (reuses filters.standard.freq); rejects real words and
    two-real-word concatenations,
  * not negative/icky/suggestive — inline lexicon + edit-1 + sensitive-word rhyme,
  * the Ambrino word-likeness floor — from the committed n-gram table
    (scripts/brandables/mub_ngrams.json).

`is_mub(domain)` is the binary gate (single-label .com only). `mub_mark(domain)`
returns "✨ " for a MUB hit (else "") for Slack lines.
"""
from __future__ import annotations

import json
import math
import os
import re
from functools import lru_cache

VOWELS = set("aeiou")
CONS = set("bdfghjlmnprstvwz")          # c k x q y excluded (see PROFILE.md)
ALLOWED = VOWELS | CONS
OK_ONSET2 = {"bl", "br", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sl", "sm",
             "sn", "sp", "st", "sw", "tr", "tw", "th", "sh", "vr"}
OK_TRIPLE = ("mbr", "ndr", "ntr", "str", "ngl", "mbl", "ldr", "mpr", "ntl", "nstr")
BAD_DIGRAPH = ("ph", "gh", "ck", "wh", "ch", "kn", "gn", "ps", "pn", "mn")

REALWORD_ZIPF = 2.5     # at/above this a token IS a dictionary word (so: not made-up)

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
NEG_WORDS = {
    "fetus","dumber","doomer","doom","gloom","tumor","sewer","vomit","feces","anus",
    "mucus","virus","fungus","bogus","puss","slum","scum","dumb","numb","grim","dire",
    "vile","sour","dull","sick","fail","loser","demon","devil","evil","curse","death",
    "dead","kill","hate","ugly","dirty","nasty","gross","creep","leech","slug","worm",
    "germ","toxic","poison","crime","jail","plague","blight","rotten","moldy","murky",
    "dreary","gloomy","moron","idiot","lamer","weaker","sadder","sicker","badder","damn",
}
SENSITIVE = {
    "libido","herpes","semen","urine","penis","vagina","scrotum","phallus","gonad",
    "viagra","syphilis","feces","mucus","rectum","genital","areola","abscess","pustule",
}

# ---- word-likeness model (committed n-gram table) ----
_HERE = os.path.dirname(os.path.abspath(__file__))
_TAB_PATH = os.path.join(_HERE, "..", "..", "..", "scripts", "brandables", "mub_ngrams.json")
try:
    _TAB = json.load(open(_TAB_PATH))
    _BG, _TG = _TAB["bg"], _TAB["tg"]
    _BT, _TT = _TAB["bt"], _TAB["tt"]
except Exception:
    _BG, _TG, _BT, _TT = {}, {}, 1, 1

def _wordlike(s: str) -> float:
    p = f"^{s}$"
    bs = [math.log((_BG.get(p[i:i+2], 0) + 1) / _BT) for i in range(len(p) - 1)]
    ts = [math.log((_TG.get(p[i:i+3], 0) + 1) / _TT) for i in range(len(p) - 2)]
    return (sum(bs) / len(bs)) * 0.5 + (sum(ts) / len(ts)) * 0.5

# composite clarity score (== scripts/tighten_brandables.py score()) — the Ambrino
# FLOOR is computed on this, not on raw word-likeness.
_EASY = set("bdflmnprstv")
_NICE_END = ("ino", "ina", "ano", "ana", "eno", "ena", "elo", "ora", "aro",
             "o", "a", "us", "is", "el", "an", "on")
_NICE_END = tuple(sorted(set(_NICE_END), key=len, reverse=True))

def _score(s: str) -> float:
    from collections import Counter
    syl = _syllables(s)
    sc = _wordlike(s) * 8
    sc += len(set(s)) / len(s) * 10
    sc -= sum(v - 1 for ch, v in Counter(s).items() if ch in CONS and v > 1) * 2.5
    sc += {4: 4, 5: 7, 6: 7, 7: 5, 8: 2}.get(len(s), 0)
    sc += {2: 6, 3: 5}.get(syl, 0)
    if all(not (s[i] in CONS and s[i+1] in CONS) for i in range(len(s) - 1)):
        sc += 4
    if s.endswith(_NICE_END):
        sc += 3
    if s[-1] in VOWELS:
        sc += 1.5
    sc += min(4, sum(c in _EASY for c in s)) * 0.8
    sc -= sum(c in "jwz" for c in s) * 1.5
    return sc

# ---- made-up check (wordfreq, lazy so the module imports without it) ----
def _zipf(w: str) -> float:
    try:
        from .standard import freq
        return freq(w)
    except Exception:
        return 0.0

def _made_up(s: str) -> bool:
    if _zipf(s) >= REALWORD_ZIPF:
        return False                              # it's a real word
    for i in range(2, len(s) - 1):                # two real words glued = not coined
        if _zipf(s[:i]) >= REALWORD_ZIPF and _zipf(s[i:]) >= REALWORD_ZIPF:
            return False
    return True

# ---- structural helpers ----
def _max_run(s, charset):
    best = cur = 0
    for ch in s:
        cur = cur + 1 if ch in charset else 0
        best = max(best, cur)
    return best

def _cons_runs_ok(s):
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

def _onset_ok(s):
    k = 0
    while k < len(s) and s[k] in CONS:
        k += 1
    onset = s[:k]
    if len(onset) <= 1:
        return True
    return onset in OK_ONSET2 if len(onset) == 2 else False

def _syllables(s):
    return len(re.findall(r"[aeiou]+", s))

def _edit_le1(a, b):
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        return sum(x != y for x, y in zip(a, b)) == 1
    if la > lb:
        a, b = b, a
    i = j = diff = 0
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            diff += 1
            if diff > 1:
                return False
            j += 1
        else:
            i += 1; j += 1
    return True

def _negative(s):
    if any(r in s for r in NEG_SUBSTR):
        return True
    if any(_edit_le1(s, w) for w in NEG_WORDS):
        return True
    for w in SENSITIVE:
        if len(s) >= 4 and s[-4:] == w[-4:]:
            return True
        if _edit_le1(s, w):
            return True
    return False

def _gates_ok(s: str) -> bool:
    """Pure-string MUB gates (everything except made-up + the word-like floor)."""
    if not (4 <= len(s) <= 8):
        return False
    if any(ch not in ALLOWED for ch in s):                 # c k x q y / anything odd
        return False
    if any(s[i] == s[i+1] for i in range(len(s)-1)):       # no double letters
        return False
    if s[-1] == "i":                                       # brandi/brandy
        return False
    if any(s[i] in VOWELS and s[i+1] in VOWELS for i in range(len(s)-1)):
        return False                                       # adjacent vowels
    if not (VOWELS & set(s)):
        return False
    if any(s[i] in "sl" and s[i-1] in VOWELS and s[i+1] in VOWELS
           for i in range(1, len(s)-1)):                   # intervocalic s/l
        return False
    if any(s[i] == "g" and i+1 < len(s) and s[i+1] in "ei" for i in range(len(s))):
        return False                                       # soft g
    for i, ch in enumerate(s):                             # back vowel before cluster
        if ch in "ou":
            k = 0; j = i + 1
            while j < len(s) and s[j] in CONS:
                k += 1; j += 1
            if k >= 2:
                return False
    if any(d in s for d in BAD_DIGRAPH):
        return False
    if not _cons_runs_ok(s) or not _onset_ok(s):
        return False
    if not (2 <= _syllables(s) <= 3):
        return False
    if _negative(s):
        return False
    return True

@lru_cache(maxsize=8192)
def _floor() -> float:
    return _score("ambrino")

def split_domain(domain: str):
    """(sld, tld) for a single-label domain, else (None, None)."""
    parts = (domain or "").strip().lower().split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None, None
    return parts[0], parts[1]

@lru_cache(maxsize=65536)
def is_mub(domain: str) -> bool:
    """True if domain is a MUB-grade coined .com (single label)."""
    sld, tld = split_domain(domain)
    if not sld or tld != "com":
        return False
    if not sld.isalpha() or not _gates_ok(sld):
        return False
    if not _made_up(sld):
        return False
    return _score(sld) >= _floor()

def mub_mark(domain: str) -> str:
    """'✨ ' if domain is MUB, else '' — for prefixing Slack lines."""
    try:
        return "✨ " if is_mub(domain) else ""
    except Exception:
        return ""

def count_mub(domains) -> int:
    return sum(1 for d in domains if is_mub(d))
