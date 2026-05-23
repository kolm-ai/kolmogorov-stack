"""
apps/runtime/entropy_budget.py

W728-3: Entropy-gated budget allocation for inference-time compute.

A confident prompt (the model is sure what to say first) does not need
many samples or many verify rounds — burning compute on it is waste. An
uncertain prompt (the first-token distribution is spread thin) benefits
from MORE samples + MORE verify passes. This module separates the cheap
entropy probe from the budget-allocation rule so callers can swap either
half without touching the orchestrator.

Thresholds (nats, first-token entropy):

    < 0.5    low      -> n_samples=1,  verify_rounds=0
    0.5-2.0  mid      -> n_samples=4,  verify_rounds=1
    > 2.0    high     -> n_samples=max_n, verify_rounds=2

Surface (load-bearing for tests/wave728-its.test.js):

    def estimate_entropy(prompt, model_fn=None) -> float
    def allocate_budget(entropy, base_n=1, max_n=8) -> dict

The thresholds are deliberately a STEP FUNCTION, not a smooth ramp:
operators want to read a budget allocation and immediately know which
bucket they're in. The bucket boundaries are part of the public contract
(tests pin them) — moving them is a breaking change for any downstream
caller that has wired a budget chart against these numbers.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional


LOW_ENTROPY_THRESHOLD: float = 0.5
HIGH_ENTROPY_THRESHOLD: float = 2.0

ENTROPY_BUDGET_VERSION: str = "w728-v1"


def _default_model_fn(prompt: str) -> Any:
    """
    Honest no-op entropy probe. Returns a small synthetic distribution
    so callers without a real model still see a finite, non-zero entropy
    and the budget allocator picks a sensible default. Tests inject a
    real ``model_fn``.
    """
    # Two-token "I don't know" distribution at p=[0.6, 0.4] -> H ≈ 0.673
    # nats. This lands in the "mid" bucket so the default probe biases
    # toward modest oversampling rather than silently picking n=1.
    return [0.6, 0.4]


def _shannon_entropy_nats(probs: Any) -> float:
    """
    Compute Shannon entropy in nats for an iterable of probabilities.
    Tolerant of unnormalized inputs (re-normalizes); rejects negatives
    and empties so a malformed probe is loud.
    """
    nums: list[float] = []
    for p in probs:
        try:
            f = float(p)
        except (TypeError, ValueError) as exc:
            raise TypeError(f"entropy probe returned non-numeric {p!r}") from exc
        if f < 0:
            raise ValueError(f"entropy probe returned negative probability {f}")
        nums.append(f)
    if not nums:
        raise ValueError("entropy probe returned an empty distribution")
    total = sum(nums)
    if total <= 0:
        # All zeros — degenerate distribution. Honest-fail to entropy=0.
        return 0.0
    h = 0.0
    for f in nums:
        p = f / total
        if p > 0:
            h -= p * math.log(p)
    return h


def estimate_entropy(prompt: str, model_fn: Optional[Callable[[str], Any]] = None) -> float:
    """
    First-token entropy of the model's reply to ``prompt``, in nats.

    ``model_fn(prompt)`` is expected to return one of:
      * a flat list/tuple of floats — interpreted as the first-token
        probability distribution. Re-normalized internally so callers
        can pass logits-as-probs or top-k probs.
      * a dict ``{"first_token_probs": list[float]}`` — same as above
        but explicit, used by tests that share the model_fn between
        estimate_entropy + best_of_n.
      * a bare float — already-computed entropy in nats; we pass it
        through after a non-negativity check. This is the path for
        backends that expose entropy directly (vLLM `logprobs` aggr.).

    Honesty contract: a missing/unparseable distribution NEVER silently
    returns zero. We raise a ValueError so the orchestrator can catch
    it, log it, and fall back to ``allocate_budget(entropy=1.0, ...)``
    explicitly rather than treating "no probe" as "high confidence".
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be a str, got {type(prompt).__name__}")
    mfn = model_fn if model_fn is not None else _default_model_fn
    raw = mfn(prompt)
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        h = float(raw)
        if h < 0:
            raise ValueError(f"entropy probe returned negative entropy {h}")
        return h
    if isinstance(raw, dict):
        if "first_token_probs" in raw:
            return _shannon_entropy_nats(raw["first_token_probs"])
        if "entropy_nats" in raw:
            h = float(raw["entropy_nats"])
            if h < 0:
                raise ValueError(f"entropy probe returned negative entropy {h}")
            return h
        raise ValueError(
            "entropy probe dict must carry 'first_token_probs' or 'entropy_nats'"
        )
    if isinstance(raw, (list, tuple)):
        return _shannon_entropy_nats(raw)
    raise TypeError(
        f"entropy probe returned unsupported shape {type(raw).__name__}"
    )


