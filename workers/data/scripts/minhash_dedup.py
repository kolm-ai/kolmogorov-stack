#!/usr/bin/env python3
"""KOLM Data Engine — MinHash + LSH near-dup deduper (W921), python parity mirror.

OPTIONAL acceleration backend for src/minhash-dedup.js. The JS module is the
source of truth; this script is a deterministic PARITY mirror — a given text
yields the SAME shingle hashes, MinHash signature, LSH buckets and
dedup_signature in python and JS, because both share:

  * seed 0x6b6f6c6d ('kolm') and the Numerical-Recipes LCG
    state = (1664525*state + 1013904223) mod 2^32
  * 32-bit FNV-1a over each char's low byte (charCodeAt(i) & 0xff)
  * NORMALIZED word 5-gram shingles (lowercase, collapse whitespace, trim)
    — matches src/minhash-dedup.js shingleSet (WORD grams, not char grams)
  * universal hash family h_i(x) = (a_i*x + b_i) mod (2^31-1),
    a_i in [1,P-1], b_i in [0,P-1], drawn from the shared LCG
  * LSH banding with a band-index-namespaced FNV-1a bucket key
  * sha256 dedup_signature over canonical params + the sorted removal set

Core path is pure stdlib (no numpy/sklearn needed) — there is no heavy-ML
dependency to miss, so this worker always runs. It still follows the worker
contract: read JSONL pairs from --pairs or stdin, write a JSON result to stdout
(and --out if given), never crash on malformed input, and expose --self-test.

Usage:
  python minhash_dedup.py --pairs pairs.jsonl [--out result.json] \
      [--threshold 0.8] [--num-perm 128] [--bands 16] [--rows 8] \
      [--key pair|input|output] [--k 5] [--seed 1801677709] [--no-verify]
  echo '{"input":"a","output":"b"}' | python minhash_dedup.py --self-test

stdout JSON: {ok:true, duplicate_groups:int[][], kept_indices:int[],
removed:int, ...}. Exit 0 on success and on --self-test all-pass; exit 1 on
self-test failure; exit 2 on argparse error.
"""

import argparse
import hashlib
import json
import re
import sys

MINHASH_VERSION = "minhash-v1"
MERSENNE_P = 0x7FFFFFFF          # 2^31 - 1
DEFAULT_SEED = 0x6B6F6C6D        # 'kolm' == 1802464365 (matches JS DEFAULT_SEED)
NGRAM_K = 5
U32 = 0xFFFFFFFF

EXIT_OK = 0
EXIT_FAIL = 1


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# ── 1. SHINGLE ───────────────────────────────────────────────────────────────

def fnv1a32(s):
    """32-bit FNV-1a over each char's low byte — mirrors JS fnv1a32."""
    h = 0x811C9DC5
    for ch in str("" if s is None else s):
        h ^= (ord(ch) & 0xFF)
        h = (h * 0x01000193) & U32
    return h


_WS_RE = re.compile(r"\s+")


def _normalize_text(text):
    return _WS_RE.sub(" ", str("" if text is None else text).lower()).strip()


def shingle_set(text, k=NGRAM_K):
    """Set of FNV-1a-hashed word k-grams (normalized). Short text (< k tokens)
    collapses to a single whole-sequence shingle — mirrors JS shingleSet."""
    out = set()
    norm = _normalize_text(text)
    if not norm:
        return out
    toks = [t for t in norm.split(" ") if t]
    if not toks:
        return out
    try:
        kk = max(1, int(k))
    except (TypeError, ValueError):
        kk = NGRAM_K
    if len(toks) < kk:
        out.add(fnv1a32(" ".join(toks)))
        return out
    for i in range(0, len(toks) - kk + 1):
        out.add(fnv1a32(" ".join(toks[i:i + kk])))
    return out


# ── 2. SIGNATURE ─────────────────────────────────────────────────────────────

def _lcg(seed):
    """Seeded LCG (Numerical Recipes constants) — mirrors JS _lcg."""
    state = (seed & U32) or 1

    def nxt():
        nonlocal state
        state = (1664525 * state + 1013904223) & U32
        return state
    return nxt


def make_permutations(num_hashes=128, seed=DEFAULT_SEED):
    """FIXED seeded universal hash family — mirrors JS makePermutations.
    a_i in [1, P-1] (non-degenerate), b_i in [0, P-1]."""
    try:
        n = max(1, int(num_hashes))
    except (TypeError, ValueError):
        n = 128
    rng = _lcg((int(seed) & U32) or DEFAULT_SEED)
    a = [0] * n
    b = [0] * n
    for i in range(n):
        a[i] = (rng() % (MERSENNE_P - 1)) + 1
        b[i] = rng() % MERSENNE_P
    return a, b


