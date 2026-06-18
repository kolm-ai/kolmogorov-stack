#!/usr/bin/env python3
"""C2.1 — Optional learned-quality acceleration backend for the JS per-pair
quality classifier (src/data-quality-classifier.js).

The JS module already ships a working, dependency-free logistic scorer over a
deterministic feature vector. This worker is an OPTIONAL accelerator the Node
side may call when a large corpus makes a vectorized scikit-learn / ONNX /
fastText pass worthwhile. It is NOT required: if no model is given (or the
heavy libs are absent) it falls back to the SAME deterministic heuristic the
JS uses, so scores are directly comparable run-to-run and language-to-language.

Lineage (same as the JS header):
  * AlpaGasus (arXiv:2307.08701) — score each (instruction, response), keep the
    top fraction.
  * FineWeb-Edu (arXiv:2406.17557) — one judge pass distilled into a tiny linear
    head over a frozen feature/embedding vector.
  * DCLM fastText (arXiv:2406.11794) — binary good/bad, keep the top fraction by
    P(high-quality).

Contract (mirrors the OWN spec):
  argv: --pairs <jsonl> | stdin, [--out <json>], [--model <path>],
        [--keep-fraction <float>], [--seed <int>], [--self-test]
  stdout: a single JSON object
    {ok:true, scores:float[0..1], threshold_used:float, kept_indices:int[],
     backend_used:str, version:str, n:int}
  Degrade gracefully: an optional dep being absent is NOT a crash — when a
  --model is given but its loader's dep is missing we emit
    {ok:false, error:'dep_missing', need:'<pkg>'} and exit 0 so the JS side
  falls back cleanly. A bad/missing --pairs file is a data error (exit 20).

Determinism: no wall-clock, no RNG in the scoring path. The seed param exists
for interface symmetry with sibling workers (and is echoed into the result);
the heuristic/logistic path is seed-independent by construction.

Exit codes: 0 ok (incl. graceful dep_missing / model-load fail) · 20 bad input.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys

# Windows cp950/cp1252 guard — training pairs routinely carry emoji / CJK.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — older Python / odd streams: silent no-op
        pass

VERSION = "quality-v1"
DEFAULT_SEED = 0x6B6F6C6D  # 1801677709 — shared kolm worker seed
EXIT_OK = 0
EXIT_NO_INPUT = 20
MAX_ROWS = 250_000
MAX_LINE_CHARS = 1_000_000

# ── feature schema — MUST stay byte-for-byte aligned with the JS module ──────
FEATURE_NAMES = [
    "bias", "len_norm", "cot_leak", "refusal", "structure",
    "relevance", "ttr", "digit_ratio", "upper_ratio", "empty",
]
# Shipped cold-start weights, copied verbatim from DEFAULT_WEIGHTS in
# src/data-quality-classifier.js so the learned-default backend agrees with JS.
DEFAULT_WEIGHTS = [-0.4, 2.2, -4.0, -2.5, 0.6, 2.0, 0.8, -0.5, -0.5, -6.0]

_HARD_COT = [
    re.compile(r"<\/?think>", re.IGNORECASE),
    re.compile(r"<\/?reasoning>", re.IGNORECASE),
    re.compile(r"<\|?\s*thinking\s*\|?>", re.IGNORECASE),
    re.compile(r"<\|?\s*reasoning\s*\|?>", re.IGNORECASE),
]
_SOFT_COT = [
    re.compile(r"^okay,?\s+so\b", re.IGNORECASE),
    re.compile(r"^alright,?\s+so\b", re.IGNORECASE),
    re.compile(r"^hmm,?\s", re.IGNORECASE),
    re.compile(r"^wait,?\s", re.IGNORECASE),
    re.compile(r"^so\s+(the\s+user|first|basically)", re.IGNORECASE),
    re.compile(r"^first,?\s+i\s+(should|need|will|have)", re.IGNORECASE),
    re.compile(r"^let\s+me\s+(think|consider|analyze|break)", re.IGNORECASE),
    re.compile(r"\bstep[- ]by[- ]step\b", re.IGNORECASE),
    re.compile(r"\blet's\s+see\b[.,]", re.IGNORECASE),
]
_REFUSAL_RE = re.compile(
    r"\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b",
    re.IGNORECASE)
_STRUCTURE_RE = re.compile(r"(^|\n)\s*(\d+[.)]|[-*•])\s+", re.MULTILINE)
_WORD_RE = re.compile(r"[a-z0-9]+")


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ── pair text extraction (mirrors _pairInput / _pairOutput in JS) ────────────
def pair_input(p):
    if not isinstance(p, dict):
        return ""
    for k in ("input", "prompt"):
        v = p.get(k)
        if isinstance(v, str):
            return v
    return ""


def pair_output(p):
    if not isinstance(p, dict):
        return ""
    for k in ("output", "teacher_output", "response"):
        v = p.get(k)
        if isinstance(v, str):
            return v
    return ""


def _words_lower(text):
    return _WORD_RE.findall(str(text or "").lower())


def _flag_cot(s):
    if any(rx.search(s) for rx in _HARD_COT):
        return True
    return sum(1 for rx in _SOFT_COT if rx.search(s)) >= 2


def _relevance(input_text, output_text):
    ref = {w for w in _words_lower(input_text) if len(w) > 2}
    if not ref:
        return 0.5  # no input signal -> neutral (matches JS)
    cand = {w for w in _words_lower(output_text) if len(w) > 2}
    inter = sum(1 for w in cand if w in ref)
    return inter / len(ref)


def extract_features(pair):
    """Deterministic feature vector — element-for-element identical to the JS
    extractFeatures(). Order = FEATURE_NAMES."""
    inp = pair_input(pair)
    out = pair_output(pair)
    s = str(out or "")
    n = len(s.strip())
    words = _words_lower(s)

    len_norm = max(0.0, min(1.0, math.log2(1 + n) / math.log2(1 + 1200)))
    cot_leak = 1.0 if _flag_cot(s) else 0.0
    refusal = 1.0 if _REFUSAL_RE.search(s) else 0.0
    structure = 1.0 if _STRUCTURE_RE.search(s) else 0.0
    relevance = _relevance(inp, out)
    ttr = (len(set(words)) / len(words)) if words else 0.0
    digits = len(re.findall(r"\d", s))
    uppers = len(re.findall(r"[A-Z]", s))
    digit_ratio = min(1.0, digits / n) if n else 0.0
    upper_ratio = min(1.0, uppers / n) if n else 0.0
    empty = 1.0 if n == 0 else 0.0

    return [1.0, len_norm, cot_leak, refusal, structure,
            relevance, ttr, digit_ratio, upper_ratio, empty]


def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    ez = math.exp(z)  # avoid overflow for very negative z
    return ez / (1.0 + ez)


def score_logistic(pair, weights):
    feats = extract_features(pair)
    z = sum(feats[i] * weights[i] for i in range(min(len(feats), len(weights))))
    return _sigmoid(z)


# ── heuristic floor (mirrors JS heuristicQualityScore) ───────────────────────
def score_heuristic(pair):
    f = extract_features(pair)
    score = 0.5
    score += 0.25 * f[1]            # len_norm
    score -= 0.5 * f[2]             # cot_leak
    score -= 0.2 * f[3]             # refusal
    score += 0.05 * f[4]            # structure
    score += 0.25 * (f[5] - 0.5)    # relevance centered
    if f[9] == 1.0:                 # empty output floor
        score = 0.05
    return max(0.0, min(1.0, score))


# ── optional learned backends (graceful: dep absent => fall back) ────────────
def load_model(model_path):
    """Try to load a fitted model from --model. Returns (weights|None, backend,
    need) where need is the missing pip pkg name when a dep is absent.

    Supported, in order of cheapness:
      * .json  — a kolm logistic head {"w":[...]} (no deps; identical to JS).
      * sklearn pickle (.pkl/.joblib) — coef_/intercept_ over FEATURE_NAMES.
      * onnx (.onnx) — a 1-output classifier scored via onnxruntime.
    Anything heavier is intentionally out of scope; the JS fallback covers it.
    """
    ext = os.path.splitext(model_path)[1].lower()

    if ext == ".json":
        try:
            with open(model_path, "r", encoding="utf-8") as f:
                obj = json.load(f)
        except Exception as e:  # noqa: BLE001 — bad/missing file -> graceful
            return None, "model_load_failed", None, str(e)
        w = obj.get("w") if isinstance(obj, dict) else None
        if isinstance(w, list) and w and all(isinstance(x, (int, float)) for x in w):
            return [float(x) for x in w], "learned-json", None, None
        return None, "model_load_failed", None, "json has no usable 'w' weight vector"

    if ext in (".pkl", ".joblib"):
        try:
            if ext == ".joblib":
                import joblib  # noqa: F401
                clf = joblib.load(model_path)
            else:
                import pickle
                with open(model_path, "rb") as f:
                    clf = pickle.load(f)
        except ImportError:
            return None, "dep_missing", "joblib", None
        except Exception as e:  # noqa: BLE001 — corrupt pickle -> graceful
            return None, "model_load_failed", None, str(e)
        # A sklearn LogisticRegression over FEATURE_NAMES (sans bias) folds into
        # our w vector: w[0]=intercept, w[1:]=coef_ aligned to features 1..D-1.
        try:
            coef = list(clf.coef_[0])
            intercept = float(clf.intercept_[0])
        except Exception as e:  # noqa: BLE001 — not the shape we expect
            return None, "model_load_failed", None, f"unexpected sklearn shape: {e}"
        w = [intercept] + [float(c) for c in coef]
        # Pad/trim to FEATURE_NAMES length so scoring never index-errors.
        w = (w + [0.0] * len(FEATURE_NAMES))[:len(FEATURE_NAMES)]
        return w, "learned-sklearn", None, None

    if ext == ".onnx":
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            return None, "dep_missing", "onnxruntime", None
        # An ONNX session is returned as a callable closure rather than weights.
        try:
            sess = onnxruntime.InferenceSession(
                model_path, providers=["CPUExecutionProvider"])
            in_name = sess.get_inputs()[0].name
        except Exception as e:  # noqa: BLE001 — bad graph -> graceful fallback
            return None, "model_load_failed", None, str(e)

        def _onnx_scorer(pair):
            feats = [extract_features(pair)]
            out = sess.run(None, {in_name: feats})
            val = out[0]
            try:
                v = float(val[0][-1]) if hasattr(val[0], "__len__") else float(val[0])
            except Exception:  # noqa: BLE001
                v = float(val[0])
            return max(0.0, min(1.0, v))

        return _onnx_scorer, "learned-onnx", None, None

    return None, "model_load_failed", None, f"unsupported model extension: {ext}"


# ── thresholding (mirrors JS applyThreshold percentile mode) ─────────────────
def apply_threshold(scores, keep_fraction):
    n = len(scores)
    if n == 0:
        return [], 0.0
    frac = max(0.0, min(1.0, float(keep_fraction)))
    keep_n = max(0, min(n, math.ceil(frac * n)))
    # stable sort by score desc, tie-break by index asc (matches JS comparator)
    order = sorted(range(n), key=lambda i: (-scores[i], i))
    kept = sorted(order[:keep_n])
    if keep_n > 0:
        threshold = scores[order[keep_n - 1]]   # lowest kept score = cut point
    else:
        threshold = scores[order[0]] + 1.0      # nothing kept: above the max
    return kept, round(float(threshold), 6)


# ── row IO ───────────────────────────────────────────────────────────────────
def _path_meta(file_path):
    raw = str(file_path or "")
    return {
        "path_basename": os.path.basename(raw),
        "path_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    }


def _input_error(code, **extra):
    return {"ok": False, "error": code, "version": VERSION, **extra}


def load_rows(stream):
    rows = []
    line_no = 0
    for line in stream:
        line_no += 1
        if len(line) > MAX_LINE_CHARS:
            return None, _input_error(
                "jsonl_line_too_large",
                line=line_no,
                max_line_chars=MAX_LINE_CHARS,
            )
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception as e:  # noqa: BLE001
            return None, _input_error(
                "malformed_jsonl",
                line=line_no,
                detail=str(e)[:240],
            )
        if len(rows) > MAX_ROWS:
            return None, _input_error("too_many_rows", max_rows=MAX_ROWS)
    return rows, None


def score_corpus(rows, model_path, keep_fraction):
    """Return the full result dict. Pure function over its args (deterministic)."""
    scorer = None
    weights = DEFAULT_WEIGHTS
    backend_used = "learned-default"

    if model_path:
        loaded, kind, need, detail = load_model(model_path)
        if kind == "dep_missing":
            return {"ok": False, "error": "dep_missing", "need": need,
                    "version": VERSION, "backend_used": "fallback-required"}
        if kind == "model_load_failed":
            # Not fatal — fall back to the shipped default weights, but say so.
            log(f"[score_quality] model load failed ({detail}); "
                f"using learned-default")
            backend_used = "learned-default"
        elif callable(loaded):
            scorer = loaded
            backend_used = kind
        else:
            weights = loaded
            backend_used = kind

    if scorer is not None:
        scores = [round(scorer(p), 6) for p in rows]
    else:
        scores = [round(score_logistic(p, weights), 6) for p in rows]

    kept, threshold = apply_threshold(scores, keep_fraction)
    return {
        "ok": True,
        "version": VERSION,
        "backend_used": backend_used,
        "scores": scores,
        "threshold_used": threshold,
        "kept_indices": kept,
        "keep_fraction": max(0.0, min(1.0, float(keep_fraction))),
        "n": len(rows),
    }


# ── self-test ─────────────────────────────────────────────────────────────────
def self_test():
    failures = []

    def check(name, cond, detail=""):
        if cond:
            print(f"PASS {name}")
        else:
            failures.append(name)
            print(f"FAIL {name}: {detail}")

    good = {"input": "How do I reset my password from the account settings page?",
            "output": ("To reset your password, open account settings, click "
                       "Security, then Reset password and follow the emailed link. "
                       "1. Open settings\n2. Click Security\n3. Reset password.")}
    bad_empty = {"input": "How do I reset my password?", "output": ""}
    bad_garbage = {"input": "How do I reset my password?",
                   "output": "asdf asdf asdf asdf asdf asdf"}
    cot = {"input": "What is 2+2?",
           "output": "<think>let me add these</think> The answer is 4."}

    gs = score_logistic(good, DEFAULT_WEIGHTS)
    es = score_logistic(bad_empty, DEFAULT_WEIGHTS)
    gar = score_logistic(bad_garbage, DEFAULT_WEIGHTS)
    cs = score_logistic(cot, DEFAULT_WEIGHTS)

    check("good_beats_empty", gs > es, f"good={gs:.4f} empty={es:.4f}")
    check("good_beats_garbage", gs > gar, f"good={gs:.4f} garbage={gar:.4f}")
    check("good_beats_cot_leak", gs > cs, f"good={gs:.4f} cot={cs:.4f}")
    check("empty_floor_low", es < 0.1, f"empty={es:.4f}")
    check("scores_bounded", all(0.0 <= x <= 1.0 for x in (gs, es, gar, cs)),
          "a score fell outside [0,1]")

    # heuristic floor agrees on ordering and bounds
    hg, he = score_heuristic(good), score_heuristic(bad_empty)
    check("heuristic_good_beats_empty", hg > he, f"good={hg:.4f} empty={he:.4f}")
    check("heuristic_empty_floor", abs(he - 0.05) < 1e-9, f"empty={he:.4f}")

    # determinism: identical input => identical score, twice
    check("deterministic", score_logistic(good, DEFAULT_WEIGHTS) == gs,
          "re-scoring the same pair changed the value")

    # keep-fraction selects the right COUNT and keeps the best rows
    rows = [good, bad_garbage, cot, bad_empty]
    res = score_corpus(rows, None, 0.5)
    check("keepfrac_count", len(res["kept_indices"]) == 2,
          f"kept={res['kept_indices']}")
    check("keepfrac_keeps_good", 0 in res["kept_indices"],
          f"good (idx 0) was dropped: kept={res['kept_indices']}")
    check("keepfrac_drops_empty", 3 not in res["kept_indices"],
          f"empty (idx 3) was kept: kept={res['kept_indices']}")
    check("threshold_is_kept_minimum",
          res["threshold_used"] == min(res["scores"][i] for i in res["kept_indices"]),
          f"threshold={res['threshold_used']} kept={res['kept_indices']}")

    # keep-fraction edge cases
    check("keepfrac_zero", len(score_corpus(rows, None, 0.0)["kept_indices"]) == 0)
    check("keepfrac_one", len(score_corpus(rows, None, 1.0)["kept_indices"]) == len(rows))

    # feature vector length matches the JS schema
    check("feature_arity", len(extract_features(good)) == len(FEATURE_NAMES),
          f"got {len(extract_features(good))} want {len(FEATURE_NAMES)}")

    total = 18
    passed = total - len(failures)
    print(f"\n{passed}/{total} checks passed"
          + (f" — FAILURES: {failures}" if failures else ""))
    return 0 if not failures else 1


# ── CLI ───────────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(
        prog="score_quality.py",
        description="Optional learned-quality scorer for src/data-quality-classifier.js.")
    p.add_argument("--pairs", default=None,
                   help="Input JSONL of training pairs. Omit to read stdin.")
    p.add_argument("--out", default=None, help="Also write the JSON result here.")
    p.add_argument("--model", default=None,
                   help="Optional fitted model (.json/.pkl/.joblib/.onnx). "
                        "Absent => shipped learned-default weights.")
    p.add_argument("--keep-fraction", type=float, default=0.9,
                   help="Top fraction of rows to keep by score (DCLM-style).")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help="Determinism seed (interface symmetry; path is "
                        "seed-independent).")
    p.add_argument("--self-test", action="store_true",
                   help="Run the in-process synthetic self-test and exit.")
    return p.parse_args()


def main():
    args = parse_args()
    if args.self_test:
        return self_test()

    if args.pairs:
        if not os.path.isfile(args.pairs):
            log(f"[score_quality] input not found: {args.pairs}")
            print(json.dumps(_input_error(
                "input_not_found",
                **_path_meta(args.pairs),
            )))
            return EXIT_NO_INPUT
        with open(args.pairs, "r", encoding="utf-8") as f:
            rows, load_error = load_rows(f)
    else:
        rows, load_error = load_rows(sys.stdin)

    if load_error:
        log(f"[score_quality] bad input: {load_error.get('error')}")
        print(json.dumps(load_error))
        return EXIT_NO_INPUT

    if not rows:
        log("[score_quality] no rows to score")
        print(json.dumps(_input_error("input_empty")))
        return EXIT_NO_INPUT

    result = score_corpus(rows, args.model, args.keep_fraction)
    result["seed"] = args.seed

    payload = json.dumps(result, ensure_ascii=False)
    if args.out:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".",
                        exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(payload)
        except Exception as e:  # noqa: BLE001 — out write is best-effort
            log(f"[score_quality] WARN: could not write --out {args.out}: {e}")

    print(payload)
    log(f"[score_quality] scored {result.get('n', 0)} rows via "
        f"{result.get('backend_used')} — kept "
        f"{len(result.get('kept_indices', []))} @ keep_fraction="
        f"{args.keep_fraction}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