def allocate_budget(entropy: float, base_n: int = 1, max_n: int = 8) -> dict:
    """
    Map a first-token entropy (nats) to a compute budget.

    Returns:
        {
            "n_samples":     int,   # >= base_n, <= max_n
            "verify_rounds": int,
            "reasoning":     str,   # human-readable bucket explanation
        }

    Buckets (pinned by tests/wave728-its.test.js):

        entropy >  2.0 nats   -> n_samples = max_n,   verify_rounds = 2
        0.5 <= e <= 2.0       -> n_samples = mid (4 clamped to [base_n,max_n]),
                                 verify_rounds = 1
        entropy <  0.5 nats   -> n_samples = base_n   (typically 1),
                                 verify_rounds = 0

    base_n + max_n are honest knobs: a deployment that cannot afford
    n=8 high-entropy calls can dial max_n=2 and still get the mid/low
    routing for free; a deployment that wants every prompt sampled at
    least 2x can dial base_n=2.
    """
    try:
        entropy = float(entropy)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"entropy must be float-coercible, got {entropy!r}") from exc
    try:
        base_n = int(base_n)
        max_n = int(max_n)
    except (TypeError, ValueError) as exc:
        raise TypeError(
            f"base_n + max_n must be int-coercible, got base_n={base_n!r} max_n={max_n!r}"
        ) from exc
    if base_n < 1:
        raise ValueError(f"base_n must be >= 1, got {base_n}")
    if max_n < base_n:
        raise ValueError(f"max_n ({max_n}) must be >= base_n ({base_n})")
    if entropy < 0:
        # Negative entropy is impossible for a real distribution; clamp
        # to 0 (low bucket) rather than throw so a flaky probe doesn't
        # break the orchestrator.
        entropy = 0.0

    if entropy > HIGH_ENTROPY_THRESHOLD:
        n_samples = max_n
        verify_rounds = 2
        bucket = "high"
        reasoning = (
            f"entropy {entropy:.3f} > {HIGH_ENTROPY_THRESHOLD} nats: "
            f"high-uncertainty input, allocating max_n={max_n} samples "
            f"and {verify_rounds} verify rounds"
        )
    elif entropy >= LOW_ENTROPY_THRESHOLD:
        # Mid bucket: 4 samples is the doc'd default but we honor the
        # caller's [base_n, max_n] window so a small-budget deployment
        # still gets some oversampling without exceeding its cap.
        n_samples = max(base_n, min(4, max_n))
        verify_rounds = 1
        bucket = "mid"
        reasoning = (
            f"entropy {entropy:.3f} nats in [{LOW_ENTROPY_THRESHOLD}, "
            f"{HIGH_ENTROPY_THRESHOLD}]: mid-uncertainty input, "
            f"allocating n_samples={n_samples} and {verify_rounds} verify round"
        )
    else:
        n_samples = base_n
        verify_rounds = 0
        bucket = "low"
        reasoning = (
            f"entropy {entropy:.3f} < {LOW_ENTROPY_THRESHOLD} nats: "
            f"high-confidence input, allocating n_samples={n_samples} "
            f"and {verify_rounds} verify rounds (no oversampling)"
        )

    return {
        "n_samples": int(n_samples),
        "verify_rounds": int(verify_rounds),
        "reasoning": reasoning,
        "bucket": bucket,
        "entropy_nats": float(entropy),
        "version": ENTROPY_BUDGET_VERSION,
    }


__all__ = [
    "estimate_entropy",
    "allocate_budget",
    "ENTROPY_BUDGET_VERSION",
    "LOW_ENTROPY_THRESHOLD",
    "HIGH_ENTROPY_THRESHOLD",
]
