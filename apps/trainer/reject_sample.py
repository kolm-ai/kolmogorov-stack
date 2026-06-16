"""
apps/trainer/reject_sample.py

Rejection-sampling / best-of-N candidate selection. The STaR / RAFT / RFT
regime: for each prompt, sample N candidates, score every candidate with a
VERIFIABLE reward, keep the best (or first above-threshold) candidate IFF it
clears the threshold, and emit the accepted set for SFT.

The load-bearing property for kolm: the reward used to ACCEPT a candidate here
is the SAME code path the K-score release gate scores with. We reuse
apps.trainer.grpo.REWARD_FUNCTIONS + the kolm_verifier reward verbatim, so a
candidate that passes selection would get the same number at the gate.
Train-eval mismatch becomes a hard error, not a culture.

This module is GPU-free and torch-free: it only scores + selects. The SFT
fine-tune on the accepted set is driven by workers/distill/scripts/
train_rejection.py (which calls select_accepted here, then hands the accepted
pairs to the same SFT path as train_lora.py).

Citations:
  STaR:  Zelikman et al, 2022, arXiv:2203.14465
  RAFT:  Dong et al, 2023, arXiv:2304.06767
  RFT:   Yuan et al, 2023, arXiv:2308.01825
  Best-of-N / BOND: Sessa et al, 2024, arXiv:2407.14622
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Optional, Sequence

SELECTION_MODES = ("best", "threshold")


def _kolm_verifier_one(completion: str, reference: Any) -> float:
    """Single-completion kolm_verifier reward. IDENTICAL formula to
    workers/distill/scripts/train_grpo.py::kolm_verifier_reward and the JS
    mirror src/distill-rejection-sampling.js::rewardKolmVerifier."""
    text = completion if isinstance(completion, str) else str(completion)
    score = 0.5
    low = text.lower()
    if "<think>" in low or "</think>" in low:
        score -= 0.3
    if any(p in low for p in ("i cannot", "i can't", "as an ai")):
        score -= 0.25
    if reference:
        a = set(text.lower().split())
        b = set(str(reference).lower().split())
        if a and b:
            inter = len(a & b)
            union = len(a | b)
            score += 0.3 * (inter / union if union else 0.0)
    return max(0.0, min(1.0, score))


def score_candidates(
    candidates: Sequence[str],
    row: Mapping[str, Any],
    family: str,
) -> list[float]:
    """Score every candidate for ONE prompt with the requested reward family,
    reusing apps.trainer.grpo.REWARD_FUNCTIONS so the number matches the GRPO /
    K-score path exactly. Returns one float per candidate.

    `row` carries the verifiable column the family needs:
      kolm_verifier / math_checker -> row['references'] (or 'reference'/'output')
      schema_validator             -> row['schemas'] or row['regexes']
      code_exec                    -> row['tests']
      format                       -> (structural, no column)
    """
    n = len(candidates)
    if n == 0:
        return []
    ref = row.get("references", row.get("reference", row.get("output")))

    if family == "kolm_verifier":
        return [_kolm_verifier_one(c, ref) for c in candidates]

    if family == "format":
        from apps.trainer.grpo import make_format_reward
        return list(make_format_reward()(["" ] * n, list(candidates)))

    # Verifiable families that live in grpo.REWARD_FUNCTIONS. We fan the single
    # prompt's row out to per-candidate columns (the trl reward signature takes
    # parallel lists), then call the real reward function.
    from apps.trainer.grpo import REWARD_FUNCTIONS
    fn = REWARD_FUNCTIONS.get(family)
    if fn is None:
        raise ValueError(f"unknown reward family: {family}")

    prompts = [row.get("prompt", "")] * n
    if family == "math_checker":
        return list(fn(prompts, list(candidates), [ref] * n))
    if family == "code_exec":
        tests = row.get("tests")
        return list(fn(prompts, list(candidates), [tests] * n))
    if family == "schema_validator":
        schemas = row.get("schemas")
        regexes = row.get("regexes")
        if regexes is not None:
            return list(fn(prompts, list(candidates), regexes=[regexes] * n))
        if schemas is not None:
            return list(fn(prompts, list(candidates), schemas=[schemas] * n))
        # No verifiable column -> all-zero (un-scoreable, reject).
        return [0.0] * n
    raise ValueError(f"unhandled reward family: {family}")


def select_accepted(
    groups: Sequence[Mapping[str, Any]],
    *,
    family: str = "kolm_verifier",
    threshold: float = 0.5,
    selection: str = "best",
) -> dict[str, Any]:
    """Best-of-N selection over a list of groups.

    groups: [ { 'id', 'prompt', 'candidates': [str, ...], <verifiable col> } ]

    Returns:
      {
        'accepted': [ {'id','prompt','completion','score'} ],
        'ledger':   [ {'id','decision','score'?,'best_score','n'} ],
        'stats':    { accept_rate, mean_candidate_score, mean_accepted_score,
                      num_candidates_max, threshold, selection, family,
                      prompts, accepted, rejected, candidates_total,
                      ledger_hash },
      }
    A prompt whose best candidate is below threshold is REJECTED and contributes
    ZERO training rows. That is the whole point of rejection sampling.
    """
    if selection not in SELECTION_MODES:
        raise ValueError(f"selection must be one of {SELECTION_MODES}; got {selection}")
    if not (0.0 <= float(threshold) <= 1.0):
        raise ValueError("threshold must be in [0,1]")

    accepted: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    candidates_total = 0
    num_candidates_max = 0
    score_sum = 0.0
    score_count = 0
    accepted_score_sum = 0.0

    for g in groups:
        cands = g.get("candidates") or []
        candidates_total += len(cands)
        num_candidates_max = max(num_candidates_max, len(cands))
        if not cands:
            ledger.append({"id": g.get("id"), "decision": "reject", "best_score": None, "n": 0})
            continue

        scores = score_candidates(cands, g, family)
        for s in scores:
            score_sum += float(s)
            score_count += 1

        best_idx = max(range(len(scores)), key=lambda i: scores[i])
        best_score = scores[best_idx]

        pick_idx = None
        if selection == "threshold":
            for i, s in enumerate(scores):
                if s >= threshold:
                    pick_idx = i
                    break
        else:  # best
            if best_score >= threshold:
                pick_idx = best_idx

        if pick_idx is not None:
            accepted.append({
                "id": g.get("id"),
                "prompt": g.get("prompt"),
                "completion": cands[pick_idx],
                "score": scores[pick_idx],
            })
            accepted_score_sum += scores[pick_idx]
            ledger.append({
                "id": g.get("id"), "decision": "accept",
                "score": scores[pick_idx], "best_score": best_score, "n": len(cands),
            })
        else:
            ledger.append({
                "id": g.get("id"), "decision": "reject",
                "best_score": best_score, "n": len(cands),
            })

    prompts = len(groups)
    acc = len(accepted)
    # Compact separators (no spaces) so the ledger serialization is BYTE-
    # identical to the JS path's JSON.stringify -> the ledger_hash matches
    # across both languages, proving one scoring path end to end.
    ledger_str = "\n".join(json.dumps(l, separators=(",", ":")) for l in ledger)
    ledger_hash = "sha256:" + hashlib.sha256(ledger_str.encode("utf-8")).hexdigest()
    stats = {
        "prompts": prompts,
        "candidates_total": candidates_total,
        "num_candidates_max": num_candidates_max,
        "accepted": acc,
        "rejected": prompts - acc,
        "accept_rate": (acc / prompts) if prompts else 0.0,
        "mean_candidate_score": (score_sum / score_count) if score_count else 0.0,
        "mean_accepted_score": (accepted_score_sum / acc) if acc else 0.0,
        "threshold": float(threshold),
        "selection": selection,
        "family": family,
        "ledger_hash": ledger_hash,
    }
    return {"accepted": accepted, "ledger": ledger, "stats": stats}


__all__ = [
    "SELECTION_MODES",
    "score_candidates",
    "select_accepted",
]
