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


def parse_args():
    p = argparse.ArgumentParser(description="Semantic near-duplicate dedup for training pairs.")
    p.add_argument("--pairs", required=True, help="Input JSONL of training pairs.")
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
    return p.parse_args()


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


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
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:  # deliberate: cleanup — skip a single malformed line
                continue
            if limit and len(rows) >= limit:
                break
    return rows


def row_input(r):
    return r.get("input") or r.get("prompt") or ""


def row_output(r):
    return r.get("teacher_output") or r.get("output") or r.get("response") or ""


def row_teacher(r):
    return (r.get("_teacher_phase") or r.get("teacher")
            or r.get("teacher_spec") or r.get("vendor") or "")


def row_text(r, key):
    if key == "input":
        return row_input(r)
    if key == "output":
        return row_output(r)
    return (row_input(r) + "\n\n" + row_output(r)).strip()


def row_confidence(r, teacher_rank, seed_key="seed_output"):
    """Survivor preference. Returns a sort key tuple; smaller sorts first (better)."""
    explicit = r.get("confidence")
    if isinstance(explicit, (int, float)):
        base = float(explicit)
    else:
        base = score_quality(row_output(r), r.get(seed_key))
    rank = teacher_rank.get(_match_teacher(row_teacher(r), teacher_rank), 10_000)
    return (rank, -base)


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


def _ngram_features(text, dim=2048):
    """Hashed word + char-trigram bag, unit-normalized sparse dict."""
    text = (text or "").lower()
    feats = {}
    for w in _WORD.findall(text):
        h = hash("w:" + w) % dim
        feats[h] = feats.get(h, 0.0) + 1.0
    padded = f" {text} "
    for i in range(len(padded) - 2):
        tri = padded[i:i + 3]
        h = hash("c:" + tri) % dim
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


def main():
    args = parse_args()

    if not os.path.isfile(args.pairs):
        log(f"[dedup] input not found: {args.pairs}")
        print(json.dumps({"ok": False, "error": "input_not_found", "pairs": args.pairs}))
        return EXIT_NO_INPUT

    rows = load_rows(args.pairs, args.limit)
    if not rows:
        log(f"[dedup] input is empty: {args.pairs}")
        print(json.dumps({"ok": False, "error": "input_empty", "pairs": args.pairs}))
        return EXIT_NO_INPUT

    if not args.preview and not args.out:
        log("[dedup] --out is required unless --preview")
        print(json.dumps({"ok": False, "error": "out_required"}))
        return EXIT_OK  # not a data error; surface cleanly to the caller

    teacher_rank = {}
    if args.teacher_priority:
        for i, name in enumerate(s.strip().lower() for s in args.teacher_priority.split(",")):
            if name:
                teacher_rank[name] = i

    for r in rows:
        r["__conf_key"] = row_confidence(r, teacher_rank)
    texts = [row_text(r, args.key) for r in rows]

    # Choose backend: explicit 'ngram' forces fallback; otherwise try nomic.
    embedder_used = None
    backend = None
    reprs = None
    if args.embedder.lower() in ("ngram", "hashed", "fallback"):
        reprs, embedder_used = embed_ngram(texts)
        backend = "sparse"
    else:
        try:
            log(f"[dedup] loading embedder {args.embedder} (first run downloads ~270 MB)…")
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

    kept_set, removals = dedup(rows, reprs, backend, args.threshold)

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
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            for i, r in enumerate(rows):
                if i in kept_set:
                    r.pop("__conf_key", None)
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        wrote = args.out
        log(f"[dedup] wrote {n_kept} kept rows -> {args.out}")

    summary = {
        "ok": True,
        "version": "t2.1-v1",
        "embedder_used": embedder_used,
        "backend": backend,
        "threshold": args.threshold,
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
        f"via {embedder_used} @ cos>={args.threshold}"
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