def minhash_signature(shingles, perms):
    """MinHash signature: sig[i] = min over shingles of (a_i*x + b_i) mod P.
    Empty shingle set => all-zero signature. Mirrors JS minhashSignature.
    Python bignums make (a*x+b) exact, so no 16-bit split is needed."""
    a, b = perms
    n = len(a)
    sig = [0] * n
    if not shingles:
        return sig
    for i in range(n):
        ai = a[i]
        bi = b[i]
        mn = MERSENNE_P
        for x in shingles:
            h = (ai * (x & U32) + bi) % MERSENNE_P
            if h < mn:
                mn = h
        sig[i] = mn
    return sig


# ── 3. LSH BANDING ───────────────────────────────────────────────────────────

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _to_base36(n):
    n &= U32
    if n == 0:
        return "0"
    out = ""
    while n > 0:
        out = _B36[n % 36] + out
        n //= 36
    return out


def lsh_buckets(signature, bands=16, rows=8):
    """Band-hashed, band-index-namespaced bucket keys — mirrors JS lshBuckets."""
    sig = signature or []
    try:
        b = max(1, int(bands))
    except (TypeError, ValueError):
        b = 16
    try:
        r = max(1, int(rows))
    except (TypeError, ValueError):
        r = 8
    out = []
    floor_div = len(sig) // r
    usable = min(b, floor_div if floor_div else (1 if len(sig) >= 1 else 0))
    for band in range(usable):
        h = 0x811C9DC5
        bi = band & U32
        for _ in range(4):
            h ^= (bi & 0xFF)
            h = (h * 0x01000193) & U32
            bi >>= 8
        for slot in range(r):
            v = sig[band * r + slot] & U32
            for _ in range(4):
                h ^= (v & 0xFF)
                h = (h * 0x01000193) & U32
                v >>= 8
        out.append("b" + str(band) + ":" + _to_base36(h & U32))
    return out


# ── 4. JACCARD ───────────────────────────────────────────────────────────────

def estimate_jaccard(sig_a, sig_b):
    """Fraction of agreeing signature slots — mirrors JS estimateJaccard."""
    n = min(len(sig_a), len(sig_b))
    if n == 0:
        return 0.0
    agree = sum(1 for i in range(n) if sig_a[i] == sig_b[i])
    return agree / n


def _true_jaccard(set_a, set_b):
    if set_a is None or set_b is None:
        return 0.0
    if not set_a and not set_b:
        return 1.0
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    union = len(set_a) + len(set_b) - inter
    return 0.0 if union == 0 else inter / union


# ── UNION-FIND ───────────────────────────────────────────────────────────────

class UnionFind:
    def __init__(self, n):
        n = max(0, int(n))
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, i):
        root = i
        while self.parent[root] != root:
            root = self.parent[root]
        cur = i
        while self.parent[cur] != root:
            self.parent[cur], cur = root, self.parent[cur]
        return root

    def union(self, i, j):
        ri, rj = self.find(i), self.find(j)
        if ri == rj:
            return
        if self.rank[ri] < self.rank[rj]:
            self.parent[ri] = rj
        elif self.rank[ri] > self.rank[rj]:
            self.parent[rj] = ri
        else:
            self.parent[rj] = ri
            self.rank[ri] += 1

    def components(self):
        comp = {}
        for i in range(len(self.parent)):
            comp.setdefault(self.find(i), []).append(i)
        return comp


# ── survivor selection (confidence > teacher-priority > quality) ─────────────

_HARD_COT = [re.compile(p, re.I) for p in (
    r"</?think>", r"</?reasoning>", r"<\|?\s*thinking\s*\|?>", r"<\|?\s*reasoning\s*\|?>")]
_REFUSAL = re.compile(
    r"\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b", re.I)
_STRUCTURE = re.compile(r"(^|\n)\s*(\d+[.)]|[-*•])\s+", re.M)
_WORDS_RE = re.compile(r"[a-z0-9]+")


def _pair_input(p):
    if not isinstance(p, dict):
        return ""
    for key in ("input", "prompt"):
        if isinstance(p.get(key), str):
            return p[key]
    return ""


def _pair_output(p):
    if not isinstance(p, dict):
        return ""
    for key in ("output", "teacher_output", "response"):
        if isinstance(p.get(key), str):
            return p[key]
    return ""


