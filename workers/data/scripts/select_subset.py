#!/usr/bin/env python3
"""KOLM Data Engine — optional Python acceleration backend for SELECT (W921).

Mirrors src/data-select.js / src/data-diversity-select.js. CURATE today only
FILTERS; this worker SELECTS a budget-bounded subset that maximizes coverage /
representativeness over an embedding of each pair, so each retained teacher
token buys new information instead of re-teaching a dense cluster.

This is an OPTIONAL acceleration path. The JS side (data-select.js) already has
a working pure-JS implementation of every method here and shells out to this
worker only as a speed-up; on ANY failure (missing file, bad args, crash) the
JS side cleanly degrades to its own repr-filter. Accordingly this worker:
  - reads JSONL {input,output} pairs from --pairs <path> or stdin;
  - writes a single JSON result object to stdout (and --out <path> if given);
  - degrades gracefully: a missing OPTIONAL dep (numpy) is fine — it just runs
    the pure-python path and stamps backend_used truthfully. It never crashes;
  - is deterministic: identical input + seed => identical selection (BADGE uses
    a seeded LCG, no wall-clock / os RNG anywhere in control flow).

Embedding mirrors src/embedding.js EXACTLY: a deterministic 256-d hash-bag over
SHA-1 of unigram tokens (±1), char-trigrams (±0.5), char-quadgrams (±0.3),
L2-normalized. No heavy dep is required for the core path — numpy is used only
to speed up distance math when present.

Methods:
  k-center          farthest-point greedy core-set (Sener & Savarese ICLR'18)
  facility-location lazy-greedy submodular max of Σ_i max_j sim(i,j) (apricot)
  badge             distance²-weighted k-means++ seeding (Ash et al. ICLR'20)
  repr-filter       score-descending diversity-gated greedy (DEITA, ICLR'24)

Usage:
  python select_subset.py --method k-center --pairs in.jsonl --out sel.json \
                          --target-size 6 [--seed 1801677709]
  cat in.jsonl | python select_subset.py --method badge --target-size 6
  python select_subset.py --self-test

stdout JSON: {ok:true, selected_indices:int[], coverage_radius:float,
              backend_used:str, ...}. On dep-only failure for a path that needs
it: {ok:false, error:'dep_missing', need:'<pkg>'} with exit 0.

Exit codes: 0 ok (incl. graceful degrade) · 2 bad args (argparse).
"""

import argparse
import hashlib
import json
import math
import os
import sys

# UTF-8 console shim (inlined — _console.py lives in a sibling worker dir and is
# not importable from here). Teacher outputs routinely carry emoji / CJK.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover — Python < 3.7 / pyodide
        pass

DIM = 256
DEFAULT_SEED = 0x6B6F6C6D  # = 1801677709 ("kolm")
VALID_METHODS = ("k-center", "facility-location", "badge", "repr-filter")
VERSION = "select-subset-v1"

EXIT_OK = 0

try:
    import numpy as _np  # noqa
    _HAVE_NUMPY = True
except Exception:  # deliberate: numpy is an OPTIONAL accelerator only
    _np = None
    _HAVE_NUMPY = False


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ── embedding (mirrors src/embedding.js byte-for-byte) ───────────────────────

def _sha1_first4(s):
    """((h[0]<<24)|(h[1]<<16)|(h[2]<<8)|h[3]) >>> 0 over sha1(s), as JS does."""
    h = hashlib.sha1(s.encode("utf-8")).digest()
    return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0xFFFFFFFF


def _hash_index(token, salt=""):
    return _sha1_first4(salt + token)


def _sign(token):
    h = hashlib.sha1(("sign:" + token).encode("utf-8")).digest()
    return 1 if (h[0] & 1) else -1


def _tokens(text):
    # JS: text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    out = []
    cur = []
    for ch in text.lower():
        if ("a" <= ch <= "z") or ("0" <= ch <= "9"):
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def _ngrams(text, n):
    # JS: t = ' ' + lower.replace(/\s+/g,' ').trim() + ' '; sliding window length n
    collapsed = " ".join(text.lower().split())
    t = " " + collapsed + " "
    return [t[i:i + n] for i in range(0, len(t) - n + 1)]


