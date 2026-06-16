"""
apps/trainer/dapo_runmeta.py

DAPO/GSPO frontier RUN-META: the receipt evidence that proves WHICH frontier RLVR
mechanisms actually engaged during a GRPO run, versus were silently dropped by the
installed trl. This module owns the four frontier mechanisms the prior build
(apps/trainer/dapo_sampling.py) did NOT yet cover, and the run-meta assembler that
stamps them into the signed .kolm receipt:

  1. Soft Overlong Punishment (DAPO sec 3.4) -- a LENGTH-GRADED reward shaper.
     Distinct from `mask_truncated_completions` (which zeroes the loss): this
     applies a soft, linearly-ramped negative penalty to completions whose length
     enters an overlong "buffer" band before the hard cap, so the model learns to
     be concise without a cliff. Implemented as a reward TRANSFORM kolm owns above
     trl's reward funcs (trl averages reward funcs; the shaper composes onto one).

  2. Per-step GROUP DIVERSITY -- fraction of non-degenerate groups per step (the
     realized, post-hoc twin of DAPO dynamic sampling). 1.0 means every group had
     reward variance (all contributed gradient); a collapsing run trends toward 0.

  3. Per-REWARD-FAMILY pass-rate curves -- one pass-rate sequence per reward
     family (code_exec / math_checker / schema_validator / ...) across steps, so
     the receipt shows WHICH capability the RL actually moved.

  4. Realized CLIP-HIGHER + DYNAMIC-SAMPLING stats -- the fraction of token ratios
     that hit the asymmetric upper clip (proves epsilon_high engaged, not just was
     requested) and the rolled-up dynamic-sampling drop accounting.

  5. vLLM generation SPEEDUP -- tokens/sec of the vLLM rollout engine vs the HF
     baseline, recorded as a ratio so the receipt proves the rollout speedup was
     REAL (or records why it was not measured).

Everything here is GPU-FREE and dependency-free at import time (NO torch / trl /
vllm / numpy at module top). The real GPU rollout/clip numbers are FED IN by the
caller (the trl callback on a real run); in preflight/tests deterministic inputs
prove the math. This keeps the receipt contract testable without a GPU.

Privacy / moat: every stamp here is COUNTS, RATES, and CONFIG only -- never raw
prompt or completion text. Scoring uses the LOCAL kolm reward/verifier code path;
no external judge, no hyperscaler call, no network import anywhere in this file.

Citations:
  DAPO:    Yu et al, 2025, arXiv:2503.14476 (Soft Overlong Punishment sec 3.4,
           Dynamic Sampling sec 3.2, Clip-Higher sec 3.1)
  GSPO:    Zheng et al, 2025, arXiv:2507.18071 (sequence importance sampling)
  GRPO:    Shao et al, 2024, arXiv:2402.03300 (DeepSeek-MATH)
  R1:      DeepSeek-AI, 2025, arXiv:2501.12948
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any, Callable, Mapping, MutableMapping, Optional, Sequence

PAPERS = ["arXiv:2503.14476", "arXiv:2507.18071", "arXiv:2503.20783", "arXiv:2402.03300"]

_SD_TOL = 1e-12


# --------------------------------------------------------------------------- #
# (1) Soft Overlong Punishment -- DAPO sec 3.4.
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class OverlongRewardShaping:
    """Length-graded soft penalty config (DAPO Soft Overlong Punishment).

    Completion length L (in TOKENS) maps to an additive penalty:

        L <= (max_length - buffer)            -> penalty 0.0  (well within budget)
        (max_length - buffer) < L < max_length-> penalty ramps LINEARLY from 0 to
                                                  -max_penalty across the buffer
        L >= max_length                       -> penalty -max_penalty (the cap)

    The penalty is ADDED to the base reward (which lives in [0,1]); the shaped
    reward is the SUM (NOT clamped to [0,1]) because a negative shaped reward is a
    meaningful "too long" signal the advantage normalizer should see.

    This is the soft companion to mask_truncated_completions: that one zeroes the
    GRADIENT on hard-truncated completions; this one shapes the REWARD on the
    soft-overlong band so conciseness is learned without a cliff.
    """

    max_length: int = 512
    buffer: int = 128
    max_penalty: float = 1.0

    def __post_init__(self) -> None:
        if not isinstance(self.max_length, int) or self.max_length < 1:
            raise ValueError("OverlongRewardShaping: max_length must be a positive int")
        if not isinstance(self.buffer, int) or self.buffer < 0:
            raise ValueError("OverlongRewardShaping: buffer must be a non-negative int")
        if self.buffer >= self.max_length:
            raise ValueError(
                "OverlongRewardShaping: buffer must be < max_length "
                f"(buffer={self.buffer}, max_length={self.max_length})"
            )
        if not (isinstance(self.max_penalty, (int, float)) and self.max_penalty >= 0):
            raise ValueError("OverlongRewardShaping: max_penalty must be >= 0")

    def penalty_for_length(self, length: int) -> float:
        """Additive penalty (<= 0) for a completion of `length` tokens."""
        if length < 0:
            raise ValueError("penalty_for_length: length must be >= 0")
        soft_start = self.max_length - self.buffer
        if length <= soft_start:
            return 0.0
        if length >= self.max_length:
            return -float(self.max_penalty)
        # Linear ramp across the buffer band.
        frac = (length - soft_start) / float(self.buffer)
        return -float(self.max_penalty) * frac

    def shape(
        self, base_rewards: Sequence[float], lengths: Sequence[int]
    ) -> list[float]:
        """Apply the soft penalty elementwise: shaped[i] = base[i] + penalty(len[i])."""
        if len(base_rewards) != len(lengths):
            raise ValueError(
                f"OverlongRewardShaping.shape: {len(base_rewards)} rewards vs "
                f"{len(lengths)} lengths"
            )
        return [float(r) + self.penalty_for_length(int(L)) for r, L in zip(base_rewards, lengths)]

    def as_meta(self) -> dict[str, Any]:
        return {
            "mechanism": "dapo_soft_overlong_punishment",
            "paper": "arXiv:2503.14476",
            "max_length": int(self.max_length),
            "buffer": int(self.buffer),
            "max_penalty": float(self.max_penalty),
            "soft_start": int(self.max_length - self.buffer),
        }


def make_overlong_shaped_reward(
    base_reward_fn: Callable[..., Sequence[float]],
    shaping: OverlongRewardShaping,
    *,
    length_fn: Optional[Callable[[str], int]] = None,
):
    """Wrap a base reward fn so its output is soft-overlong shaped.

    `length_fn` maps a completion string to a token length; default is a
    whitespace word count (real runs pass the tokenizer's length so the band is in
    true tokens). The wrapper preserves trl's reward-fn signature
    `(prompts, completions, **kwargs) -> list[float]`.
    """
    _len = length_fn or (lambda c: len((c or "").split()))

    def _wrapped(prompts, completions, *args, **kwargs):
        base = list(base_reward_fn(prompts, completions, *args, **kwargs))
        lengths = [_len(c) for c in completions]
        return shaping.shape(base, lengths)

    _wrapped.__name__ = getattr(base_reward_fn, "__name__", "reward") + "_overlong_shaped"
    return _wrapped


# --------------------------------------------------------------------------- #
# (2)-(4) Per-step run-meta accumulator (group diversity, reward-family curves,
# realized clip-higher / dynamic-sampling stats). GPU-free; the trl callback on a
# real run feeds it; tests feed deterministic numbers.
# --------------------------------------------------------------------------- #


def _population_sd(values: Sequence[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / n
    if var <= 0.0:
        return 0.0
    return math.sqrt(var)


def group_diversity(groups: Sequence[Sequence[float]]) -> dict[str, Any]:
    """Fraction of non-degenerate groups in one step.

    A group is its list of G per-completion rewards. Degenerate == sd(rewards)==0
    (all-pass / all-fail / all-equal -> zero advantage -> no gradient). Returns the
    fraction that are NON-degenerate plus the attributed degenerate breakdown.
    """
    total = len(groups)
    if total == 0:
        return {
            "groups": 0,
            "non_degenerate": 0,
            "fraction_non_degenerate": 0.0,
            "degenerate_all_pass": 0,
            "degenerate_all_fail": 0,
            "degenerate_other": 0,
        }
    non_deg = 0
    all_pass = 0
    all_fail = 0
    other = 0
    for rewards in groups:
        sd = _population_sd(list(rewards))
        if sd > _SD_TOL:
            non_deg += 1
            continue
        mean = (sum(rewards) / len(rewards)) if rewards else 0.0
        if mean >= 1.0 - _SD_TOL:
            all_pass += 1
        elif mean <= _SD_TOL:
            all_fail += 1
        else:
            other += 1
    return {
        "groups": total,
        "non_degenerate": non_deg,
        "fraction_non_degenerate": round(non_deg / total, 6),
        "degenerate_all_pass": all_pass,
        "degenerate_all_fail": all_fail,
        "degenerate_other": other,
    }


def clip_higher_stats(
    ratios: Sequence[float],
    *,
    epsilon_low: float,
    epsilon_high: float,
) -> dict[str, Any]:
    """Realized Clip-Higher engagement for one step.

    `ratios` are the per-token importance ratios pi/pi_old (token level) or the
    per-sequence ratios (GSPO). Reports the fraction clipped at the asymmetric
    UPPER bound (1+epsilon_high) and LOWER bound (1-epsilon_low). A nonzero upper
    fraction with epsilon_high>epsilon_low is the receipt-grade proof that
    asymmetric Clip-Higher actually engaged (not merely was configured).
    """
    if epsilon_high < 0 or epsilon_low < 0:
        raise ValueError("clip_higher_stats: epsilon bounds must be >= 0")
    n = len(ratios)
    if n == 0:
        return {
            "tokens": 0,
            "clipped_high": 0,
            "clipped_low": 0,
            "fraction_clipped_high": 0.0,
            "fraction_clipped_low": 0.0,
            "epsilon_low": float(epsilon_low),
            "epsilon_high": float(epsilon_high),
            "asymmetric": bool(epsilon_high > epsilon_low),
        }
    hi = 1.0 + epsilon_high
    lo = 1.0 - epsilon_low
    clipped_high = sum(1 for r in ratios if r > hi)
    clipped_low = sum(1 for r in ratios if r < lo)
    return {
        "tokens": n,
        "clipped_high": clipped_high,
        "clipped_low": clipped_low,
        "fraction_clipped_high": round(clipped_high / n, 6),
        "fraction_clipped_low": round(clipped_low / n, 6),
        "epsilon_low": float(epsilon_low),
        "epsilon_high": float(epsilon_high),
        "asymmetric": bool(epsilon_high > epsilon_low),
    }


class RunMetaAccumulator:
    """Per-step run-meta recorder for one GRPO run.

    The trl callback (on a real GPU run) calls record_step(...) once per optimizer
    step with the step's groups, per-family pass results, and realized clip ratios.
    In tests, deterministic inputs prove the curves. summary() rolls the per-step
    series into the additive `run_meta` receipt block.

    Stamps ONLY counts/rates/config -- never raw text (privacy/moat).
    """

    def __init__(
        self,
        *,
        epsilon_low: float = 0.2,
        epsilon_high: float = 0.0,
        importance_sampling_level: str = "token",
        loss_type: str = "dapo",
    ) -> None:
        self.epsilon_low = float(epsilon_low)
        self.epsilon_high = float(epsilon_high)
        self.importance_sampling_level = str(importance_sampling_level)
        self.loss_type = str(loss_type)
        self._steps: list[dict[str, Any]] = []
        # per reward-family: list of (passed, total) per step.
        self._family_curves: dict[str, list[dict[str, float]]] = {}

    def record_step(
        self,
        step: int,
        *,
        groups: Sequence[Sequence[float]],
        family_pass: Optional[Mapping[str, Sequence[float]]] = None,
        ratios: Optional[Sequence[float]] = None,
        reward_mean: Optional[float] = None,
    ) -> dict[str, Any]:
        """Record one optimizer step.

        groups:       list of per-group reward lists (for group diversity).
        family_pass:  {family_name: [reward,...]} this step; pass-rate = mean of a
                      binarized (>= 0.5) per-completion reward, so partial-credit
                      reward funcs still yield a stable pass-rate curve.
        ratios:       per-token (or per-sequence) importance ratios for clip stats.
        reward_mean:  optional realized mean reward for the step.
        """
        gd = group_diversity(groups)
        ch = clip_higher_stats(
            list(ratios) if ratios is not None else [],
            epsilon_low=self.epsilon_low,
            epsilon_high=self.epsilon_high,
        )
        fam_rates: dict[str, float] = {}
        if family_pass:
            for fam, rewards in family_pass.items():
                rl = list(rewards)
                rate = (
                    sum(1 for r in rl if r >= 0.5 - _SD_TOL) / len(rl) if rl else 0.0
                )
                fam_rates[fam] = round(rate, 6)
                self._family_curves.setdefault(fam, []).append(
                    {"step": int(step), "pass_rate": round(rate, 6), "n": len(rl)}
                )
        rec = {
            "step": int(step),
            "group_diversity": gd,
            "clip_higher": ch,
            "family_pass_rate": fam_rates,
            "reward_mean": (float(reward_mean) if reward_mean is not None else None),
        }
        self._steps.append(rec)
        return rec

    def _curve(self, key_path: Callable[[dict[str, Any]], float]) -> list[float]:
        return [key_path(s) for s in self._steps]

    def summary(self) -> dict[str, Any]:
        """Roll the per-step series into the additive run_meta receipt block."""
        steps = len(self._steps)
        diversity_curve = self._curve(
            lambda s: s["group_diversity"]["fraction_non_degenerate"]
        )
        clip_high_curve = self._curve(
            lambda s: s["clip_higher"]["fraction_clipped_high"]
        )
        mean_diversity = (sum(diversity_curve) / steps) if steps else 0.0
        # clip_higher_engaged: asymmetric AND at least one step actually clipped high.
        any_clipped_high = any(c > 0.0 for c in clip_high_curve)
        asymmetric = self.epsilon_high > self.epsilon_low
        return {
            "schema": "kolm.rlvr.run_meta.v1",
            "papers": PAPERS,
            "steps_recorded": steps,
            "loss_type": self.loss_type,
            "importance_sampling_level": self.importance_sampling_level,
            "epsilon_low": self.epsilon_low,
            "epsilon_high": self.epsilon_high,
            "group_diversity": {
                "mechanism": "per_step_group_diversity",
                "curve": [round(v, 6) for v in diversity_curve],
                "mean_fraction_non_degenerate": round(mean_diversity, 6),
            },
            "clip_higher": {
                "mechanism": "realized_clip_higher",
                "paper": "arXiv:2503.14476",
                "asymmetric_configured": bool(asymmetric),
                "engaged": bool(asymmetric and any_clipped_high),
                "fraction_clipped_high_curve": [round(v, 6) for v in clip_high_curve],
            },
            "reward_family_curves": {
                fam: list(series) for fam, series in self._family_curves.items()
            },
        }


# --------------------------------------------------------------------------- #
# (5) vLLM generation speedup recorder.
# --------------------------------------------------------------------------- #


def generation_speedup(
    *,
    vllm_tokens: int,
    vllm_seconds: float,
    hf_tokens: int,
    hf_seconds: float,
) -> dict[str, Any]:
    """Recorded vLLM-vs-HF rollout speedup (tokens/sec ratio).

    Both legs must come from a REAL timed generation on this box (the caller times
    them). Returns tokens/sec for each engine and the speedup ratio. Refuses to
    fabricate: a zero/negative duration raises (the receipt never carries an
    invented speedup).
    """
    if vllm_seconds <= 0 or hf_seconds <= 0:
        raise ValueError("generation_speedup: durations must be > 0 (real timings)")
    if vllm_tokens < 0 or hf_tokens < 0:
        raise ValueError("generation_speedup: token counts must be >= 0")
    vllm_tps = vllm_tokens / vllm_seconds
    hf_tps = hf_tokens / hf_seconds
    ratio = (vllm_tps / hf_tps) if hf_tps > 0 else None
    return {
        "mechanism": "vllm_generation_speedup",
        "vllm_tokens_per_sec": round(vllm_tps, 4),
        "hf_tokens_per_sec": round(hf_tps, 4),
        "speedup_ratio": (round(ratio, 4) if ratio is not None else None),
        "vllm_tokens": int(vllm_tokens),
        "vllm_seconds": round(float(vllm_seconds), 6),
        "hf_tokens": int(hf_tokens),
        "hf_seconds": round(float(hf_seconds), 6),
    }


def speedup_not_measured(reason: str, *, hint: Optional[str] = None) -> dict[str, Any]:
    """Receipt-grade record for when the speedup was NOT measured (fail-loud, not
    a fabricated number). Used when vLLM is env-gated off or the HF baseline leg
    was skipped."""
    out = {
        "mechanism": "vllm_generation_speedup",
        "measured": False,
        "reason": str(reason),
        "speedup_ratio": None,
    }
    if hint:
        out["hint"] = str(hint)
    return out


# --------------------------------------------------------------------------- #
# Run-meta assembler -- folds everything into the additive receipt block.
# --------------------------------------------------------------------------- #


def assemble_run_meta(
    *,
    accumulator: Optional["RunMetaAccumulator"] = None,
    overlong: Optional["OverlongRewardShaping"] = None,
    speedup: Optional[Mapping[str, Any]] = None,
    dynamic_sampling_stats: Optional[Mapping[str, Any]] = None,
    engaged: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Assemble the additive `run_meta` receipt block proving which frontier
    mechanisms ENGAGED. Pure assembly of counts/rates/config; no raw text."""
    block: dict[str, Any] = {
        "schema": "kolm.rlvr.run_meta.v1",
        "papers": PAPERS,
    }
    if accumulator is not None:
        block.update(accumulator.summary())
    if overlong is not None:
        block["overlong_reward_shaping"] = overlong.as_meta()
    if dynamic_sampling_stats is not None:
        block["dynamic_sampling"] = dict(dynamic_sampling_stats)
    if speedup is not None:
        block["generation_speedup"] = dict(speedup)
    if engaged is not None:
        # engaged is the reflect_engaged() map from dapo_sampling.py -- it proves
        # per-knob whether trl accepted the request. We fold it in verbatim.
        block["engaged"] = dict(engaged)
    return block


