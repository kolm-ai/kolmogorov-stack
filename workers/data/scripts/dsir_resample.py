#!/usr/bin/env python3
"""DSIR — Data Selection via Importance Resampling (optional accel backend).

This is the OPTIONAL python acceleration backend for the distribution-matched
arm of src/data-select.js (selectInformativeSubset). That JS function already
has a complete, deterministic, zero-dep fallback: cosine-to-target-centroid
importance + a diversity gate. This worker implements the canonical DSIR
recipe (Xie et al., NeurIPS'23, arXiv:2302.03169) more faithfully, so callers
that have python available get the real importance-resampling estimator while
everyone else keeps the JS path.

DSIR, precisely:

  1. Featurize every example into a fixed-dimension HASHED n-gram bag (the
     same trick src/embedding.js uses on the JS side: hash each token/n-gram
     into D buckets, sign-folded so the bag is a deterministic count vector).
     DSIR's original implementation uses hashed unigram+bigram features; we
     hash unigrams + char trigrams to mirror the JS embedder's feature mix.
  2. Estimate two bag-of-features distributions as smoothed multinomials over
     the D buckets: p_target from the TARGET corpus, q_raw from the RAW pool.
     With no target corpus we fall back to a uniform target (DSIR degenerates
     to length-normalized self-selection — every example weighted by how
     "generic" it is), which still beats top-N but is the weak case.
  3. Per-example importance weight = sum over the example's features of
     log(p_target / q_raw) (the log-likelihood ratio of the two multinomials
     under the example's feature counts). This is DSIR's importance weight.
  4. Gumbel-top-k WITHOUT replacement: add deterministic Gumbel noise (seeded)
     to each log-weight and take the top-k. This is the Gumbel-max trick for
     sampling k items without replacement proportional to exp(weight), and it
     is fully reproducible for a fixed seed (the original DSIR samples with
     replacement; Gumbel-top-k is the dedup-friendly without-replacement
     analogue and is what kolm wants for a training subset).

Determinism: NO wall-clock, NO global RNG in control flow. All randomness is a
seeded SplitMix64 stream keyed by (seed, example_index), so the same input +
seed always yields the same subset, on any machine, with or without numpy.

Graceful degradation: numpy is OPTIONAL and only speeds the math. If numpy is
absent the pure-python path runs (identical results). The only way this prints
{ok:false, error:'dep_missing'} is if a feature explicitly requires a missing
package — the core path needs only the stdlib, so dep_missing is essentially
never hit here; it exists to honor the worker contract.

Interface (argv):
  --pairs <jsonl>     RAW pool, one JSON object per line ({input,output} or a
                      bare string). Default: read JSONL from stdin.
  --target <jsonl>    Optional TARGET distribution corpus (same row shape). If
                      absent the target is uniform (self/coverage mode).
  --out <json>        Optional path to also write the JSON result.
  --target-size <int> How many examples to resample. Default: len(raw).
  --seed <int>        Deterministic seed. Default: 0x6b6f6c6d.
  --dim <int>         Hashed feature dimension. Default: 4096.
  --self-test         Run an in-process synthetic check; print PASS/FAIL.

stdout: a single JSON object {ok:true, selected_indices:int[], weights:float[]}
where weights[i] is the DSIR importance weight of RAW example i (same order/
length as the input pool, NOT the selected subset). Human progress -> stderr.

Exit codes: 0 ok (incl. graceful degrade / self-test) · 20 input missing/empty.
"""

import argparse
import json
import math
import os
import re
import sys

EXIT_OK = 0
EXIT_NO_INPUT = 20

DEFAULT_SEED = 0x6B6F6C6D  # "kolm" — the canonical kolm worker seed
DEFAULT_DIM = 4096

_WORD = re.compile(r"[a-z0-9]+")
_MASK64 = (1 << 64) - 1


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# --- deterministic seeded PRNG (SplitMix64) ----------------------------------
def _splitmix64(state):
    """One SplitMix64 step. Returns (uint64, next_state). No global RNG."""
    state = (state + 0x9E3779B97F4A7C15) & _MASK64
    z = state
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK64
    z = z ^ (z >> 31)
    return z, state


