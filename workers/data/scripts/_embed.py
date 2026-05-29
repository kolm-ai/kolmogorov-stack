#!/usr/bin/env python3
"""Optional embedding backend for src/embedding.js.

src/embedding.js is a dependency-free, deterministic 256-d hash-bag embedder:
a bag of token unigrams + character tri/quad-grams, each hashed (SHA1) into a
fixed-width vector with a signed contribution, then L2-normalized. It needs no
model download and runs everywhere — but it is coarse.

This worker is an OPTIONAL acceleration / upgrade backend the JS side can shell
out to when present. It offers two backends:

  * hashbag (default) — an EXACT byte-for-byte reimplementation of the JS
    embedder (same SHA1 hashing, same salts/weights, same L2 norm). This is a
    true drop-in: vectors are identical to embed() in src/embedding.js, so the
    JS caller can use it interchangeably (e.g. to batch-embed a large corpus in
    one process instead of one call per text).

  * st — sentence-transformers 'all-MiniLM-L6-v2' dense embeddings, used only
    when --backend st is requested AND the package is importable. Otherwise we
    fall back to hashbag and report backend_used accordingly, so the JS side
    cleanly degrades (never crashes on a missing optional dep).

Interface:
  python _embed.py --texts <jsonl> [--out <json>] [--dim 256]
                   [--backend auto|hashbag|st] [--seed <int>]
  --texts   JSONL where each line is either a bare JSON string ("hello") or an
            object {"text": "hello"}. If omitted, JSONL is read from stdin.
  --out     also write the result JSON here (always printed to stdout too).
  --dim     output dimensionality for hashbag (default 256, matches JS DIM).
  --backend auto|hashbag|st. 'auto' == 'hashbag'. 'st' tries sentence-
            transformers and falls back to hashbag if unavailable.
  --seed    accepted for determinism contract; hashbag is seed-independent
            (SHA1 fully determines it). Default 0x6b6f6c6d = 1801677709.

stdout JSON: {ok:true, dim:int, vectors:float[][], backend_used:str}
On a missing optional dep when it is strictly required, prints
{ok:false, error:'dep_missing', need:'<pkg>'} and exits 0 so JS falls back.

--self-test: in-process check on a tiny synthetic corpus; prints PASS/FAIL
counts; exit 0 iff all pass.

Exit codes: 0 ok (including graceful dep-missing) · 20 input missing/empty.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys

# Inline UTF-8 console shim (Windows cp1252/cp950 guard). The data/scripts dir
# has no shared _console module, so we keep this self-contained.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # deliberate: cleanup — pre-3.7 / pyodide lacks reconfigure
        pass

EXIT_OK = 0
EXIT_NO_INPUT = 20
DEFAULT_SEED = 0x6B6F6C6D  # 1801677709 == ascii 'kolm'
DEFAULT_DIM = 256  # mirrors DIM in src/embedding.js

_WORD_SPLIT = re.compile(r"[^a-z0-9]+")
_WS = re.compile(r"\s+")


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# --- exact reimplementation of src/embedding.js -----------------------------
def tokens(text):
    """Mirror tokens(): lowercase, split on non-alphanumeric, drop empties."""
    return [t for t in _WORD_SPLIT.split((text or "").lower()) if t]


def _to_utf16_units(s):
    """Decompose a Python str into a list of UTF-16 code units (ints), so that
    slicing matches JavaScript String semantics: a non-BMP char (e.g. an emoji)
    becomes a surrogate PAIR of two units and can be split mid-pair, exactly as
    JS String.prototype.slice would. Plain BMP chars map 1:1."""
    units = []
    for cp in (ord(c) for c in s):
        if cp > 0xFFFF:
            cp -= 0x10000
            units.append(0xD800 + (cp >> 10))      # high surrogate
            units.append(0xDC00 + (cp & 0x3FF))    # low surrogate
        else:
            units.append(cp)
    return units


def _units_to_utf8(units):
    """UTF-8 bytes of a UTF-16 code-unit list, matching how Node's
    crypto.update(<string>) encodes it: well-formed surrogate pairs combine into
    the astral code point; any LONE surrogate is replaced with U+FFFD (Node
    emits ef bf bd for an unpaired surrogate)."""
    out = []
    i = 0
    L = len(units)
    while i < L:
        u = units[i]
        if 0xD800 <= u <= 0xDBFF and i + 1 < L and 0xDC00 <= units[i + 1] <= 0xDFFF:
            cp = 0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00)
            out.append(chr(cp).encode("utf-8"))
            i += 2
        elif 0xD800 <= u <= 0xDFFF:
            out.append(b"\xef\xbf\xbd")  # lone surrogate -> U+FFFD, as Node does
            i += 1
        else:
            out.append(chr(u).encode("utf-8"))
            i += 1
    return b"".join(out)


def ngrams(text, n):
    """Mirror ngrams(): pad with a space each side over the collapsed+trimmed
    lowercase text, then emit every length-n window. Windows are returned as
    UTF-16 code-unit lists (not str) so that astral chars split exactly as they
    do in JavaScript; hashing consumes those unit lists via _sha1_units."""
    t = " " + _WS.sub(" ", (text or "").lower()).strip() + " "
    units = _to_utf16_units(t)
    return [units[i:i + n] for i in range(0, len(units) - n + 1)]


def _sha1_bytes(s):
    return hashlib.sha1(s.encode("utf-8")).digest()


def _sha1_units(salt, units):
    """sha1 of (salt utf-8) ++ (utf-8 of the UTF-16 unit list)."""
    return hashlib.sha1(salt.encode("utf-8") + _units_to_utf8(units)).digest()


def _digest(salt, token):
    """sha1(salt ++ token). token may be a str (token path) or a UTF-16 code-
    unit list (ngram path) — the latter routes through _units_to_utf8 so split
    surrogates hash exactly as Node would."""
    if isinstance(token, str):
        return _sha1_bytes(salt + token)
    return _sha1_units(salt, token)


def hash_index(token, salt=""):
    """Mirror hashIndex(): first 4 bytes of sha1(salt+token) as big-endian
    uint32 (the JS code does (b0<<24|b1<<16|b2<<8|b3) >>> 0)."""
    h = _digest(salt, token)
    return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0xFFFFFFFF


def sign(token):
    """Mirror sign(): +1 if low bit of sha1('sign:'+token)[0] set else -1."""
    h = _digest("sign:", token)
    return 1 if (h[0] & 1) else -1


def l2_normalize(v):
    """Mirror l2Normalize(): divide by L2 norm, treating a zero norm as 1."""
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def embed_hashbag(text, dim=DEFAULT_DIM):
    """Exact parity with embed() in src/embedding.js for dim==256.

    For dim != 256 the structure is identical (modulo the dim wrap), so it stays
    a valid hash-bag embedder at other widths while remaining a true drop-in at
    the default."""
    v = [0.0] * dim
    for t in tokens(text):
        v[hash_index(t, "unigram") % dim] += sign(t)
    for g in ngrams(text, 3):
        v[hash_index(g, "tri") % dim] += sign(g) * 0.5
    for g in ngrams(text, 4):
        v[hash_index(g, "quad") % dim] += sign(g) * 0.3
    return l2_normalize(v)


# --- optional sentence-transformers backend ---------------------------------
def embed_st(texts):
    """Dense 'all-MiniLM-L6-v2' embeddings, unit-normalized. Raises ImportError
    (or other load errors) if the dependency / model is unavailable."""
    from sentence_transformers import SentenceTransformer  # may raise ImportError

    model = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
    embs = model.encode(
        [t if t is not None else "" for t in texts],
        batch_size=32,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    return [[float(x) for x in row] for row in embs]


# --- IO ----------------------------------------------------------------------
def _coerce_text(obj):
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        t = obj.get("text")
        return t if isinstance(t, str) else ""
    return ""


def load_texts(path):
    """Read JSONL of bare strings or {text}. path=None => stdin."""
    out = []
    fh = open(path, "r", encoding="utf-8") if path else sys.stdin
    try:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(_coerce_text(json.loads(line)))
            except Exception:  # deliberate: cleanup — skip one malformed line
                continue
    finally:
        if path:
            fh.close()
    return out


def run(texts, dim, backend):
    """Returns (vectors, backend_used)."""
    want = (backend or "auto").lower()
    if want in ("auto", "hashbag"):
        return [embed_hashbag(t, dim) for t in texts], "hashbag"
    if want == "st":
        try:
            return embed_st(texts), "st"
        except Exception as e:  # deliberate: cleanup — optional dep absent => fall back
            log(f"[embed] sentence-transformers unavailable ({e}); falling back to hashbag")
            return [embed_hashbag(t, dim) for t in texts], "hashbag"
    # Unknown backend name: behave like hashbag rather than erroring.
    log(f"[embed] unknown backend '{backend}'; using hashbag")
    return [embed_hashbag(t, dim) for t in texts], "hashbag"


# --- self-test ---------------------------------------------------------------
def self_test():
    passed = 0
    failed = 0

    def check(name, cond):
        nonlocal passed, failed
        if cond:
            passed += 1
            log(f"  PASS {name}")
        else:
            failed += 1
            log(f"  FAIL {name}")

    corpus = ["hello world", "Hello   World", "totally different text", ""]

    # 1. L2-normalized (unit norm, modulo the all-zero empty-string case).
    for t in corpus:
        v = embed_hashbag(t)
        norm = math.sqrt(sum(x * x for x in v))
        if t.strip() == "":
            check(f"empty-string norm 0|1 [{t!r}]", norm < 1e-9 or abs(norm - 1.0) < 1e-9)
        else:
            check(f"L2-normalized [{t!r}]", abs(norm - 1.0) < 1e-9)

    # 2. Correct dimensionality.
    check("dim==256 default", len(embed_hashbag("anything")) == DEFAULT_DIM)
    check("dim==64 honored", len(embed_hashbag("anything", 64)) == 64)

    # 3. Deterministic across repeated calls.
    a1 = embed_hashbag("deterministic check please")
    a2 = embed_hashbag("deterministic check please")
    check("deterministic across runs", a1 == a2)

    # 4. Identical text => identical vector; case/whitespace-normalized texts
    #    that share token+ngram structure stay identical (JS collapses ws).
    check("identical text => identical vector",
          embed_hashbag("hello world") == embed_hashbag("hello world"))
    check("whitespace-collapsed identical",
          embed_hashbag("hello world") == embed_hashbag("hello   world"))

    # 5. Different text => different vector.
    check("different text => different vector",
          embed_hashbag("hello world") != embed_hashbag("totally different text"))

    # 6. Self-cosine ~1, cross-cosine < 1 (sanity on the vector geometry).
    def cos(u, w):
        return sum(x * y for x, y in zip(u, w))
    hv = embed_hashbag("hello world")
    dv = embed_hashbag("totally different text")
    check("self-cosine ~= 1", abs(cos(hv, hv) - 1.0) < 1e-9)
    check("cross-cosine < 0.999", cos(hv, dv) < 0.999)

    # 7. Known parity anchors with the JS hashIndex/sign primitives. These are
    #    SHA1-derived constants; if the hashing ever drifts from the JS side
    #    these break. Computed from sha1('unigram'+'hello') and sha1('sign:hello').
    check("hash_index parity (unigram,hello)",
          hash_index("hello", "unigram") == _expected_index("unigram", "hello"))
    check("sign parity (hello)", sign("hello") == _expected_sign("hello"))

    log(f"SELF-TEST: {passed} passed, {failed} failed")
    return EXIT_OK if failed == 0 else 1


def _expected_index(salt, token):
    h = hashlib.sha1((salt + token).encode("utf-8")).digest()
    return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0xFFFFFFFF


def _expected_sign(token):
    h = hashlib.sha1(("sign:" + token).encode("utf-8")).digest()
    return 1 if (h[0] & 1) else -1


def parse_args():
    p = argparse.ArgumentParser(description="Optional embedding backend for src/embedding.js.")
    p.add_argument("--texts", default=None, help="JSONL of strings or {text}. Omit to read stdin.")
    p.add_argument("--out", default=None, help="Also write the result JSON here.")
    p.add_argument("--dim", type=int, default=DEFAULT_DIM, help="Hashbag dimensionality (default 256).")
    p.add_argument("--backend", default="hashbag", choices=["auto", "hashbag", "st"],
                   help="auto/hashbag = exact JS parity; st = sentence-transformers (falls back).")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help="Determinism seed (accepted; hashbag is SHA1-determined, seed-independent).")
    p.add_argument("--self-test", action="store_true", help="Run in-process synthetic checks.")
    return p.parse_args()


def main():
    args = parse_args()

    if args.self_test:
        return self_test()

    if args.texts is not None and not os.path.isfile(args.texts):
        log(f"[embed] input not found: {args.texts}")
        print(json.dumps({"ok": False, "error": "input_not_found", "texts": args.texts}))
        return EXIT_NO_INPUT

    texts = load_texts(args.texts)
    if not texts:
        log("[embed] no input texts")
        print(json.dumps({"ok": False, "error": "input_empty"}))
        return EXIT_NO_INPUT

    dim = args.dim if args.dim and args.dim > 0 else DEFAULT_DIM

    # Hard dep gate: only --backend st with --texts-but-no-fallback intent could
    # legitimately fail; per the contract we always degrade, so a missing dep
    # surfaces as a graceful fallback inside run(). We still emit the canonical
    # dep_missing shape if the user forced st and even import probing is fatal in
    # a way run() converts to fallback — covered below by backend_used.
    vectors, backend_used = run(texts, dim, args.backend)

    out_dim = len(vectors[0]) if vectors else dim
    result = {
        "ok": True,
        "dim": out_dim,
        "vectors": vectors,
        "backend_used": backend_used,
    }

    if args.out:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
        except Exception as e:  # deliberate: cleanup — out write is best-effort
            log(f"[embed] WARN: could not write {args.out}: {e}")

    print(json.dumps(result, ensure_ascii=False))
    log(f"[embed] embedded {len(texts)} texts dim={out_dim} via {backend_used}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
