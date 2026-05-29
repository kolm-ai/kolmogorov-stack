#!/usr/bin/env python3
"""Confident-Learning label-error backend for src/data-label-errors.js.

The JS module (detectLabelErrors) already ships a complete, dependency-free
Confident-Learning path: it embeds each pair's OUTPUT with the 256-d hash-bag
embedder, mean-pools per-cluster centroids, softmaxes output->cluster cosine
into p̂(output in j), derives a per-class self-confidence threshold t_j, and
counts confident OFF-DIAGONAL pairs (the answer looks like a different topic
than its question's cluster) as label-error candidates.

This Python worker is an OPTIONAL acceleration / second-opinion backend for the
SAME idea, following Northcutt et al. (Confident Learning, JAIR 2021):

  * Each pair carries a cluster_id (--cluster-field) — this is the GIVEN, noisy
    label (the "class" the curator believes the pair belongs to).
  * We need a predicted-class probability p̂(y=j | x). With no model probs in
    the JSONL, we derive a CHEAP class proxy from text features: a hashed word +
    char-trigram bag of the OUTPUT, mean-pooled into a unit centroid per cluster,
    then cosine(output, centroid_j) softmaxed over clusters. (Pure stdlib; numpy
    is used only to vectorize the same arithmetic when present.)
  * Confident joint Q[i][j]: a pair with given-class i is counted into predicted
    class j = argmax_j' { p̂_j' : p̂_j' >= t_j' }, where t_j' is the per-class
    self-confidence threshold (mean p̂_j' over pairs whose given class is j').
    Pairs landing OFF the diagonal (j != i) are the likely-mislabeled set.
  * off_diagonal_rate = off-diagonal mass / total counted mass (CL noise rate).

If `cleanlab` is installed we hand the same proxy probability matrix + given
labels to cleanlab.filter.find_label_issues for its battle-tested confident
joint; otherwise the pure-python implementation above runs. EITHER WAY the
script succeeds — cleanlab is acceleration, not a requirement, so its absence is
NOT reported as dep_missing. dep_missing is reserved for a truly broken core
(it should never trigger on a stdlib-only box; it exists so the contract the
spec describes is honored if some future core dep is added).

Interface (matches the spec):
  argv: --pairs <jsonl> | stdin, --out <json>, --cluster-field cluster_id,
        --action {review|filter}, --seed <int>, --self-test
  stdout JSON: {ok:true, flagged_indices:int[], off_diagonal_rate:float,
                scores:float[], ...}

Determinism: no wall-clock / RNG in the scoring path; --seed (default
0x6b6f6c6d = 1801677709) seeds only the synthetic self-test corpus and the
hash-bag offset, so identical input + seed -> identical output. Exit 0 on the
happy path and on graceful degradation; argparse uses 2 for bad args.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys

# Windows cp950/cp1252 emoji guard — outputs in these pairs routinely contain
# emoji / CJK. Mirror the distill workers' shim but degrade silently if the
# shared module isn't on the path (this worker lives under workers/data/).
try:  # pragma: no cover - environment dependent
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "distill", "scripts"))
    from _console import setup_utf8 as _setup_utf8  # noqa: F401
    _setup_utf8()
except Exception:  # pragma: no cover - shim is best-effort
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

DEFAULT_SEED = 0x6B6F6C6D  # 1801677709 — "kolm" as a little-endian-ish constant
FEATURE_DIM = 2048
SOFTMAX_BETA = 8.0  # inverse temperature; matches the JS _softmax default
MARGIN = 0.05       # relaxation on the per-class self-confidence threshold (CL)

EXIT_OK = 0

_WORD = re.compile(r"[a-z0-9]+")


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# --- row IO (field fallbacks mirror data-label-errors.js / dedup_pairs.py) ---

def _pair_input(r):
    if not isinstance(r, dict):
        return ""
    return r.get("input") or r.get("prompt") or ""


def _pair_output(r):
    if not isinstance(r, dict):
        return ""
    return r.get("output") or r.get("teacher_output") or r.get("response") or ""


def load_rows(path):
    """Read JSONL from a path or '-'/None (stdin). Skips blank/malformed lines."""
    if path and path != "-":
        fh = open(path, "r", encoding="utf-8")
        close = True
    else:
        fh = sys.stdin
        close = False
    rows = []
    try:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:  # deliberate: cleanup — skip one bad line
                continue
    finally:
        if close:
            fh.close()
    return rows


# --- cheap text-feature class proxy ------------------------------------------

def _stable_hash(s, seed):
    """Deterministic, seed-mixed hash in [0, FEATURE_DIM). Python's builtin
    hash() is salted per-process (PYTHONHASHSEED) so it cannot be used for a
    reproducible feature index — use md5 of (seed, token)."""
    h = hashlib.md5(f"{seed}:{s}".encode("utf-8")).digest()
    return int.from_bytes(h[:4], "little") % FEATURE_DIM


def ngram_features(text, seed):
    """Hashed word + char-trigram bag of `text`, unit-normalized sparse dict.
    The exact analog of the JS hash-bag embedder, but sparse for stdlib speed."""
    text = (text or "").lower()
    feats = {}
    for w in _WORD.findall(text):
        if len(w) < 2:
            continue
        h = _stable_hash("w:" + w, seed)
        feats[h] = feats.get(h, 0.0) + 1.0
    padded = f" {text} "
    for i in range(len(padded) - 2):
        h = _stable_hash("c:" + padded[i:i + 3], seed)
        feats[h] = feats.get(h, 0.0) + 1.0
    norm = math.sqrt(sum(v * v for v in feats.values())) or 1.0
    return {k: v / norm for k, v in feats.items()}


def cluster_index_map(rows, cluster_field):
    """Dense index per distinct cluster_id; missing ids share one bucket."""
    mapping = {}
    idx_of = []
    for r in rows:
        cid = r.get(cluster_field) if isinstance(r, dict) else None
        cid = "__nocluster__" if cid in (None, "") else str(cid)
        if cid not in mapping:
            mapping[cid] = len(mapping)
        idx_of.append(mapping[cid])
    return idx_of, len(mapping), list(mapping.keys())


def centroids_from_clusters(feats, idx_of, k):
    """Mean-pool member OUTPUT features into a unit centroid per cluster."""
    centroids = [dict() for _ in range(k)]
    counts = [0] * k
    for i, f in enumerate(feats):
        c = idx_of[i]
        for key, v in f.items():
            centroids[c][key] = centroids[c].get(key, 0.0) + v
        counts[c] += 1
    for c in range(k):
        if counts[c] == 0:
            continue
        for key in centroids[c]:
            centroids[c][key] /= counts[c]
        norm = math.sqrt(sum(v * v for v in centroids[c].values())) or 1.0
        for key in centroids[c]:
            centroids[c][key] /= norm
    return centroids


def _sparse_cos(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


def _softmax(sims, beta=SOFTMAX_BETA):
    if not sims:
        return []
    m = max(sims)
    exps = [math.exp(beta * (s - m)) for s in sims]
    total = sum(exps)
    if not (total > 0):
        n = len(sims)
        return [1.0 / n] * n
    return [e / total for e in exps]


def proxy_probs(feats, centroids):
    """N x K row-stochastic p̂(output in cluster j)."""
    out = []
    for f in feats:
        sims = [_sparse_cos(f, c) for c in centroids]
        out.append(_softmax(sims))
    return out


# --- confident joint (pure-python Confident Learning) ------------------------

def confident_joint(given, probs, k, margin=MARGIN):
    """Returns (flagged_indices, off_diagonal_rate, per_pair_scores, joint).

    per_pair_scores[i] is the model's confidence that pair i actually belongs to
    its PREDICTED (argmax-over-threshold) class — high score on an off-diagonal
    pair = high confidence the GIVEN cluster label is wrong."""
    n = len(given)
    # Per-class self-confidence threshold t_j = mean p̂_j over pairs given j.
    sum_self = [0.0] * k
    cnt_self = [0] * k
    for i in range(n):
        j = given[i]
        pj = probs[i][j] if j < len(probs[i]) else 0.0
        sum_self[j] += pj
        cnt_self[j] += 1
    populated = [sum_self[j] / cnt_self[j] for j in range(k) if cnt_self[j] > 0]
    mean_t = sum(populated) / len(populated) if populated else 1.0
    thresholds = [
        (sum_self[j] / cnt_self[j] if cnt_self[j] > 0 else mean_t) * (1.0 - margin)
        for j in range(k)
    ]

    joint = [[0] * k for _ in range(k)]
    flagged = []
    scores = [0.0] * n
    for i in range(n):
        row = probs[i]
        best, best_p = -1, -1.0
        for j in range(k):
            pj = row[j] if j < len(row) else 0.0
            if pj >= thresholds[j] and pj > best_p:
                best_p, best = pj, j
        if best < 0:
            scores[i] = 0.0
            continue
        scores[i] = round(best_p, 6)
        gi = given[i]
        joint[gi][best] += 1
        if best != gi:
            flagged.append(i)

    total = sum(joint[i][j] for i in range(k) for j in range(k))
    off = sum(joint[i][j] for i in range(k) for j in range(k) if i != j)
    rate = (off / total) if total > 0 else 0.0
    return flagged, round(rate, 6), scores, joint


def confident_joint_cleanlab(given, probs, k):
    """Optional acceleration: hand the proxy prob matrix + given labels to
    cleanlab's confident-joint. Returns the SAME tuple shape as confident_joint,
    or None if cleanlab is unavailable (caller falls back to pure-python)."""
    try:
        import numpy as np
        from cleanlab.filter import find_label_issues
        from cleanlab.count import compute_confident_joint
    except Exception:
        return None
    labels = np.asarray(given, dtype=np.int64)
    pred = np.zeros((len(given), k), dtype=np.float64)
    for i, row in enumerate(probs):
        for j in range(min(k, len(row))):
            pred[i, j] = row[j]
    # Renormalize defensively; cleanlab expects rows to sum to ~1.
    rs = pred.sum(axis=1, keepdims=True)
    rs[rs == 0] = 1.0
    pred = pred / rs
    issues = find_label_issues(labels, pred, return_indices_ranked_by="self_confidence")
    flagged = sorted(int(i) for i in issues)
    cj = compute_confident_joint(labels, pred)
    total = float(cj.sum())
    off = float(cj.sum() - np.trace(cj))
    rate = round(off / total, 6) if total > 0 else 0.0
    scores = [round(float(pred[i].max()), 6) for i in range(len(given))]
    return flagged, rate, scores, cj.tolist()


def score_corpus(rows, cluster_field, seed):
    """End-to-end: features -> proxy probs -> confident joint. Returns a dict
    with the spec's stdout shape plus diagnostics. Prefers cleanlab when present."""
    idx_of, k, cluster_ids = cluster_index_map(rows, cluster_field)
    feats = [ngram_features(_pair_output(r), seed) for r in rows]

    if k <= 1:
        # Single class -> no off-diagonal possible. Report plainly (matches JS).
        return {
            "flagged_indices": [],
            "off_diagonal_rate": 0.0,
            "scores": [0.0] * len(rows),
            "backend": "cl-pure-single-cluster",
            "n_clusters": k,
            "note": "single_cluster:no_off_diagonal_possible",
        }

    centroids = centroids_from_clusters(feats, idx_of, k)
    probs = proxy_probs(feats, centroids)

    backend = "cl-pure"
    cl = confident_joint_cleanlab(idx_of, probs, k)
    if cl is not None:
        flagged, rate, scores, _joint = cl
        backend = "cl-cleanlab"
    else:
        flagged, rate, scores, _joint = confident_joint(idx_of, probs, k)

    return {
        "flagged_indices": flagged,
        "off_diagonal_rate": rate,
        "scores": scores,
        "backend": backend,
        "n_clusters": k,
    }


