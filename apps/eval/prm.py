"""
apps/eval/prm.py

Process Reward Model. Step-level rewards for reasoning chains.

An Outcome Reward Model (ORM) scores the final answer. A Process Reward
Model (PRM) scores each intermediate step in the reasoning chain. The
distinction matters for math and code: a wrong step early in the chain
can still produce the right final answer by luck; a PRM catches the bad
step.

Math-Shepherd (Wang 2023, arXiv:2312.08935) showed PRM-based best-of-N
beats ORM-based best-of-N on GSM8K and MATH at the same sample count,
because PRM rewards good reasoning even when the trajectory is unlucky.
PRM-800K (Lightman 2023, arXiv:2305.20050) released the standard 800K
human-labeled step dataset.

This module provides:

    PRMScorer       wraps a fine-tuned PRM head (or a generic LM scoring
                    each step with a yes/no logit) and exposes
                    score_steps(prompt, steps) -> [float per step].

    aggregate_prm   reduce per-step scores to one trajectory score. Modes:
                        min     trajectory fails if any step fails
                        prod    multiply step scores (Math-Shepherd default)
                        mean    average over all steps
                        last    score the final step only

    extract_steps   split a chain-of-thought completion into steps using
                    the standard delimiters: numbered lines, "Step N:",
                    double-newlines.

For training a PRM, see apps/trainer/prm_train.py (companion module — not
shipped in this wave). The scoring side is the load-bearing piece because
it plugs into apps/runtime/ttc.py best_of_n as a richer reward function.

Surface:

    from apps.eval.prm import PRMScorer, aggregate_prm, extract_steps

    scorer = PRMScorer(model_id="peiyi9979/math-shepherd-mistral-7b-prm")
    steps = extract_steps(completion_text)
    step_scores = scorer.score_steps(prompt, steps)
    traj_score = aggregate_prm(step_scores, mode="prod")

Citations:
  Math-Shepherd:    Wang et al 2023, arXiv:2312.08935
  PRM-800K:         Lightman et al 2023, arXiv:2305.20050
  Step-DPO:         Lai et al 2024, arXiv:2406.18629
  PRMBench:         Song et al 2024, arXiv:2501.03124
"""

from __future__ import annotations

import dataclasses
import logging
import math
import re
from typing import Any, Iterable, Literal, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

PRMMode = Literal["min", "prod", "mean", "last"]
VALID_MODES: tuple[str, ...] = ("min", "prod", "mean", "last")

# Standard step delimiters seen in open PRM datasets.
# Matches "Step N:" / "Step N." / "Step N)" anywhere in the text, and "N." / "N)"
# at the start of a line (multiline). The mid-string match is needed because
# many open PRM datasets serialize the chain as one long string.
_STEP_PREFIX_RE = re.compile(
    r"(?:\bstep\s*\d+[:.)]\s*|(?:^|\n)\s*\d+[.)]\s*)",
    re.IGNORECASE,
)
_DOUBLE_NEWLINE_RE = re.compile(r"\n\s*\n+")


@dataclasses.dataclass(frozen=True)
class PRMScorerConfig:
    """
    positive_token   the token whose logprob = step-is-correct score.
                     Math-Shepherd uses '+' (good) vs '-' (bad). PRM-800K
                     uses 'good' vs 'bad'.
    negative_token   the token used as the explicit-bad alternative.
    sigmoid          if True, return logistic of (pos_logit - neg_logit);
                     if False, return raw pos_logit - neg_logit.
    """

    positive_token: str = "+"
    negative_token: str = "-"
    sigmoid: bool = True
    step_separator: str = "\n\nStep "
    max_seq_length: int = 4096


def _import_transformers():
    try:
        import transformers  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "transformers is not installed. install with: "
            "pip install 'transformers>=4.45.0'"
        ) from e
    return transformers


def extract_steps(text: str) -> list[str]:
    """
    Best-effort split of a chain-of-thought completion into ordered steps.

    Tries 'Step N:' / 'N.' prefixes first, then double-newlines, then
    sentence-per-step fallback. Returns a list of cleaned step strings.
    """
    if not text:
        return []
    # Prefer numbered prefixes.
    if _STEP_PREFIX_RE.search(text):
        parts = _STEP_PREFIX_RE.split(text)
        steps = [p.strip() for p in parts if p.strip()]
        if steps:
            return steps
    # Fall back to paragraph splits.
    parts = _DOUBLE_NEWLINE_RE.split(text)
    steps = [p.strip() for p in parts if p.strip()]
    if len(steps) >= 2:
        return steps
    # Last resort: sentence-per-step (very rough).
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def aggregate_prm(step_scores: Sequence[float], *, mode: PRMMode = "prod") -> float:
    """
    Reduce per-step scores to one trajectory score.

    prod mode is Math-Shepherd's recommended default for best-of-N. It
    penalizes any single bad step (sigmoid output near 0 collapses the
    product) without being as harsh as min().
    """
    if mode not in VALID_MODES:
        raise ValueError(f"mode must be one of {VALID_MODES}, got {mode!r}")
    if not step_scores:
        return 0.0
    if mode == "min":
        return float(min(step_scores))
    if mode == "prod":
        # clamp to avoid underflow on long chains
        log_total = sum(math.log(max(s, 1e-12)) for s in step_scores)
        return float(math.exp(log_total))
    if mode == "mean":
        return float(sum(step_scores) / len(step_scores))
    if mode == "last":
        return float(step_scores[-1])
    raise AssertionError(f"unreachable: mode={mode}")


