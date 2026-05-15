"""
apps/runtime/ttc.py

Test-time compute. Sample more, score, return the best.

When the prompt is hard (math, code, multi-step reasoning) and there is a way
to check the answer, spending inference-time compute on multiple samples is
cheaper than spending training-time compute on a bigger model. This module
implements the three patterns that show up in the o1 / R1 generation of
reasoning systems:

    best_of_n          sample N completions, score each with a reward fn,
                       return the arg-max. Reward fn can be a verifier (unit
                       tests, math checker) or a learned judge.

    self_consistency   sample N completions, extract the final answer from
                       each, return the majority answer. Works when the
                       answer is a small string (number, label) even though
                       the reasoning paths diverge. Wang et al 2022.

    reflexion          sample, critique, revise. Up to K rounds; stops when
                       a verifier accepts or the budget runs out. Shinn et
                       al 2023.

All three are stateless functions over a caller-supplied generate function,
so they compose with apps/runtime/serve.py (kolm's vLLM-backed server) and
with any external LLM client. The reward functions from apps/trainer/grpo.py
(code_exec, math_checker, schema_validator) plug in directly.

Surface:

    from apps.runtime.ttc import best_of_n, self_consistency, reflexion
    from apps.trainer.grpo import REWARD_FUNCTIONS

    out = best_of_n(
        generate_fn=my_generate,
        prompt="solve: ...",
        n=8,
        reward_fn=REWARD_FUNCTIONS["math_checker"],
        reward_kwargs={"references": ["42"]},
    )

The receipt block records n, the chosen index, and the score distribution
so a reviewer can see how confident the pick was.

Citations:
  Best-of-N:           Cobbe et al 2021, arXiv:2110.14168 (GSM8K verifiers)
  Self-consistency:    Wang et al 2022, arXiv:2203.11171
  Reflexion:           Shinn et al 2023, arXiv:2303.11366
  Scaling test-time:   Snell et al 2024, arXiv:2408.03314
  o1 system card:      OpenAI 2024
"""

from __future__ import annotations

import dataclasses
import logging
import re
import statistics
import time
from collections import Counter
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

GenerateFn = Callable[..., str]
RewardFn = Callable[..., list[float]]


@dataclasses.dataclass(frozen=True)
class TTCConfig:
    """Knobs shared across the three patterns."""

    n: int = 8
    temperature: float = 0.7
    top_p: float = 0.95
    max_tokens: int = 1024
    seed: Optional[int] = None
    reflexion_rounds: int = 3
    reflexion_acceptance: float = 1.0


@dataclasses.dataclass(frozen=True)
class TTCResult:
    """Stable result carrier; serialized into the receipt block."""

    completions: list[str]
    scores: list[float]
    chosen_index: int
    chosen_completion: str
    pattern: str
    wall_clock_seconds: float
    extras: Mapping[str, Any] = dataclasses.field(default_factory=dict)


def _sample_n(
    generate_fn: GenerateFn,
    prompt: str,
    *,
    n: int,
    temperature: float,
    top_p: float,
    max_tokens: int,
    seed: Optional[int],
) -> list[str]:
    """
    Sample n completions. If generate_fn accepts n=... natively (vLLM-style),
    use that; otherwise call it n times. seed is offset per call so each
    sample is distinct but the run is still reproducible.
    """
    completions: list[str] = []
    try:
        # Prefer batched API; many backends accept n= and return a list.
        out = generate_fn(
            prompt=prompt,
            n=n,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            seed=seed,
        )
        if isinstance(out, (list, tuple)) and len(out) == n:
            return [str(x) for x in out]
        # Some clients return one string with n=1 even when asked for more.
        if isinstance(out, str) and n == 1:
            return [out]
    except TypeError:
        pass

    # Per-sample fallback.
    for i in range(n):
        sub_seed = None if seed is None else int(seed) + i
        text = generate_fn(
            prompt=prompt,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            seed=sub_seed,
        )
        completions.append(str(text))
    return completions