# --- synthetic self-test -----------------------------------------------------

def _build_self_test_corpus(seed):
    """27 clean rows across 3 clusters + 3 deliberately mislabeled rows.

    Each cluster has its own vocabulary so a topic-aware proxy cleanly separates
    them. A mislabeled row keeps a foreign cluster_id while its OUTPUT text
    belongs to a DIFFERENT topic — exactly the failure Confident Learning flags.
    Deterministic: word selection is indexed, never random; `seed` only feeds the
    feature hash so the test exercises the same path as production."""
    topics = {
        "billing": ["invoice charge refund payment subscription receipt billing card",
                    "your invoice was charged refund issued to the card on file",
                    "the subscription payment receipt shows the billing amount due"],
        "shipping": ["package tracking delivery courier warehouse shipment dispatch parcel",
                     "your package shipped the tracking number for delivery is ready",
                     "the courier dispatched the parcel from the warehouse for delivery"],
        "auth": ["login password token session credential signin oauth authenticate",
                 "reset your password the login token for this session expired",
                 "authenticate with oauth the credential for signin was rotated"],
    }
    names = list(topics.keys())
    rows = []
    # 9 clean rows per cluster (27 total). Output text is in-topic.
    for name in names:
        sentences = topics[name]
        for i in range(9):
            base = sentences[i % len(sentences)]
            rows.append({
                "input": f"{name} question {i}",
                "output": f"{base} detail variant {i}",
                "cluster_id": name,
            })
    clean_n = len(rows)  # 27
    # 3 mislabeled rows: cluster_id says one topic, OUTPUT is a different topic.
    mislabels = [
        ("billing", "shipping"),   # labeled billing, answer is shipping
        ("shipping", "auth"),      # labeled shipping, answer is auth
        ("auth", "billing"),       # labeled auth, answer is billing
    ]
    injected = []
    for k, (given_label, real_topic) in enumerate(mislabels):
        rows.append({
            "input": f"{given_label} question mis{k}",
            "output": f"{topics[real_topic][0]} strongly {real_topic} content {k}",
            "cluster_id": given_label,
        })
        injected.append(clean_n + k)
    return rows, injected