# --------------------------------------------------------------------------- #
# GPU-free preflight CLI: `python -m apps.trainer.dapo_runmeta --preflight`
# emits a deterministic run_meta sample proving the contract without a GPU.
# --------------------------------------------------------------------------- #


def _preflight_sample() -> dict[str, Any]:
    acc = RunMetaAccumulator(epsilon_low=0.2, epsilon_high=0.28, loss_type="dapo",
                             importance_sampling_level="sequence")
    # Step 0: 3 groups, 2 diverse + 1 all-pass; one upper-clipped ratio.
    acc.record_step(
        0,
        groups=[[1.0, 0.0, 1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [1.0, 1.0, 1.0, 1.0]],
        family_pass={"code_exec": [1.0, 0.0, 1.0, 0.0], "math_checker": [0.0, 1.0]},
        ratios=[1.0, 1.05, 1.40, 0.5],
        reward_mean=0.5,
    )
    acc.record_step(
        1,
        groups=[[1.0, 0.0, 1.0, 0.0], [0.0, 1.0, 1.0, 0.0]],
        family_pass={"code_exec": [1.0, 1.0, 1.0, 0.0], "math_checker": [1.0, 1.0]},
        ratios=[1.0, 1.31, 1.10, 0.6],
        reward_mean=0.625,
    )
    overlong = OverlongRewardShaping(max_length=512, buffer=128, max_penalty=1.0)
    speedup = generation_speedup(
        vllm_tokens=200000, vllm_seconds=10.0, hf_tokens=200000, hf_seconds=85.0
    )
    return assemble_run_meta(accumulator=acc, overlong=overlong, speedup=speedup)


def _main(argv=None) -> int:
    import argparse
    import json

    p = argparse.ArgumentParser(description="DAPO/GSPO run-meta preflight (GPU-free)")
    p.add_argument("--preflight", action="store_true", default=True)
    p.parse_args(argv)
    print(json.dumps({"ok": True, "run_meta": _preflight_sample()}))
    return 0


__all__ = [
    "PAPERS",
    "OverlongRewardShaping",
    "make_overlong_shaped_reward",
    "group_diversity",
    "clip_higher_stats",
    "RunMetaAccumulator",
    "generation_speedup",
    "speedup_not_measured",
    "assemble_run_meta",
]


if __name__ == "__main__":
    import sys as _sys
    _sys.exit(_main())