def _uniform01(state):
    """Deterministic uniform in (0,1) plus the advanced state."""
    z, state = _splitmix64(state)
    # 53-bit mantissa -> double in [0,1); nudge off the exact 0 endpoint.
    u = ((z >> 11) / float(1 << 53))
    if u <= 0.0:
        u = 5e-324
    return u, state


def _gumbel(state):
    """Standard Gumbel(0,1) sample = -log(-log(U)). Deterministic given state."""
    u, state = _uniform01(state)
    return -math.log(-math.log(u)), state


# --- row IO ------------------------------------------------------------------
def _row_input(r):
    if isinstance(r, str):
        return r
    if isinstance(r, dict):
        v = r.get("input")
        if isinstance(v, str):
            return v
        v = r.get("prompt")
        if isinstance(v, str):
            return v
    return ""


def _row_output(r):
    if isinstance(r, dict):
        for k in ("output", "teacher_output", "response"):
            v = r.get(k)
            if isinstance(v, str):
                return v
    return ""


def _row_text(r):
    if isinstance(r, str):
        return r
    return (_row_input(r) + "\n\n" + _row_output(r)).strip()


def load_rows(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:  # deliberate: skip a single malformed line
                rows.append(line)
    return rows


def load_rows_stdin():
    rows = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:  # deliberate: tolerate bare-string lines
            rows.append(line)
    return rows


# --- hashed n-gram featurization (mirrors src/embedding.js feature mix) -------
def _fnv1a(s):
    """Deterministic 64-bit FNV-1a hash of a string. Same on every machine."""
    h = 0xCBF29CE484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & _MASK64
    return h


def feature_counts(text, dim):
    """Hashed bag of unigrams + char trigrams -> {bucket: count}. Deterministic."""
    text = (text or "").lower()
    feats = {}
    for w in _WORD.findall(text):
        b = _fnv1a("u:" + w) % dim
        feats[b] = feats.get(b, 0.0) + 1.0
    padded = " " + re.sub(r"\s+", " ", text).strip() + " "
    for i in range(len(padded) - 2):
        b = _fnv1a("t:" + padded[i:i + 3]) % dim
        feats[b] = feats.get(b, 0.0) + 0.5
    return feats


def aggregate_distribution(feature_dicts, dim):
    """Smoothed multinomial over D buckets from a list of feature-count dicts.
    Laplace +1 smoothing so no bucket has zero mass (keeps log-ratio finite)."""
    totals = [1.0] * dim  # additive smoothing
    grand = float(dim)
    for fd in feature_dicts:
        for b, c in fd.items():
            totals[b] += c
            grand += c
    inv = 1.0 / grand
    return [t * inv for t in totals]


def importance_weights(raw_feats, p_target, q_raw, dim):
    """DSIR per-example weight = sum_f count_f * log(p_target_f / q_raw_f).

    This is the log of the bag-of-features importance ratio under the two
    multinomials (constant feature-independent terms cancel under top-k, so we
    keep the data-dependent sum). A uniform target makes log(p_target_f) a
    constant, reducing this to -sum count_f*log(q_raw_f): rare-in-pool features
    score higher (the coverage-flavored degenerate case)."""
    log_ratio = [0.0] * dim
    for b in range(dim):
        log_ratio[b] = math.log(p_target[b]) - math.log(q_raw[b])
    weights = []
    for fd in raw_feats:
        w = 0.0
        for b, c in fd.items():
            w += c * log_ratio[b]
        weights.append(w)
    return weights


# --- Gumbel-top-k without replacement (seeded, deterministic) ----------------
def gumbel_top_k(weights, k, seed):
    """Sample k indices without replacement, proportional to exp(weight), via
    the Gumbel-top-k trick: key_i = weight_i + Gumbel_i, take the k largest.
    Each Gumbel is drawn from an index-keyed SplitMix64 stream so the result is
    bit-reproducible for a fixed seed regardless of platform / numpy presence."""
    n = len(weights)
    k = max(0, min(int(k), n))
    keyed = []
    base = seed & _MASK64
    for i, w in enumerate(weights):
        # key each index's stream by (seed, i) so per-index draws are independent
        st = (base ^ ((i + 1) * 0x9E3779B97F4A7C15)) & _MASK64
        g, _ = _gumbel(st)
        keyed.append((w + g, i))
    # sort by perturbed key desc, tie-break by original index asc (stable+det)
    keyed.sort(key=lambda t: (-t[0], t[1]))
    sel = sorted(idx for _, idx in keyed[:k])
    return sel


# --- numpy fast path (optional; identical results) ---------------------------
def _try_numpy_weights(raw_feats, p_target, q_raw, dim):
    """Optional numpy acceleration of the importance-weight sum. Returns the
    weight list, or None if numpy is unavailable (caller uses pure path)."""
    try:
        import numpy as np
    except Exception:  # deliberate: numpy is OPTIONAL — degrade to pure python
        return None
    log_ratio = np.log(np.asarray(p_target)) - np.log(np.asarray(q_raw))
    weights = []
    for fd in raw_feats:
        if not fd:
            weights.append(0.0)
            continue
        idx = np.fromiter(fd.keys(), dtype=np.int64, count=len(fd))
        cnt = np.fromiter(fd.values(), dtype=np.float64, count=len(fd))
        weights.append(float(np.dot(cnt, log_ratio[idx])))
    return weights


# --- core --------------------------------------------------------------------
def dsir_select(raw_rows, target_rows, target_size, seed, dim):
    """Run DSIR end to end. Returns (selected_indices, weights, backend)."""
    raw_feats = [feature_counts(_row_text(r), dim) for r in raw_rows]
    q_raw = aggregate_distribution(raw_feats, dim)

    if target_rows:
        tgt_feats = [feature_counts(_row_text(r), dim) for r in target_rows]
        p_target = aggregate_distribution(tgt_feats, dim)
        mode = "target-corpus"
    else:
        # uniform target distribution -> coverage-flavored degenerate DSIR
        p_target = [1.0 / dim] * dim
        mode = "uniform-target"

    weights = _try_numpy_weights(raw_feats, p_target, q_raw, dim)
    backend = "numpy"
    if weights is None:
        weights = importance_weights(raw_feats, p_target, q_raw, dim)
        backend = "pure-python"

    k = target_size if (isinstance(target_size, int) and target_size > 0) else len(raw_rows)
    selected = gumbel_top_k(weights, k, seed)
    return selected, weights, backend + ":" + mode


# --- self-test ---------------------------------------------------------------
def run_self_test():
    """Raw pool skewed to topic A; target skewed to topic B. After DSIR the
    resampled subset must shift toward B (higher B-fraction than the raw pool).
    Deterministic: fixed seed, no RNG outside the seeded stream."""
    log("[dsir] self-test: building synthetic A-skewed pool + B-skewed target")

    topic_a = "invoice billing payment refund charge receipt subscription plan upgrade"
    topic_b = "rocket orbit telescope galaxy planet asteroid nebula spacecraft launch"

    def make(words, n, salt):
        out = []
        toks = words.split()
        for i in range(n):
            # deterministic rotation so rows differ but stay on-topic
            rot = toks[i % len(toks):] + toks[:i % len(toks)]
            out.append({"input": f"q{salt}{i}", "output": " ".join(rot)})
        return out

    # raw: 80% A, 20% B  (25 rows)
    raw = make(topic_a, 20, "a") + make(topic_b, 5, "b")
    a_idx = set(range(0, 20))  # indices that are topic-A in the raw pool
    raw_b_frac = 5 / 25.0

    # target: pure topic B
    target = make(topic_b, 12, "tb")

    target_size = 12
    selected, weights, backend = dsir_select(raw, target, target_size, DEFAULT_SEED, 1024)

    sel_b = sum(1 for i in selected if i not in a_idx)
    sel_b_frac = sel_b / float(len(selected)) if selected else 0.0

    passed = 0
    failed = 0

    # 1) the subset must shift toward B vs the raw proportion
    if sel_b_frac > raw_b_frac:
        log(f"[dsir] PASS shift-toward-B: subset B-frac {sel_b_frac:.2f} > raw {raw_b_frac:.2f}")
        passed += 1
    else:
        log(f"[dsir] FAIL shift-toward-B: subset B-frac {sel_b_frac:.2f} <= raw {raw_b_frac:.2f}")
        failed += 1

    # 2) every selected index is valid and unique (no replacement)
    if len(selected) == len(set(selected)) and all(0 <= i < len(raw) for i in selected):
        log(f"[dsir] PASS valid-unique: {len(selected)} distinct in-range indices")
        passed += 1
    else:
        log("[dsir] FAIL valid-unique: duplicate or out-of-range indices")
        failed += 1

    # 3) determinism: same seed -> identical selection
    sel2, _, _ = dsir_select(raw, target, target_size, DEFAULT_SEED, 1024)
    if sel2 == selected:
        log("[dsir] PASS determinism: identical selection on re-run")
        passed += 1
    else:
        log("[dsir] FAIL determinism: selection changed across identical runs")
        failed += 1

    # 4) topic-B raw rows must out-weight topic-A raw rows under a B target
    avg_a = sum(weights[i] for i in range(20)) / 20.0
    avg_b = sum(weights[i] for i in range(20, 25)) / 5.0
    if avg_b > avg_a:
        log(f"[dsir] PASS weight-order: avg B-weight {avg_b:.3f} > avg A-weight {avg_a:.3f}")
        passed += 1
    else:
        log(f"[dsir] FAIL weight-order: avg B-weight {avg_b:.3f} <= avg A-weight {avg_a:.3f}")
        failed += 1

    log(f"[dsir] self-test backend={backend} PASS={passed} FAIL={failed}")
    print(json.dumps({"ok": failed == 0, "self_test": True,
                      "passed": passed, "failed": failed, "backend": backend}))
    return EXIT_OK if failed == 0 else 1


# --- cli ---------------------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(description="DSIR importance-resampling subset selection.")
    p.add_argument("--pairs", default=None, help="Raw pool JSONL (default: stdin).")
    p.add_argument("--target", default=None,
                   help="Target distribution JSONL (optional; absent => uniform target).")
    p.add_argument("--out", default=None, help="Also write the JSON result here.")
    p.add_argument("--target-size", type=int, default=0,
                   help="How many examples to resample (default: size of the raw pool).")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help=f"Deterministic seed (default {DEFAULT_SEED}).")
    p.add_argument("--dim", type=int, default=DEFAULT_DIM,
                   help=f"Hashed feature dimension (default {DEFAULT_DIM}).")
    p.add_argument("--self-test", action="store_true",
                   help="Run an in-process synthetic check and print PASS/FAIL.")
    return p.parse_args()