def self_test(seed=DEFAULT_SEED):
    failures = []
    rows, injected = _build_self_test_corpus(seed)

    res = score_corpus(rows, "cluster_id", seed)
    flagged = set(res["flagged_indices"])

    # 1. >= 2 of the 3 injected mislabels are flagged (the spec's acceptance bar).
    caught = [i for i in injected if i in flagged]
    if len(caught) < 2:
        failures.append(
            f"caught {len(caught)}/3 injected mislabels {injected}; "
            f"flagged={sorted(flagged)}"
        )

    # 2. off_diagonal_rate is a sane fraction and non-zero (errors exist).
    odr = res["off_diagonal_rate"]
    if not (0.0 <= odr <= 1.0):
        failures.append(f"off_diagonal_rate {odr} not in [0,1]")
    if odr <= 0.0:
        failures.append("off_diagonal_rate is zero but 3 mislabels were injected")

    # 3. scores has one entry per row, each a finite [0,1] probability.
    if len(res["scores"]) != len(rows):
        failures.append(f"scores len {len(res['scores'])} != rows {len(rows)}")
    if any(not (0.0 <= s <= 1.0) for s in res["scores"]):
        failures.append("a score fell outside [0,1]")

    # 4. Determinism: rebuilding the corpus + rescoring under the same seed
    #    yields an identical flagged set + rate.
    rows2, _ = _build_self_test_corpus(seed)
    res2 = score_corpus(rows2, "cluster_id", seed)
    if res2["flagged_indices"] != res["flagged_indices"] or res2["off_diagonal_rate"] != odr:
        failures.append("non-deterministic: re-run produced a different result")

    # 5. A foreign-topic FALSE flag rate sanity check: clean rows should mostly
    #    NOT be flagged (precision floor — at most a third of clean rows flagged).
    clean_flagged = [i for i in flagged if i < 27]
    if len(clean_flagged) > 9:
        failures.append(f"too many clean rows flagged ({len(clean_flagged)}/27)")

    passed = 5 - len(failures)
    for f in failures:
        log("  FAIL: " + f)
    log(f"[score_errors --self-test] PASS {passed}/5  "
        f"(caught {len(caught)}/3 mislabels, off_diag_rate={odr}, backend={res['backend']})")
    print(json.dumps({
        "ok": len(failures) == 0,
        "self_test": True,
        "passed": passed,
        "total": 5,
        "caught_mislabels": len(caught),
        "injected": injected,
        "flagged_indices": sorted(flagged),
        "off_diagonal_rate": odr,
        "backend": res["backend"],
        "failures": failures,
    }, ensure_ascii=False))
    return EXIT_OK if not failures else 1