def _pair_teacher(p):
    if not isinstance(p, dict):
        return ""
    return str(p.get("_teacher_phase") or p.get("teacher")
               or p.get("teacher_spec") or p.get("vendor") or "")


def _pair_text(p, key):
    if key == "input":
        return _pair_input(p)
    if key == "output":
        return _pair_output(p)
    return (_pair_input(p) + "\n\n" + _pair_output(p)).strip()


def _token_overlap(candidate, reference):
    ref = {w for w in _WORDS_RE.findall(str(reference or "").lower()) if len(w) > 2}
    if not ref:
        return 0.0
    cand = {w for w in _WORDS_RE.findall(str(candidate or "").lower()) if len(w) > 2}
    return sum(1 for w in cand if w in ref) / len(ref)


def _score_quality(text, seed):
    s = str("" if text is None else text)
    score = 0.5
    if any(rx.search(s) for rx in _HARD_COT):
        score -= 0.5
    if _REFUSAL.search(s):
        score -= 0.2
    n = len(s.strip())
    if n < 20:
        score -= 0.2
    elif n < 60:
        score -= 0.1
    elif n <= 1200:
        score += 0.1
    elif n > 2000:
        score -= 0.1
    if _STRUCTURE.search(s):
        score += 0.05
    if seed:
        score += 0.3 * _token_overlap(s, seed)
    return max(0.0, min(1.0, score))


def _match_teacher_rank(teacher, priority):
    t = str(teacher or "").lower()
    for i, raw in enumerate(priority):
        key = str(raw or "").lower()
        if key and key in t:
            return i
    return sys.maxsize


def _confidence_key(pair, idx, priority):
    explicit = pair.get("confidence") if isinstance(pair, dict) else None
    base = explicit if isinstance(explicit, (int, float)) and not isinstance(explicit, bool) \
        else _score_quality(_pair_output(pair),
                            pair.get("seed_output") if isinstance(pair, dict) else None)
    rank = _match_teacher_rank(_pair_teacher(pair), priority)
    # SMALLER sorts first = better survivor: (teacher_rank, -quality, original_idx)
    return (rank, -base, idx)


# ── dedup_signature (receipt, parity with JS dedupSignature) ─────────────────

def _canon_params(params):
    p = params or {}
    return {
        "bands": p.get("bands"),
        "jaccardThreshold": p.get("jaccardThreshold"),
        "k": p.get("k"),
        "key": p.get("key"),
        "numHashes": p.get("numHashes"),
        "rows": p.get("rows"),
        "seed": p.get("seed"),
        "verify": p.get("verify"),
    }