def main():
    args = parse_args()

    if args.self_test:
        return run_self_test()

    if args.pairs:
        if not os.path.isfile(args.pairs):
            log(f"[dsir] input not found: {args.pairs}")
            print(json.dumps({"ok": False, "error": "input_not_found", "pairs": args.pairs}))
            return EXIT_NO_INPUT
        raw_rows = load_rows(args.pairs)
    else:
        raw_rows = load_rows_stdin()

    if not raw_rows:
        log("[dsir] raw pool is empty")
        print(json.dumps({"ok": False, "error": "input_empty"}))
        return EXIT_NO_INPUT

    target_rows = []
    if args.target:
        if not os.path.isfile(args.target):
            log(f"[dsir] target not found: {args.target}")
            print(json.dumps({"ok": False, "error": "target_not_found", "target": args.target}))
            return EXIT_NO_INPUT
        target_rows = load_rows(args.target)

    dim = max(64, int(args.dim) if args.dim else DEFAULT_DIM)
    selected, weights, backend = dsir_select(
        raw_rows, target_rows, args.target_size, args.seed & _MASK64, dim)

    result = {
        "ok": True,
        "version": "dsir-v1",
        "backend_used": backend,
        "n_in": len(raw_rows),
        "n_target": len(target_rows),
        "n_selected": len(selected),
        "seed": args.seed,
        "dim": dim,
        "selected_indices": selected,
        "weights": [round(w, 6) for w in weights],
    }

    if args.out:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
        except Exception as e:  # deliberate: --out write is best-effort
            log(f"[dsir] WARN: could not write --out {args.out}: {e}")

    log(f"[dsir] selected {len(selected)}/{len(raw_rows)} via {backend}")
    print(json.dumps(result, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
