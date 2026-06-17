#!/usr/bin/env python3
"""T2.1 — Semantic near-duplicate dedup for merged training pairs.

Across a multi-teacher merge, the same (or near-same) prompt often gets
answered by more than one teacher. When two pairs are semantically near
identical they teach the model the same thing twice, so one is dead weight
that only slows the loss curve. This script finds those near-dups by cosine
similarity over sentence embeddings and keeps the higher-confidence copy.

Default embedder is nomic-embed-text-v1.5 (CPU-runnable, ~270 MB, opt-in
download). When sentence-transformers / the model is unavailable we fall back
to a dependency-free hashed character+word n-gram vector so the stage still
runs everywhere — the fallback is coarser but deterministic, and the report
records which backend actually ran.

Two pairs with cosine > --threshold (default 0.92) are duplicates. Among a
cluster of near-dups the survivor is chosen by, in order:
  1. an explicit numeric `confidence` field on the row, if present
  2. teacher rank from --teacher-priority (earlier = better), if given
  3. a local quality score (penalizes CoT leakage + refusals, rewards
     reference overlap + reasonable length/structure) — mirrors the JS
     scoreCandidateLocal in src/distill-preference.js (T2.3)

Usage:
  python dedup_pairs.py \
    --pairs <run>/merged/training-pairs.jsonl \
    --out   <run>/merged/training-pairs.deduped.jsonl \
    [--threshold 0.92] [--embedder nomic-embed-text-v1.5] \
    [--key pair|input|output] [--teacher-priority claude,gpt4o,deepseek] \
    [--preview] [--no-fallback] [--report <path>]

Output: a single JSON summary object on stdout (machine-readable for the Node
caller). All human-facing progress goes to stderr. With --preview the deduped
JSONL is NOT written (dry run); the summary still reports what WOULD be cut.

Exit codes: 0 ok · 20 input file missing or empty · 2 bad args (argparse).
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys

# T1.7 — Windows cp950/cp1252 emoji crash guard. Import side-effect runs the
# shim at module load; teacher outputs in these pairs routinely contain emoji.
from _console import setup_utf8 as _setup_utf8  # noqa: F401 — import side-effect

EXIT_OK = 0
EXIT_NO_INPUT = 20


def _env_int(name, default):
    try:
        value = int(os.environ.get(name, str(default)))
    except Exception:
        return default
    return value if value > 0 else default


MAX_ROWS = _env_int("KOLM_DEDUP_PAIRS_MAX_ROWS", 50000)
MAX_LINE_CHARS = _env_int("KOLM_DEDUP_PAIRS_MAX_LINE_CHARS", 1000000)
MAX_TOTAL_CHARS = _env_int("KOLM_DEDUP_PAIRS_MAX_TOTAL_CHARS", 50000000)
MAX_TEXT_CHARS = _env_int("KOLM_DEDUP_PAIRS_MAX_TEXT_CHARS", 250000)
MAX_TOTAL_TEXT_CHARS = _env_int("KOLM_DEDUP_PAIRS_MAX_TOTAL_TEXT_CHARS", 50000000)
MAX_COMPARISONS = _env_int("KOLM_DEDUP_PAIRS_MAX_COMPARISONS", 5000000)


class InputLimitError(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = detail or code


def parse_args():
    p = argparse.ArgumentParser(description="Semantic near-duplicate dedup for training pairs.")
    p.add_argument("--pairs", default=None, help="Input JSONL of training pairs.")
    p.add_argument("--out", default=None,
                   help="Where to write the deduped JSONL. Required unless --preview.")
    p.add_argument("--threshold", type=float, default=0.92,
                   help="Cosine similarity at/above which two pairs are duplicates.")
    p.add_argument("--embedder", default="nomic-embed-text-v1.5",
                   help="Embedder id, or 'ngram' to force the dependency-free fallback.")
    p.add_argument("--key", default="pair", choices=["pair", "input", "output"],
                   help="Which text to embed: pair=input+output (default), or one side.")
    p.add_argument("--teacher-priority", default=None,
                   help="Comma list ranking teachers best-first, e.g. 'claude,gpt4o,deepseek'. "
                        "Matched as a substring against the row's teacher tag.")
    p.add_argument("--preview", action="store_true",
                   help="Dry run: compute + report removals but do NOT write --out.")
    p.add_argument("--no-fallback", action="store_true",
                   help="Fail instead of falling back to the n-gram backend if the "
                        "embedder cannot load.")
    p.add_argument("--report", default=None,
                   help="Optional path to also write the JSON summary.")
    p.add_argument("--limit", type=int, default=0,
                   help="Cap rows processed (0 = all). Useful for smoke runs.")
    p.add_argument("--self-test", action="store_true",
                   help="Run the dependency-free in-process contract check and exit.")
    return p.parse_args()


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _emit_error(code, detail=None, **extra):
    payload = {"ok": False, "error": code}
    if detail is not None:
        payload["detail"] = str(detail)
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))


def _bounded_limit(value):
    try:
        n = int(value or 0)
    except Exception:
        raise InputLimitError("limit_invalid", "limit must be an integer")
    if n < 0:
        raise InputLimitError("limit_invalid", "limit must be >= 0")
    if n > MAX_ROWS:
        raise InputLimitError("limit_too_large", f"limit {n} exceeds max {MAX_ROWS}")
    return n


def _bounded_threshold(value):
    try:
        n = float(value)
    except Exception:
        raise InputLimitError("threshold_invalid", "threshold must be finite")
    if not math.isfinite(n) or n < 0.0 or n > 1.0:
        raise InputLimitError("threshold_invalid", "threshold must be in [0,1]")
    return n


def _ensure_comparison_budget(n):
    comparisons = (int(n) * max(0, int(n) - 1)) // 2
    if comparisons > MAX_COMPARISONS:
        raise InputLimitError(
            "comparison_budget_exceeded",
            f"dedup would require up to {comparisons} pair comparisons; max {MAX_COMPARISONS}",
        )


# --- CoT markers (shared schema with eval_adapter.py) ------------------------
_MARKERS_PATH = os.path.join(os.path.dirname(__file__), "cot_markers.json")
try:
    with open(_MARKERS_PATH, "r", encoding="utf-8") as _mf:
        _MARKERS = json.load(_mf)
except Exception as _e:  # deliberate: cleanup — fall back to a minimal marker set
    sys.stderr.write(f"[dedup] WARN: could not load {_MARKERS_PATH}: {_e}; using fallback\n")
    _MARKERS = {"hard": ["<think>", "</think>"],
                "soft_opener": [r"^Okay,?\s+so\b", r"^Let\s+me\s+think"],
                "soft_inline": [r"\bstep[- ]by[- ]step\b"]}

_HARD_LITERAL = [p for p in _MARKERS.get("hard", [])
                 if not any(c in p for c in ".^$*+?()[]{}|\\")]
_HARD_REGEX = [re.compile(p, re.IGNORECASE) for p in _MARKERS.get("hard", [])
               if any(c in p for c in ".^$*+?()[]{}|\\")]
_SOFT = ([re.compile(p, re.IGNORECASE) for p in _MARKERS.get("soft_opener", [])]
         + [re.compile(p, re.IGNORECASE) for p in _MARKERS.get("soft_inline", [])])

_REFUSAL = re.compile(
    r"\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b",
    re.IGNORECASE)
_STRUCTURE = re.compile(r"(^|\n)\s*(\d+[.)]|[-*•])\s+", re.MULTILINE)
_WORD = re.compile(r"[a-z0-9]+")


def _has_hard_cot(text):
    if any(lit in text for lit in _HARD_LITERAL):
        return True
    return any(rx.search(text) for rx in _HARD_REGEX)


def _soft_cot_count(text):
    return sum(1 for rx in _SOFT if rx.search(text))


def _tokens(text):
    return [t for t in _WORD.findall((text or "").lower()) if len(t) > 2]


def token_overlap(candidate, reference):
    """|cand ∩ ref| / |ref| over tokens len>2. Mirrors eval_adapter._judge_local."""
    ref = set(_tokens(reference))
    if not ref:
        return 0.0
    cand = set(_tokens(candidate))
    return len(cand & ref) / len(ref)


def score_quality(text, seed=None):
    """Local [0,1] quality heuristic — mirrors scoreCandidateLocal (T2.3)."""
    text = text or ""
    score = 0.5
    if _has_hard_cot(text):
        score -= 0.5
    elif _soft_cot_count(text) >= 2:
        score -= 0.2
    if _REFUSAL.search(text):
        score -= 0.2
    n = len(text.strip())
    if n < 20:
        score -= 0.2
    elif n < 60:
        score -= 0.1
    elif n <= 1200:
        score += 0.1
    elif n > 2000:
        score -= 0.1
    if _STRUCTURE.search(text):
        score += 0.05
    if seed:
        score += 0.3 * token_overlap(text, seed)
    return max(0.0, min(1.0, score))


# --- row IO ------------------------------------------------------------------
def load_rows(path, limit=0):
    limit = _bounded_limit(limit)
    rows = []
    total_chars = 0
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if len(line) > MAX_LINE_CHARS:
                raise InputLimitError(
                    "input_line_too_large",
                    f"line {line_no} exceeds {MAX_LINE_CHARS} chars",
                )
            total_chars += len(line)
            if total_chars > MAX_TOTAL_CHARS:
                raise InputLimitError(
                    "input_too_many_chars",
                    f"input exceeds {MAX_TOTAL_CHARS} total chars",
                )
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:  # deliberate: cleanup — skip a single malformed line
                continue
            if not isinstance(row, dict):
                continue
            if len(rows) >= MAX_ROWS:
                raise InputLimitError(
                    "input_too_many_rows",
                    f"row limit {MAX_ROWS} exceeded",
                )
            rows.append(row)
            if limit and len(rows) >= limit:
                break
    return rows


def row_input(r):
    if not isinstance(r, dict):
        return ""
    return r.get("input") or r.get("prompt") or ""


def row_output(r):
    if not isinstance(r, dict):
        return ""
    return r.get("teacher_output") or r.get("output") or r.get("response") or ""


def row_teacher(r):
    if not isinstance(r, dict):
        return ""
    return (r.get("_teacher_phase") or r.get("teacher")
            or r.get("teacher_spec") or r.get("vendor") or "")


def row_text(r, key):
    if key == "input":
        return row_input(r)
    if key == "output":
        return row_output(r)
    return (row_input(r) + "\n\n" + row_output(r)).strip()


def build_texts(rows, key):
    texts = []
    total = 0
    for i, r in enumerate(rows):
        text = row_text(r, key)
        if len(text) > MAX_TEXT_CHARS:
            raise InputLimitError(
                "text_too_large",
                f"row {i} text exceeds {MAX_TEXT_CHARS} chars",
            )
        total += len(text)
        if total > MAX_TOTAL_TEXT_CHARS:
            raise InputLimitError(
                "input_too_many_text_chars",
                f"embedded text exceeds {MAX_TOTAL_TEXT_CHARS} total chars",
            )
        texts.append(text)
    return texts


def row_confidence(r, teacher_rank, seed_key="seed_output"):
    """Survivor preference. Returns a sort key tuple; smaller sorts first (better)."""
    explicit = r.get("confidence") if isinstance(r, dict) else None
    if isinstance(explicit, (int, float)) and math.isfinite(float(explicit)):
        base = float(explicit)
    else:
        seed = r.get(seed_key) if isinstance(r, dict) else None
        base = score_quality(row_output(r), seed)
    rank = teacher_rank.get(_match_teacher(row_teacher(r), teacher_rank), 10_000)
    return (-base, rank)


def _match_teacher(teacher, teacher_rank):
    t = (teacher or "").lower()
    for key in teacher_rank:
        if key and key in t:
            return key
    return teacher


# --- embedding backends ------------------------------------------------------
def embed_nomic(texts, model_id):
    """Dense unit-normalized embeddings via sentence-transformers. May raise."""
    import numpy as np  # noqa
    from sentence_transformers import SentenceTransformer

    hf_id = model_id
    if "/" not in hf_id:
        hf_id = "nomic-ai/" + hf_id  # nomic-embed-text-v1.5 -> nomic-ai/nomic-embed-text-v1.5
    model = SentenceTransformer(hf_id, trust_remote_code=True, device="cpu")
    # nomic convention: documents get a 'search_document: ' task prefix.
    prefixed = ["search_document: " + (t or "") for t in texts]
    embs = model.encode(prefixed, batch_size=32, show_progress_bar=False,
                        convert_to_numpy=True, normalize_embeddings=True)
    return np.asarray(embs, dtype="float32"), f"nomic:{hf_id}"


def _stable_hash(s, dim=2048):
    h = hashlib.blake2b(str(s).encode("utf-8", errors="ignore"), digest_size=8).digest()
    return int.from_bytes(h, "little") % dim


def _ngram_features(text, dim=2048):
    """Hashed word + char-trigram bag, unit-normalized sparse dict."""
    text = (text or "").lower()
    feats = {}
    for w in _WORD.findall(text):
        h = _stable_hash("w:" + w, dim)
        feats[h] = feats.get(h, 0.0) + 1.0
    padded = f" {text} "
    for i in range(len(padded) - 2):
        tri = padded[i:i + 3]
        h = _stable_hash("c:" + tri, dim)
        feats[h] = feats.get(h, 0.0) + 1.0
    norm = math.sqrt(sum(v * v for v in feats.values())) or 1.0
    return {k: v / norm for k, v in feats.items()}


def embed_ngram(texts):
    return [_ngram_features(t) for t in texts], "ngram:hashed-2048"


def _sparse_cos(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


# --- greedy dedup ------------------------------------------------------------
def dedup(rows, reprs, backend, threshold):
    """Greedy: best-confidence-first; keep a row unless it's within threshold of
    an already-kept row. Survivors are the highest-confidence of each cluster.
    Returns (kept_indices_set, removals[])."""
    order = sorted(range(len(rows)), key=lambda i: rows[i]["__conf_key"])
    kept = []          # indices kept, in selection order
    removals = []      # {removed, kept, similarity}
    dense = backend == "dense"

    if dense:
        import numpy as np
        kept_mat = None  # np array [k, d]
        for i in order:
            v = reprs[i]
            if kept_mat is None:
                kept.append(i)
                kept_mat = v.reshape(1, -1)
                continue
            sims = kept_mat @ v
            j = int(sims.argmax())
            best = float(sims[j])
            if best >= threshold:
                removals.append({"removed": i, "kept": kept[j], "similarity": round(best, 4)})
            else:
                kept.append(i)
                kept_mat = np.vstack([kept_mat, v.reshape(1, -1)])
    else:
        for i in order:
            v = reprs[i]
            best, bj = 0.0, -1
            for slot, ki in enumerate(kept):
                s = _sparse_cos(v, reprs[ki])
                if s > best:
                    best, bj = s, slot
            if bj >= 0 and best >= threshold:
                removals.append({"removed": i, "kept": kept[bj], "similarity": round(best, 4)})
            else:
                kept.append(i)
    return set(kept), removals


def _self_test_rows():
    base = (
        "Open the billing settings page, review the invoice payment method, "
        "confirm the billing address, save the changes, and verify the receipt "
        "history before leaving the account page."
    )
    clean = (
        "Refunds are available from the orders page for eligible purchases. "
        "Choose the order, select request refund, explain the reason, submit the "
        "form, and keep the confirmation number for support follow up."
    )
    return [
        {
            "id": "high-confidence",
            "input": "How do I update billing?",
            "teacher_output": base,
            "_teacher_phase": "gpt4o",
            "confidence": 0.95,
        },
        {
            "id": "teacher-priority-low-confidence",
            "input": "How do I update billing?",
            "teacher_output": base,
            "_teacher_phase": "claude",
            "confidence": 0.10,
        },
        {
            "id": "clean-refund",
            "input": "How do I request a refund?",
            "teacher_output": clean,
            "_teacher_phase": "claude",
        },
        {
            "id": "cot-refund",
            "input": "How do I request a refund?",
            "teacher_output": "<think>recall refund workflow</think> " + clean,
            "_teacher_phase": "claude",
        },
        {
            "id": "distinct-auth",
            "input": "How do I reset a password?",
            "teacher_output": "Use the security page to request a password reset link, verify the token, and rotate saved sessions.",
            "_teacher_phase": "gpt4o",
        },
        {
            "id": "distinct-install",
            "input": "How do I install the desktop app?",
            "teacher_output": "Download the installer, check the release signature, run the package, and sign in after the first launch.",
            "_teacher_phase": "deepseek",
        },
    ]


def _dedup_in_memory(rows, threshold=0.82, key="pair", teacher_priority="claude,gpt4o,deepseek"):
    local = [dict(r) for r in rows]
    teacher_rank = {}
    for i, name in enumerate(s.strip().lower() for s in teacher_priority.split(",")):
        if name:
            teacher_rank[name] = i
    for r in local:
        r["__conf_key"] = row_confidence(r, teacher_rank)
    texts = build_texts(local, key)
    _ensure_comparison_budget(len(local))
    reprs, _embedder = embed_ngram(texts)
    kept_set, removals = dedup(local, reprs, "sparse", threshold)
    return {
        "kept_ids": [local[i].get("id") for i in sorted(kept_set)],
        "removed_ids": [local[rm["removed"]].get("id") for rm in removals],
        "removals": removals,
    }


def self_test():
    failures = []
    rows = _self_test_rows()
    first = _dedup_in_memory(rows)
    second = _dedup_in_memory(rows)
    kept = set(first["kept_ids"])
    removed = set(first["removed_ids"])

    if first != second:
        failures.append("non_deterministic")
    if "high-confidence" not in kept or "teacher-priority-low-confidence" not in removed:
        failures.append("confidence_did_not_beat_teacher_priority")
    if "clean-refund" not in kept or "cot-refund" not in removed:
        failures.append("clean_row_did_not_beat_cot_duplicate")
    if not {"distinct-auth", "distinct-install"}.issubset(kept):
        failures.append("distinct_rows_not_preserved")
    if len(first["removals"]) < 2:
        failures.append("expected_at_least_two_duplicates_removed")

    passed = 5 - len(failures)
    for f in failures:
        log("  FAIL: " + f)
    log(f"[dedup --self-test] PASS {passed}/5 removed={len(first['removals'])}")
    print(json.dumps({
        "ok": not failures,
        "self_test": True,
        "passed": passed,
        "total": 5,
        "kept_ids": sorted(kept),
        "removed_ids": sorted(removed),
        "failures": failures,
    }, ensure_ascii=False))
    return EXIT_OK if not failures else 1


def main():
    args = parse_args()

    if args.self_test:
        return self_test()

    try:
        threshold = _bounded_threshold(args.threshold)
        limit = _bounded_limit(args.limit)
    except InputLimitError as e:
        log(f"[dedup] input rejected: {e.detail}")
        _emit_error(e.code, e.detail)
        return EXIT_NO_INPUT

    if not args.pairs:
        log("[dedup] --pairs is required unless --self-test")
        _emit_error("pairs_required")
        return EXIT_NO_INPUT

    if not os.path.isfile(args.pairs):
        log(f"[dedup] input not found: {args.pairs}")
        _emit_error("input_not_found", pairs=args.pairs)
        return EXIT_NO_INPUT

    try:
        rows = load_rows(args.pairs, limit)
    except InputLimitError as e:
        log(f"[dedup] input rejected: {e.detail}")
        _emit_error(e.code, e.detail)
        return EXIT_NO_INPUT
    except OSError as e:
        log(f"[dedup] read failed: {e}")
        _emit_error("read_failed", str(e), pairs=args.pairs)
        return EXIT_NO_INPUT
    if not rows:
        log(f"[dedup] input is empty: {args.pairs}")
        _emit_error("input_empty", pairs=args.pairs)
        return EXIT_NO_INPUT

    if not args.preview and not args.out:
        log("[dedup] --out is required unless --preview")
        _emit_error("out_required")
        return EXIT_OK  # not a data error; surface cleanly to the caller

    teacher_rank = {}
    if args.teacher_priority:
        for i, name in enumerate(s.strip().lower() for s in args.teacher_priority.split(",")):
            if name:
                teacher_rank[name] = i

    for r in rows:
        r["__conf_key"] = row_confidence(r, teacher_rank)
    try:
        texts = build_texts(rows, args.key)
        _ensure_comparison_budget(len(rows))
    except InputLimitError as e:
        log(f"[dedup] input rejected: {e.detail}")
        _emit_error(e.code, e.detail)
        return EXIT_NO_INPUT

    # Choose backend: explicit 'ngram' forces fallback; otherwise try nomic.
    embedder_used = None
    backend = None
    reprs = None
    if args.embedder.lower() in ("ngram", "hashed", "fallback"):
        reprs, embedder_used = embed_ngram(texts)
        backend = "sparse"
    else:
        try:
            log(f"[dedup] loading embedder {args.embedder} (first run downloads ~270 MB)")
            reprs, embedder_used = embed_nomic(texts, args.embedder)
            backend = "dense"
        except Exception as e:  # deliberate: cleanup — model/deps absent is expected off-GPU boxes
            if args.no_fallback:
                log(f"[dedup] embedder load failed and --no-fallback set: {e}")
                print(json.dumps({"ok": False, "error": "embedder_unavailable", "detail": str(e)}))
                return EXIT_OK
            log(f"[dedup] embedder unavailable ({e}); falling back to n-gram backend")
            reprs, embedder_used = embed_ngram(texts)
            backend = "sparse"

    kept_set, removals = dedup(rows, reprs, backend, threshold)

    n_in = len(rows)
    n_kept = len(kept_set)
    n_removed = n_in - n_kept
    frac = (n_removed / n_in) if n_in else 0.0

    # Sample removals with teacher context for the human preview.
    sample = []
    for rm in removals[:15]:
        ki, ri = rm["kept"], rm["removed"]
        sample.append({
            "similarity": rm["similarity"],
            "kept_teacher": row_teacher(rows[ki]),
            "removed_teacher": row_teacher(rows[ri]),
            "kept_input": row_input(rows[ki])[:80],
            "removed_input": row_input(rows[ri])[:80],
        })

    wrote = None
    if not args.preview:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                for i, r in enumerate(rows):
                    if i in kept_set:
                        r.pop("__conf_key", None)
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
        except OSError as e:
            log(f"[dedup] write failed: {e}")
            _emit_error("write_failed", str(e), out=args.out)
            return EXIT_NO_INPUT
        wrote = args.out
        log(f"[dedup] wrote {n_kept} kept rows -> {args.out}")

    summary = {
        "ok": True,
        "version": "t2.1-v1",
        "embedder_used": embedder_used,
        "backend": backend,
        "threshold": threshold,
        "key": args.key,
        "preview": bool(args.preview),
        "n_in": n_in,
        "n_kept": n_kept,
        "n_removed": n_removed,
        "removed_fraction": round(frac, 4),
        "wrote": wrote,
        "removals_sample": sample,
    }

    log(f"[dedup] {n_removed}/{n_in} near-dups ({frac*100:.1f}%) "
        f"via {embedder_used} @ cos>={threshold}"
        + (" [PREVIEW]" if args.preview else ""))

    if args.report:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.report)) or ".", exist_ok=True)
            with open(args.report, "w", encoding="utf-8") as f:
                json.dump(summary, f, ensure_ascii=False, indent=2)
        except Exception as e:  # deliberate: cleanup — report write is best-effort
            log(f"[dedup] WARN: could not write report {args.report}: {e}")

    print(json.dumps(summary, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
