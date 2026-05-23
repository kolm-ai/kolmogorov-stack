"""
apps/runtime/best_of_n.py

W728-1: Best-of-N sampling for inference-time compute scaling.

Generate N candidate completions with the model at a non-zero temperature,
then pick the highest-scoring one. When a reward/judge model is available
pass it as ``score_fn``; otherwise we fall back to a length-normalized
log-probability proxy which is honest about its limits (a longer answer
is not automatically better; the proxy captures fluency floor only, not
correctness).

This is distinct from apps/runtime/ttc.py:best_of_n which couples to the
apps/trainer/grpo.py reward-fn signature (it expects ``(prompts, completions, **kw)
-> list[float]`` so the same fn that trained the policy also evals it at
inference). The W728 variant keeps the surface tiny so an orchestrator
(apps/runtime/inference_time_scaling.py) can compose it with self-verify
+ entropy-budget without dragging in the GRPO reward-fn shape.

Surface (load-bearing for tests/wave728-its.test.js):

    def best_of_n(prompt, n, temperature, score_fn=None, model_fn=None) -> dict

Return shape:

    {
        "output":          str,          # chosen candidate (best score)
        "all_candidates":  list[str],    # every sampled candidate (len == n_evaluated)
        "scores":          list[float],  # parallel to all_candidates
        "chosen_index":    int,          # argmax over scores
        "n_evaluated":     int,          # effective N actually sampled
    }

Design notes:
  * model_fn is fully injectable; tests do NOT need a real LLM. The
    expected shape is ``model_fn(prompt: str, temperature: float) -> str | dict``.
    A ``dict`` return may carry ``{"text": str, "logprobs": list[float]}``
    so the length-normalized log-prob proxy can be computed without a
    second forward pass. A bare ``str`` return is also accepted; in that
    case the fallback score is the raw length (longer is preferred as a
    weak fluency floor — comment-only honesty about this limit).
  * n=1 short-circuits to a single ``model_fn`` call (no sampling
    overhead, no scoring overhead). This is the load-bearing fast path
    for low-entropy inputs that get routed through entropy_budget with
    n_samples=1.
  * score_fn(prompt, candidate) -> float. We do NOT impose a sign
    convention; callers pass whatever scorer they want (reward model,
    self-evaluation, ROUGE-vs-reference, ...) and we take the argmax.
"""

from __future__ import annotations

from typing import Any, Callable, Optional


def _default_model_fn(prompt: str, temperature: float) -> str:
    """
    Honest no-op model. Returns the prompt prefixed with a marker so the
    caller can SEE we did not actually invoke a real LLM. Tests inject
    their own ``model_fn``; production callers must always pass one.
    """
    return f"[no-model-fn] prompt={prompt} temperature={temperature}"


def _length_normalized_logprob_proxy(prompt: str, candidate: Any) -> float:
    """
    Honest fallback scorer when no reward model is supplied. If the
    candidate is a dict carrying ``logprobs``, we average them (length
    normalization). If it's a bare string, we return its length as a
    very weak proxy — explicitly NOT a claim of quality, just a
    consistent ordering that prefers non-empty answers to empty ones.

    This is NOT a real reward model. Use a real ``score_fn`` whenever
    you have one. The fallback exists so the module never silently
    returns whichever candidate happens to land at index 0.
    """
    if isinstance(candidate, dict):
        text = str(candidate.get("text", ""))
        logprobs = candidate.get("logprobs")
        if isinstance(logprobs, (list, tuple)) and len(logprobs) > 0:
            try:
                nums = [float(x) for x in logprobs]
                return sum(nums) / float(len(nums))
            except (TypeError, ValueError):
                pass
        return float(len(text))
    return float(len(str(candidate)))


def best_of_n(
    prompt: str,
    n: int,
    temperature: float,
    score_fn: Optional[Callable[[str, Any], float]] = None,
    model_fn: Optional[Callable[[str, float], Any]] = None,
) -> dict:
    """
    Sample ``n`` candidates from ``model_fn`` at ``temperature``, score
    each with ``score_fn`` (or the length-normalized log-prob proxy if
    ``score_fn`` is None), return the highest-scoring candidate plus the
    full trace.

    Returns the shape pinned by tests/wave728-its.test.js:

        {
            "output":         str,
            "all_candidates": list[str],
            "scores":         list[float],
            "chosen_index":   int,
            "n_evaluated":    int,
        }
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be a str, got {type(prompt).__name__}")
    try:
        n = int(n)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"n must be int-coercible, got {n!r}") from exc
    if n < 1:
        raise ValueError(f"n must be >= 1, got {n}")
    try:
        temperature = float(temperature)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"temperature must be float-coercible, got {temperature!r}") from exc

    mfn = model_fn if model_fn is not None else _default_model_fn
    sfn = score_fn if score_fn is not None else _length_normalized_logprob_proxy

    # Fast path: n=1 skips sampling + scoring overhead entirely. The
    # chosen candidate is just the single completion; the score field is
    # populated so the return shape stays stable for downstream
    # consumers (entropy_budget + self_verify + the JS orchestrator).
    if n == 1:
        sole = mfn(prompt, temperature)
        sole_text = sole.get("text", "") if isinstance(sole, dict) else str(sole)
        return {
            "output": sole_text,
            "all_candidates": [sole_text],
            "scores": [float(sfn(prompt, sole))],
            "chosen_index": 0,
            "n_evaluated": 1,
        }

    candidates: list[Any] = []
    texts: list[str] = []
    scores: list[float] = []
    for _ in range(n):
        c = mfn(prompt, temperature)
        candidates.append(c)
        texts.append(c.get("text", "") if isinstance(c, dict) else str(c))
        scores.append(float(sfn(prompt, c)))

    if len(scores) != len(candidates):
        # Defensive — should be impossible given the loop above, but if a
        # subclass overrides _length_normalized_logprob_proxy to short
        # the list we surface it loudly rather than silently picking 0.
        raise RuntimeError(
            f"score_fn produced {len(scores)} scores for {len(candidates)} candidates"
        )

    chosen_index = max(range(len(scores)), key=lambda i: scores[i])
    return {
        "output": texts[chosen_index],
        "all_candidates": texts,
        "scores": scores,
        "chosen_index": int(chosen_index),
        "n_evaluated": len(candidates),
    }


__all__ = ["best_of_n"]