def embed(text):
    """256-d hash-bag, L2-normalized. Identical to src/embedding.js embed()."""
    v = [0.0] * DIM
    for tok in _tokens(text):
        idx = _hash_index(tok, "unigram") % DIM
        v[idx] += _sign(tok)
    for g in _ngrams(text, 3):
        idx = _hash_index(g, "tri") % DIM
        v[idx] += _sign(g) * 0.5
    for g in _ngrams(text, 4):
        idx = _hash_index(g, "quad") % DIM
        v[idx] += _sign(g) * 0.3
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


# ── pair text extraction (mirrors data-select.js _pairText) ──────────────────

def _pair_input(p):
    if not isinstance(p, dict):
        return ""
    for k in ("input", "prompt"):
        val = p.get(k)
        if isinstance(val, str):
            return val
    return ""


def _pair_output(p):
    if not isinstance(p, dict):
        return ""
    for k in ("output", "teacher_output", "response"):
        val = p.get(k)
        if isinstance(val, str):
            return val
    return ""


def _pair_text(p):
    if isinstance(p, str):
        return p
    return (_pair_input(p) + "\n\n" + _pair_output(p)).strip()


def _local_score(p):
    """Mirrors data-select.js _localScore — orders the repr-filter walk."""
    n = len(str(_pair_output(p) or "").strip())
    if n == 0:
        return 0.1
    if n < 20:
        return 0.3
    if n <= 1200:
        return 0.6
    if n <= 2000:
        return 0.55
    return 0.45


# ── vector ops (numpy-accelerated when available, pure-python otherwise) ─────

def _l2(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(len(a))))


def _sq(a, b):
    return sum((a[i] - b[i]) ** 2 for i in range(len(a)))


def _cos(a, b):
    return sum(a[i] * b[i] for i in range(len(a)))


def _resolve_target(target, n):
    try:
        t = float(target)
    except (TypeError, ValueError):
        return n
    if not math.isfinite(t) or t <= 0:
        return n
    if t > 1:
        return min(n, max(1, int(t)))
    return min(n, max(1, round(t * n)))  # fraction


def _coverage_radius_py(embs, selected):
    if not selected or not embs:
        return 0.0
    worst = 0.0
    for i in range(len(embs)):
        best = math.inf
        for j in selected:
            d = _l2(embs[i], embs[j])
            if d < best:
                best = d
        if best > worst:
            worst = best
    return round(worst, 6)


def _coverage_radius_np(mat, selected):
    if not selected or mat is None or mat.shape[0] == 0:
        return 0.0
    sub = mat[selected]                              # [k, d]
    # squared dists [N, k] = |x|² + |c|² - 2 x·c
    g = mat @ sub.T
    xn = (mat * mat).sum(1, keepdims=True)
    cn = (sub * sub).sum(1, keepdims=True).T
    d2 = xn + cn - 2.0 * g
    _np.clip(d2, 0.0, None, out=d2)
    worst = float(_np.sqrt(d2.min(axis=1)).max())
    return round(worst, 6)


# ── seeded LCG (Numerical Recipes; identical to data-diversity-select.js) ────

def _lcg(seed):
    state = (seed & 0xFFFFFFFF) or 1

    def nxt():
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        return state / 4294967296.0
    return nxt


# ── (1) k-center-greedy ──────────────────────────────────────────────────────