class PRMScorer:
    """
    Step-level scorer. Wraps a fine-tuned PRM (sequence-classification head)
    OR a generic LM that scores each step by comparing positive vs negative
    token logits at the step terminator.

    Two modes:

        cls       AutoModelForSequenceClassification, score = sigmoid(logit)
        token     AutoModelForCausalLM, score from logit(pos) - logit(neg)
    """

    def __init__(
        self,
        *,
        model_id: str,
        config: Optional[PRMScorerConfig] = None,
        backend: Literal["cls", "token"] = "token",
        bf16: bool = True,
    ):
        self.model_id = model_id
        self.config = config or PRMScorerConfig()
        self.backend = backend
        self._transformers = _import_transformers()
        import torch

        dtype = torch.bfloat16 if bf16 else torch.float32
        self._torch = torch
        self.tokenizer = self._transformers.AutoTokenizer.from_pretrained(model_id)
        if backend == "cls":
            self.model = (
                self._transformers.AutoModelForSequenceClassification.from_pretrained(
                    model_id, torch_dtype=dtype, device_map="auto"
                )
            )
        else:
            self.model = self._transformers.AutoModelForCausalLM.from_pretrained(
                model_id, torch_dtype=dtype, device_map="auto"
            )
        self._pos_id = self.tokenizer.encode(self.config.positive_token, add_special_tokens=False)
        self._neg_id = self.tokenizer.encode(self.config.negative_token, add_special_tokens=False)
        if backend == "token" and (not self._pos_id or not self._neg_id):
            raise ValueError(
                f"tokenizer does not produce single-token ids for "
                f"positive_token={self.config.positive_token!r} or "
                f"negative_token={self.config.negative_token!r}"
            )

    def _build_step_text(self, prompt: str, steps_so_far: Sequence[str], step: str) -> str:
        """
        Concatenate prompt + all prior steps + the step being scored,
        with the model's step separator. PRM scoring expects the model to
        see the full context up to and including the step terminator.
        """
        body = (self.config.step_separator).join([prompt, *steps_so_far, step])
        return body + self.config.step_separator

    def _score_cls(self, text: str) -> float:
        torch = self._torch
        inputs = self.tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=self.config.max_seq_length,
        ).to(self.model.device)
        with torch.inference_mode():
            logits = self.model(**inputs).logits.squeeze(-1)
        return float(torch.sigmoid(logits).cpu().item())

    def _score_token(self, text: str) -> float:
        torch = self._torch
        inputs = self.tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=self.config.max_seq_length,
        ).to(self.model.device)
        with torch.inference_mode():
            out = self.model(**inputs)
            logits = out.logits[0, -1]  # last position
        pos = float(logits[self._pos_id[0]].cpu())
        neg = float(logits[self._neg_id[0]].cpu())
        if self.config.sigmoid:
            return float(1.0 / (1.0 + math.exp(-(pos - neg))))
        return pos - neg

    def score_steps(self, prompt: str, steps: Sequence[str]) -> list[float]:
        """
        Score each step in order. Returns one float per step. The score for
        step k sees the prompt + steps 0..k-1 + step k.
        """
        scores: list[float] = []
        running: list[str] = []
        for step in steps:
            text = self._build_step_text(prompt, running, step)
            if self.backend == "cls":
                s = self._score_cls(text)
            else:
                s = self._score_token(text)
            scores.append(float(s))
            running.append(step)
        return scores


def receipt_block(
    *,
    model_id: str,
    mode: PRMMode,
    steps: int,
    step_scores: Sequence[float],
    trajectory_score: float,
) -> dict[str, Any]:
    return {
        "algo": "prm_scoring",
        "model_id": model_id,
        "mode": mode,
        "steps": int(steps),
        "step_scores": [float(s) for s in step_scores],
        "trajectory_score": float(trajectory_score),
        "papers": [
            "arXiv:2312.08935",  # Math-Shepherd
            "arXiv:2305.20050",  # PRM-800K
            "arXiv:2406.18629",  # Step-DPO
        ],
        "schema_version": "prm.v1",
    }


__all__ = [
    "PRMMode",
    "VALID_MODES",
    "PRMScorerConfig",
    "PRMScorer",
    "extract_steps",
    "aggregate_prm",
    "receipt_block",
]