def best_of_n(
    *,
    generate_fn: GenerateFn,
    prompt: str,
    reward_fn: RewardFn,
    n: int = 8,
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 1024,
    seed: Optional[int] = None,
    reward_kwargs: Optional[Mapping[str, Any]] = None,
) -> TTCResult:
    """
    Sample n completions, score each with reward_fn, return the highest.

    reward_fn signature follows apps/trainer/grpo.py: takes
    (prompts, completions, **kwargs) -> list[float]. We replicate prompt n
    times so the reward fn sees the same shape it sees during GRPO training.
    Reward = best-known training signal => Reward = best-known eval signal.
    This is the "reward-is-the-eval" property.
    """
    t0 = time.time()
    completions = _sample_n(
        generate_fn,
        prompt,
        n=n,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        seed=seed,
    )
    prompts_repeated = [prompt] * len(completions)
    rk = dict(reward_kwargs or {})
    scores = list(reward_fn(prompts_repeated, completions, **rk))
    if len(scores) != len(completions):
        raise RuntimeError(
            f"reward_fn returned {len(scores)} scores for {len(completions)} completions"
        )
    chosen = max(range(len(scores)), key=lambda i: scores[i])
    return TTCResult(
        completions=completions,
        scores=[float(s) for s in scores],
        chosen_index=int(chosen),
        chosen_completion=completions[chosen],
        pattern="best_of_n",
        wall_clock_seconds=time.time() - t0,
        extras={"score_mean": statistics.fmean(scores) if scores else 0.0},
    )


_ANSWER_PATTERNS = (
    re.compile(r"<answer>\s*(.+?)\s*</answer>", re.IGNORECASE | re.DOTALL),
    re.compile(r"\\boxed\{(.+?)\}"),
    re.compile(r"(?i)\b(?:final\s+)?answer\s*[:=]\s*(.+?)\s*(?:\n|$)"),
)


def _extract_short_answer(text: str) -> Optional[str]:
    """
    Pull the short answer from a chain-of-thought completion. Tries
    <answer>...</answer>, \\boxed{...}, then 'Answer: ...'. Falls back to the
    last non-empty line if none match.
    """
    for pat in _ANSWER_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return lines[-1] if lines else None


def self_consistency(
    *,
    generate_fn: GenerateFn,
    prompt: str,
    n: int = 8,
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 1024,
    seed: Optional[int] = None,
    extractor: Optional[Callable[[str], Optional[str]]] = None,
) -> TTCResult:
    """
    Sample n completions, extract the short answer from each, return the
    majority answer + the first completion that produced it.

    For temperature>0 reasoning, the chains of thought diverge but the right
    answer is a fixed point. Voting over short answers cuts variance for
    free. Wang et al 2022.
    """
    t0 = time.time()
    extractor = extractor or _extract_short_answer
    completions = _sample_n(
        generate_fn,
        prompt,
        n=n,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        seed=seed,
    )
    answers = [extractor(c) for c in completions]
    counts = Counter(a for a in answers if a is not None)
    if not counts:
        return TTCResult(
            completions=completions,
            scores=[0.0] * len(completions),
            chosen_index=0,
            chosen_completion=completions[0] if completions else "",
            pattern="self_consistency",
            wall_clock_seconds=time.time() - t0,
            extras={"counts": {}, "majority_answer": None},
        )
    majority_answer, majority_count = counts.most_common(1)[0]
    # Score each completion 1.0 if it matched the majority, else 0.0.
    scores = [1.0 if a == majority_answer else 0.0 for a in answers]
    chosen = answers.index(majority_answer)
    return TTCResult(
        completions=completions,
        scores=scores,
        chosen_index=int(chosen),
        chosen_completion=completions[chosen],
        pattern="self_consistency",
        wall_clock_seconds=time.time() - t0,
        extras={
            "counts": dict(counts),
            "majority_answer": majority_answer,
            "majority_count": int(majority_count),
            "majority_share": float(majority_count) / len(completions),
        },
    )