def k_center(embs, budget, seeds, mat=None):
    n = len(embs)
    if n == 0 or budget == 0:
        return [], 0.0
    selected = []
    seeds = [s for s in (seeds or []) if isinstance(s, int) and 0 <= s < n]

    if mat is not None:
        min_d = _np.full(n, math.inf)

        def add(idx):
            selected.append(idx)
            diff = mat - mat[idx]
            d = _np.sqrt((diff * diff).sum(1))
            _np.minimum(min_d, d, out=min_d)

        for s in seeds:
            if s not in selected:
                add(s)
        if not selected:
            add(0)
        while len(selected) < budget:
            far = int(min_d.argmax())
            if min_d[far] < 0:
                break
            add(far)
        cov = round(float(min_d.max()), 6)
    else:
        min_d = [math.inf] * n

        def add(idx):
            selected.append(idx)
            for i in range(n):
                d = _l2(embs[i], embs[idx])
                if d < min_d[i]:
                    min_d[i] = d

        for s in seeds:
            if s not in selected:
                add(s)
        if not selected:
            add(0)
        while len(selected) < budget:
            far, far_d = -1, -1.0
            for i in range(n):
                if min_d[i] > far_d:
                    far_d, far = min_d[i], i
            if far < 0:
                break
            add(far)
        cov = round(max(min_d), 6) if min_d else 0.0
    return sorted(selected), cov


# ── (2) facility-location (lazy greedy submodular max) ───────────────────────

def facility_location(embs, budget, mat=None):
    n = len(embs)
    if n == 0 or budget == 0:
        return [], 0.0

    if mat is not None:
        sim = mat @ mat.T                            # cosine (rows unit-norm)
        best_sim = _np.zeros(n)
        selected = []
        in_sel = _np.zeros(n, dtype=bool)
        ub = _np.full(n, math.inf)
        while len(selected) < budget:
            order = _np.argsort(-ub)
            best_j, best_g = -1, -math.inf
            for j in order:
                j = int(j)
                if in_sel[j]:
                    continue
                if ub[j] <= best_g:
                    break
                g = float(_np.maximum(sim[:, j] - best_sim, 0.0).sum())
                ub[j] = g
                if g > best_g:
                    best_g, best_j = g, j
            if best_j < 0:
                break
            in_sel[best_j] = True
            selected.append(best_j)
            _np.maximum(best_sim, sim[:, best_j], out=best_sim)
    else:
        best_sim = [0.0] * n
        selected = []
        in_sel = [False] * n
        ub = [math.inf] * n

        def gain(j):
            g = 0.0
            for i in range(n):
                s = _cos(embs[i], embs[j])
                if s > best_sim[i]:
                    g += s - best_sim[i]
            return g

        while len(selected) < budget:
            order = sorted((j for j in range(n) if not in_sel[j]),
                           key=lambda j: ub[j], reverse=True)
            best_j, best_g = -1, -math.inf
            for j in order:
                if ub[j] <= best_g:
                    break
                g = gain(j)
                ub[j] = g
                if g > best_g:
                    best_g, best_j = g, j
            if best_j < 0:
                break
            in_sel[best_j] = True
            selected.append(best_j)
            for i in range(n):
                s = _cos(embs[i], embs[best_j])
                if s > best_sim[i]:
                    best_sim[i] = s
    return sorted(selected), None


# ── (3) BADGE — distance²-weighted k-means++ seeding ─────────────────────────

def badge(embs, weights, budget, seed, mat=None):
    n = len(embs)
    if n == 0 or budget == 0:
        return [], None
    if weights and len(weights) == n:
        w = [max(0.0, float(x) if _isnum(x) else 0.0) for x in weights]
    else:
        w = [1.0] * n
    rng = _lcg(seed)

    first = 0
    for i in range(1, n):
        if w[i] > w[first]:
            first = i
    selected = [first]
    chosen = [False] * n
    chosen[first] = True

    if mat is not None:
        diff = mat - mat[first]
        min_sq = (diff * diff).sum(1)
        while len(selected) < budget:
            p = _np.where(_np.array(chosen), 0.0, _np.array(w) * min_sq)
            total = float(p.sum())
            if total <= 0:
                nxt = next((i for i in range(n) if not chosen[i]), -1)
            else:
                cum = _np.cumsum(p)
                r = rng() * total
                nxt = int(_np.searchsorted(cum, r))
                while nxt < n and chosen[nxt]:
                    nxt += 1
                if nxt >= n:
                    nxt = next((i for i in range(n - 1, -1, -1) if not chosen[i]), -1)
            if nxt < 0:
                break
            chosen[nxt] = True
            selected.append(nxt)
            d = mat - mat[nxt]
            _np.minimum(min_sq, (d * d).sum(1), out=min_sq)
    else:
        min_sq = [_sq(embs[i], embs[first]) for i in range(n)]
        while len(selected) < budget:
            total = 0.0
            cum = [0.0] * n
            for i in range(n):
                p = 0.0 if chosen[i] else (w[i] * min_sq[i])
                total += p
                cum[i] = total
            if total <= 0:
                nxt = next((i for i in range(n) if not chosen[i]), -1)
            else:
                r = rng() * total
                nxt = -1
                for i in range(n):
                    if not chosen[i] and r <= cum[i]:
                        nxt = i
                        break
                if nxt < 0:
                    nxt = next((i for i in range(n - 1, -1, -1) if not chosen[i]), -1)
            if nxt < 0:
                break
            chosen[nxt] = True
            selected.append(nxt)
            for i in range(n):
                d = _sq(embs[i], embs[nxt])
                if d < min_sq[i]:
                    min_sq[i] = d
    return sorted(selected), None