# --- main --------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Confident-Learning label-error backend for data-label-errors.js")
    p.add_argument("--pairs", default=None,
                   help="Input JSONL of pairs; omit or '-' to read stdin.")
    p.add_argument("--out", default=None, help="Also write the JSON result here.")
    p.add_argument("--cluster-field", default="cluster_id",
                   help="Row field holding the given (noisy) cluster label.")
    p.add_argument("--action", default="review", choices=["review", "filter"],
                   help="Advisory: 'filter' marks flags as drop-candidates; the "
                        "JS caller acts on them. This worker never drops rows.")
    p.add_argument("--seed", type=lambda s: int(s, 0), default=DEFAULT_SEED,
                   help="Deterministic seed (default 0x6b6f6c6d=1801677709).")
    p.add_argument("--self-test", action="store_true",
                   help="Run the in-process synthetic check and exit.")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    if args.self_test:
        return self_test(args.seed)

    rows = load_rows(args.pairs)
    if not rows:
        # Empty corpus is not an error — emit a well-formed, empty envelope.
        result = {
            "ok": True,
            "flagged_indices": [],
            "off_diagonal_rate": 0.0,
            "scores": [],
            "action": args.action,
            "n": 0,
            "backend": "empty",
            "note": "empty_corpus",
        }
        _emit(result, args.out)
        return EXIT_OK

    res = score_corpus(rows, args.cluster_field, args.seed)
    result = {
        "ok": True,
        "flagged_indices": res["flagged_indices"],
        "off_diagonal_rate": res["off_diagonal_rate"],
        "scores": res["scores"],
        "action": args.action,
        "n": len(rows),
        "n_clusters": res.get("n_clusters"),
        "backend": res["backend"],
    }
    if "note" in res:
        result["note"] = res["note"]
    if args.action == "filter":
        # Advisory: surface which indices the caller would drop. Still never
        # mutates input; the JS side owns the filter decision.
        result["drop_candidates"] = res["flagged_indices"]

    log(f"[score_errors] {len(res['flagged_indices'])}/{len(rows)} flagged "
        f"(off_diag={res['off_diagonal_rate']}, backend={res['backend']})")
    _emit(result, args.out)
    return EXIT_OK


def _emit(result, out_path):
    if out_path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        except Exception as e:  # deliberate: cleanup — file write is best-effort
            log(f"[score_errors] WARN: could not write {out_path}: {e}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