def reflexion(
    *,
    generate_fn: GenerateFn,
    critique_fn: Callable[[str, str], str],
    revise_fn: Callable[[str, str, str], str],
    verifier_fn: Optional[RewardFn] = None,
    prompt: str,
    rounds: int = 3,
    acceptance: float = 1.0,
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 1024,
    seed: Optional[int] = None,
    verifier_kwargs: Optional[Mapping[str, Any]] = None,
) -> TTCResult:
    """
    Sample one completion, critique it, revise. Repeat up to `rounds` times
    or until the verifier reports >= acceptance.

    critique_fn(prompt, completion) -> critique_text
    revise_fn(prompt, completion, critique) -> revised_completion
    verifier_fn(prompts, completions, **kwargs) -> [score] (same shape as
        apps/trainer/grpo.py reward fns; optional, omit to run uncapped).

    When the verifier is omitted (no ground truth), `rounds` runs to
    completion and the final completion is returned.
    """
    t0 = time.time()
    vk = dict(verifier_kwargs or {})
    trajectory: list[str] = []
    scores: list[float] = []

    completion = generate_fn(
        prompt=prompt,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        seed=seed,
    )
    trajectory.append(completion)

    if verifier_fn is not None:
        s = float(verifier_fn([prompt], [completion], **vk)[0])
        scores.append(s)
        if s >= acceptance:
            return TTCResult(
                completions=trajectory,
                scores=scores,
                chosen_index=0,
                chosen_completion=completion,
                pattern="reflexion",
                wall_clock_seconds=time.time() - t0,
                extras={"rounds_taken": 0, "acceptance": acceptance},
            )

    for r in range(1, rounds + 1):
        critique = critique_fn(prompt, completion)
        revised = revise_fn(prompt, completion, critique)
        trajectory.append(revised)
        completion = revised
        if verifier_fn is not None:
            s = float(verifier_fn([prompt], [completion], **vk)[0])
            scores.append(s)
            if s >= acceptance:
                break

    chosen_index = (
        max(range(len(scores)), key=lambda i: scores[i]) if scores else len(trajectory) - 1
    )
    return TTCResult(
        completions=trajectory,
        scores=scores if scores else [0.0] * len(trajectory),
        chosen_index=int(chosen_index),
        chosen_completion=trajectory[chosen_index],
        pattern="reflexion",
        wall_clock_seconds=time.time() - t0,
        extras={"rounds_taken": len(trajectory) - 1, "acceptance": acceptance},
    )


def receipt_block(result: TTCResult, *, prompt_hash: Optional[str] = None) -> dict[str, Any]:
    """
    Stable receipt. Records pattern, sample count, score distribution, chosen
    index, wall-clock — everything an auditor needs to replay the same TTC
    decision.
    """
    return {
        "algo": f"ttc.{result.pattern}",
        "n": len(result.completions),
        "chosen_index": result.chosen_index,
        "score_mean": (statistics.fmean(result.scores) if result.scores else 0.0),
        "score_max": (max(result.scores) if result.scores else 0.0),
        "score_min": (min(result.scores) if result.scores else 0.0),
        "wall_clock_seconds": float(result.wall_clock_seconds),
        "prompt_hash": prompt_hash,
        "extras": dict(result.extras),
        "papers": [
            "arXiv:2110.14168",  # Cobbe verifiers
            "arXiv:2203.11171",  # self-consistency
            "arXiv:2303.11366",  # reflexion
            "arXiv:2408.03314",  # scaling test-time
        ],
        "schema_version": "ttc.v1",
    }


__all__ = [
    "TTCConfig",
    "TTCResult",
    "best_of_n",
    "self_consistency",
    "reflexion",
    "receipt_block",
]