# ── (4) repr-filter — score-descending diversity-gated greedy ────────────────

def repr_filter(pairs, embs, budget, tau=0.9):
    n = len(embs)
    if n == 0 or budget == 0:
        return [], 0.0
    sc = [_local_score(p) for p in pairs]
    order = sorted(range(n), key=lambda i: (-sc[i], i))
    selected = []
    for i in order:
        if len(selected) >= budget:
            break
        max_sim = -math.inf
        for j in selected:
            s = _cos(embs[i], embs[j])
            if s > max_sim:
                max_sim = s
        if not selected or max_sim < tau:
            selected.append(i)
    if len(selected) < budget:  # top-up so SELECT returns a full budget
        chosen = set(selected)
        for i in order:
            if len(selected) >= budget:
                break
            if i not in chosen:
                selected.append(i)
                chosen.add(i)
    return sorted(selected), None


def _isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


# ── IO ────────────────────────────────────────────────────────────────────────

def read_pairs(path):
    rows = []
    if path:
        if not os.path.isfile(path):
            return None
        fh = open(path, "r", encoding="utf-8")
        close = True
    else:
        fh = sys.stdin
        close = False
    try:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:  # deliberate: skip a single malformed line
                continue
    finally:
        if close:
            fh.close()
    return rows


def run(method, pairs, target_size, seed):
    """Core dispatch. Returns the result dict (always ok:true on this path)."""
    n = len(pairs)
    method = method if method in VALID_METHODS else "repr-filter"
    budget = _resolve_target(target_size, n)
    backend = "py-numpy" if _HAVE_NUMPY else "py-pure"

    if n == 0 or budget == 0:
        return {
            "ok": True, "version": VERSION, "method": method,
            "selected_indices": [], "coverage_radius": 0.0,
            "backend_used": backend + "-empty", "n_in": n, "n_selected": 0,
        }

    embs = [embed(_pair_text(p)) for p in pairs]
    mat = _np.asarray(embs, dtype="float64") if _HAVE_NUMPY else None

    if method == "facility-location":
        sel, cov = facility_location(embs, budget, mat)
    elif method == "badge":
        scores = [_local_score(p) for p in pairs]
        sel, cov = badge(embs, scores, budget, seed, mat)
    elif method == "repr-filter":
        sel, cov = repr_filter(pairs, embs, budget)
    else:  # k-center
        scores = [_local_score(p) for p in pairs]
        seed_idx = max(range(n), key=lambda i: scores[i])
        sel, cov = k_center(embs, budget, [seed_idx], mat)

    if cov is None:
        cov = _coverage_radius_np(mat, sel) if mat is not None else _coverage_radius_py(embs, sel)

    return {
        "ok": True,
        "version": VERSION,
        "method": method,
        "selected_indices": sel,
        "coverage_radius": float(cov),
        "backend_used": backend + "-" + method,
        "n_in": n,
        "n_selected": len(sel),
    }