def dedup_signature(removals, params):
    sorted_rm = sorted(
        ([r["removed_idx"], r["kept_idx"], r["est_jaccard"]] for r in (removals or [])),
        key=lambda x: (x[0], x[1]))
    # JSON.stringify produces no whitespace — match separators exactly.
    payload = json.dumps({"params": _canon_params(params), "removals": sorted_rm},
                         separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ── minhash_predup (headline) ────────────────────────────────────────────────

def _round4(x):
    # Mirror JS Number(x.toFixed(4)): round-half-up to 4 dp, drop trailing zeros.
    return float(f"{x:.4f}")


def minhash_predup(pairs, num_hashes=128, bands=16, rows=8, jaccard_threshold=0.8,
                   key="pair", k=NGRAM_K, verify=True, teacher_priority=None,
                   seed=DEFAULT_SEED):
    rows_in = pairs if isinstance(pairs, list) else []
    priority = teacher_priority or []
    num_hashes = max(1, int(num_hashes))
    bands = max(1, int(bands))
    rows_pb = max(1, int(rows))
    # Keep banding consistent with signature length; clamp if misconfigured.
    if bands * rows_pb > num_hashes:
        rows_pb = max(1, num_hashes // bands) if num_hashes // bands else 1
        bands = max(1, num_hashes // rows_pb)
    k = max(1, int(k))
    key = key if key in ("input", "output") else "pair"
    seed = (int(seed) & U32) or DEFAULT_SEED

    params = {
        "numHashes": num_hashes, "bands": bands, "rows": rows_pb,
        "jaccardThreshold": jaccard_threshold, "key": key, "k": k,
        "verify": bool(verify), "seed": seed,
    }
    n = len(rows_in)
    if n == 0:
        return {"kept": [], "clusters": [], "removals": [],
                "report": {"n_in": 0, "n_kept": 0, "n_removed": 0, "n_clusters": 0,
                           "params": params, "backend": "minhash-py",
                           "version": MINHASH_VERSION,
                           "dedup_signature": dedup_signature([], params)}}

    perms = make_permutations(num_hashes, seed)
    shingle_sets = [None] * n
    signatures = [None] * n
    bucket_map = {}
    for i in range(n):
        sh = shingle_set(_pair_text(rows_in[i], key), k)
        shingle_sets[i] = sh
        sig = minhash_signature(sh, perms)
        signatures[i] = sig
        for bk in lsh_buckets(sig, bands, rows_pb):
            bucket_map.setdefault(bk, []).append(i)

    uf = UnionFind(n)
    edge_jaccard = {}
    for arr in bucket_map.values():
        if len(arr) < 2:
            continue
        for x in range(len(arr)):
            for y in range(x + 1, len(arr)):
                i, j = arr[x], arr[y]
                if uf.find(i) == uf.find(j):
                    continue
                est = estimate_jaccard(signatures[i], signatures[j])
                if verify and _true_jaccard(shingle_sets[i], shingle_sets[j]) < jaccard_threshold:
                    continue
                uf.union(i, j)
                ek = (i, j) if i < j else (j, i)
                edge_jaccard.setdefault(ek, est)

    conf_keys = [_confidence_key(rows_in[i], i, priority) for i in range(n)]
    kept_idx = set()
    removals = []
    clusters = []
    for members in uf.components().values():
        if len(members) == 1:
            kept_idx.add(members[0])
            continue
        ordered = sorted(members, key=lambda a: conf_keys[a])
        survivor = ordered[0]
        kept_idx.add(survivor)
        clusters.append(list(ordered))
        for dropped in ordered[1:]:
            ek = (dropped, survivor) if dropped < survivor else (survivor, dropped)
            est = edge_jaccard.get(ek)
            if est is None:
                est = estimate_jaccard(signatures[dropped], signatures[survivor])
            removals.append({"removed_idx": dropped, "kept_idx": survivor,
                             "est_jaccard": _round4(est)})

    kept = [rows_in[i] for i in range(n) if i in kept_idx]
    removals.sort(key=lambda r: r["removed_idx"])
    report = {
        "n_in": n, "n_kept": len(kept), "n_removed": len(removals),
        "n_clusters": len(clusters), "params": params, "backend": "minhash-py",
        "version": MINHASH_VERSION, "dedup_signature": dedup_signature(removals, params),
    }
    return {"kept": kept, "clusters": clusters, "removals": removals, "report": report}


# ── I/O ──────────────────────────────────────────────────────────────────────

def _read_pairs(path):
    rows = []
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    else:
        lines = sys.stdin.readlines()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except (ValueError, json.JSONDecodeError):
            rows.append({})  # malformed row => empty singleton, never crash
    return rows


def _result_payload(res):
    clusters = res["clusters"]
    return {
        "ok": True,
        "duplicate_groups": clusters,
        "kept_indices": sorted(
            set(range(res["report"]["n_in"]))
            - {r["removed_idx"] for r in res["removals"]}),
        "removed": res["report"]["n_removed"],
        "removals": res["removals"],
        "report": res["report"],
    }


# ── self-test ────────────────────────────────────────────────────────────────

def self_test():
    passed = 0
    failed = 0

    def check(name, cond):
        nonlocal passed, failed
        if cond:
            passed += 1
        else:
            failed += 1
            log("FAIL: " + name)

    # Parity anchors — hardcoded values computed by the SAME rule in src/minhash-dedup.js.
    check("fnv1a32('hello')==1335831723", fnv1a32("hello") == 1335831723)
    probe = "the quick brown fox jumps over the lazy dog every single day"
    sh = shingle_set(probe, 5)
    check("shingle_count==8", len(sh) == 8)
    perms = make_permutations(8, DEFAULT_SEED)
    sig = minhash_signature(sh, perms)
    expected_sig = [288924298, 266010380, 89006213, 529880666,
                    117969097, 56977850, 356430962, 258301406]
    check("sig8 matches JS", sig == expected_sig)
    check("buckets match JS",
          lsh_buckets(sig, 4, 2) == ["b0:l46mo8", "b1:minclk", "b2:1g33zhu", "b3:1te141w"])

    # 3 near-dups + 3 distinct => near-dups collapse to one group, distinct stay.
    near = "the annual report shows revenue grew twelve percent over the prior fiscal year"
    pairs = [
        {"input": "q1", "output": near},
        {"input": "q2", "output": near + " indeed"},
        {"input": "q3", "output": "the annual report shows revenue grew twelve percent over the prior year"},
        {"input": "q4", "output": "kubernetes schedules containerized workloads across a fleet of worker nodes"},
        {"input": "q5", "output": "photosynthesis converts sunlight carbon dioxide and water into glucose and oxygen"},
        {"input": "q6", "output": "the mitochondria is widely described as the powerhouse of the eukaryotic cell"},
    ]
    res = minhash_predup(pairs, num_hashes=128, bands=16, rows=8,
                         jaccard_threshold=0.6, key="output")
    payload = _result_payload(res)
    check("near-dups collapse to one group",
          len(payload["duplicate_groups"]) == 1
          and sorted(payload["duplicate_groups"][0]) == [0, 1, 2])
    check("kept_indices == 4 (1 survivor + 3 distinct)",
          len(payload["kept_indices"]) == 4)
    check("removed == 2", payload["removed"] == 2)
    check("distinct rows survive",
          all(i in payload["kept_indices"] for i in (3, 4, 5)))

    # Determinism: same seed/input => identical signature receipt.
    res2 = minhash_predup(pairs, num_hashes=128, bands=16, rows=8,
                          jaccard_threshold=0.6, key="output")
    check("dedup_signature deterministic",
          res["report"]["dedup_signature"] == res2["report"]["dedup_signature"])
    check("dedup_signature is sha256",
          res["report"]["dedup_signature"].startswith("sha256:")
          and len(res["report"]["dedup_signature"]) == len("sha256:") + 64)

    # Empty corpus is a clean no-op (envelope contract).
    empty = minhash_predup([], jaccard_threshold=0.6)
    check("empty corpus no-op", empty["report"]["n_in"] == 0
          and empty["report"]["n_removed"] == 0)

    # Malformed rows never crash; empty-text rows form an all-zero-sig group.
    res3 = minhash_predup([{}, {"input": 5}, {"output": near}], jaccard_threshold=0.6)
    check("malformed rows survive without crash", res3["report"]["n_in"] == 3)

    log(f"self-test: PASS={passed} FAIL={failed}")
    return failed == 0


# ── main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="MinHash + LSH near-duplicate deduper (python parity mirror of src/minhash-dedup.js).")
    p.add_argument("--pairs", default=None, help="Input JSONL of pairs (default: stdin).")
    p.add_argument("--out", default=None, help="Also write the JSON result here.")
    p.add_argument("--threshold", type=float, default=0.8,
                   help="True-Jaccard verify floor (default 0.8).")
    p.add_argument("--num-perm", type=int, default=128, help="MinHash permutations (default 128).")
    p.add_argument("--bands", type=int, default=16, help="LSH bands (default 16).")
    p.add_argument("--rows", type=int, default=8, help="LSH rows per band (default 8).")
    p.add_argument("--key", default="pair", choices=["pair", "input", "output"],
                   help="Which text to dedup on (default pair=input+output).")
    p.add_argument("--k", type=int, default=NGRAM_K, help="Shingle word-gram size (default 5).")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help=f"Permutation seed (default {DEFAULT_SEED}).")
    p.add_argument("--teacher-priority", default=None,
                   help="Comma list ranking teachers best-first for survivor choice.")
    p.add_argument("--no-verify", action="store_true",
                   help="Skip the true-Jaccard verify pass (faster, more LSH FPs).")
    p.add_argument("--self-test", action="store_true",
                   help="Run an in-process parity + dedup check; print PASS/FAIL.")
    return p.parse_args()


def main():
    args = parse_args()
    if args.self_test:
        ok = self_test()
        sys.exit(EXIT_OK if ok else EXIT_FAIL)

    priority = None
    if args.teacher_priority:
        priority = [t.strip() for t in args.teacher_priority.split(",") if t.strip()]

    try:
        pairs = _read_pairs(args.pairs)
    except OSError as e:
        print(json.dumps({"ok": False, "error": "read_failed", "detail": str(e)}))
        sys.exit(EXIT_OK)  # graceful: JS side falls back, do not crash the pipeline

    res = minhash_predup(
        pairs, num_hashes=args.num_perm, bands=args.bands, rows=args.rows,
        jaccard_threshold=args.threshold, key=args.key, k=args.k,
        verify=not args.no_verify, teacher_priority=priority, seed=args.seed)
    payload = _result_payload(res)
    out_str = json.dumps(payload)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(out_str)
        except OSError as e:
            log(f"WARN: could not write --out {args.out}: {e}")
    print(out_str)
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