# ── self-test ─────────────────────────────────────────────────────────────────

def _synthetic_pairs(k=30):
    """30 pairs in a handful of topic clusters so diversity selection has work."""
    topics = [
        ("reset my password", "Go to Settings then Security to reset your password."),
        ("track my order", "Open Orders and click the shipment to track your order."),
        ("refund a charge", "We can refund the charge; allow 5-7 business days."),
        ("cancel subscription", "You can cancel your subscription from the Billing page."),
        ("update payment card", "Add a new card under Billing then Payment methods."),
    ]
    pairs = []
    for i in range(k):
        base_in, base_out = topics[i % len(topics)]
        pairs.append({"input": f"{base_in} (case {i})",
                      "output": f"{base_out} Reference ticket {i}."})
    return pairs


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

    # embedding must match the JS contract: 256-d, unit-norm.
    e = embed("reset my password")
    check("embed-dim-256", len(e) == 256)
    check("embed-unit-norm", abs(math.sqrt(sum(x * x for x in e)) - 1.0) < 1e-9)

    pairs = _synthetic_pairs(30)
    for method in VALID_METHODS:
        r1 = run(method, pairs, 6, DEFAULT_SEED)
        r2 = run(method, pairs, 6, DEFAULT_SEED)
        check(f"{method}-ok", r1.get("ok") is True)
        check(f"{method}-size-6", len(r1["selected_indices"]) == 6)
        check(f"{method}-in-range",
              all(0 <= i < 30 for i in r1["selected_indices"]))
        check(f"{method}-unique",
              len(set(r1["selected_indices"])) == len(r1["selected_indices"]))
        check(f"{method}-deterministic",
              r1["selected_indices"] == r2["selected_indices"])
        check(f"{method}-cov-finite",
              isinstance(r1["coverage_radius"], float)
              and math.isfinite(r1["coverage_radius"]))

    # fraction budget: 0.2 of 30 = 6
    rf = run("k-center", pairs, 0.2, DEFAULT_SEED)
    check("fraction-budget-6", len(rf["selected_indices"]) == 6)

    # empty input degrades cleanly, never crashes
    re_ = run("badge", [], 6, DEFAULT_SEED)
    check("empty-ok", re_["ok"] is True and re_["selected_indices"] == [])

    log(f"\nself-test: {passed} passed, {failed} failed "
        f"(backend={'py-numpy' if _HAVE_NUMPY else 'py-pure'})")
    return EXIT_OK if failed == 0 else 1


# ── main ──────────────────────────────────────────────────────────────────────

def parse_args(argv):
    p = argparse.ArgumentParser(description="KOLM SELECT subset worker (W921).")
    p.add_argument("--method", default="repr-filter", choices=list(VALID_METHODS))
    p.add_argument("--pairs", default=None, help="Input JSONL; omit to read stdin.")
    p.add_argument("--out", default=None, help="Also write the JSON result here.")
    p.add_argument("--target-size", type=float, default=0,
                   help=">1 = count, 0<x<=1 = fraction of pool, <=0 = all.")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--self-test", action="store_true",
                   help="Run an in-process check on a synthetic corpus.")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if args.self_test:
        return self_test()

    pairs = read_pairs(args.pairs)
    if pairs is None:
        print(json.dumps({"ok": False, "error": "input_not_found", "pairs": args.pairs}))
        return EXIT_OK  # data error surfaced cleanly; JS degrades to repr-filter

    try:
        result = run(args.method, pairs, args.target_size, args.seed)
    except Exception as e:  # deliberate: NEVER crash — JS falls back on bad summary
        log(f"[select] unexpected error: {e}")
        print(json.dumps({"ok": False, "error": "select_failed", "detail": str(e)}))
        return EXIT_OK

    if args.out:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
        except Exception as e:  # deliberate: --out write is best-effort
            log(f"[select] WARN: could not write --out {args.out}: {e}")

    log(f"[select] {result['n_selected']}/{result['n_in']} via "
        f"{result['backend_used']} (cov_radius={result['coverage_radius']})")
    print(json.dumps(result, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
