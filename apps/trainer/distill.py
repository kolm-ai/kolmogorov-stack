"""
apps/trainer/distill.py

Response distillation. Train a small student to imitate a large teacher by
matching the teacher's next-token distribution at every position, not just its
sampled token.

This is the compression idea behind the kolm brand: describe a system with the
shortest reliable program that reproduces it. Response distillation compresses
a 70B teacher's behavior into
a 3B student that emits the same token distribution on the buyer's prompts.

The pipeline is:

    teacher_logits = teacher(prompt + response, temperature=T)
    student_logits = student(prompt + response, temperature=T)
    L_kd = KL(softmax(student/T) || softmax(teacher/T)) * T^2

Plus a small cross-entropy term against the teacher's sampled token so the
student still learns the surface form, not only the distribution shape:

    L = alpha * L_kd + (1 - alpha) * L_ce

The standard recipe is alpha = 0.9, T = 2.0. The student is a LoRA adapter
on a smaller base; the teacher runs once per batch with `torch.no_grad()`.

References:

  * Hinton, Vinyals & Dean, 2015. "Distilling the Knowledge in a Neural
    Network." arXiv:1503.02531. The original soft-label KD recipe.
  * Kim & Rush, 2016. "Sequence-Level Knowledge Distillation."
    arXiv:1606.07947. Sequence-level KD; teacher's argmax becomes student's
    target. The trade-off vs token-level we navigate below.
  * Gou et al, 2021. "Knowledge Distillation: A Survey." arXiv:2006.05525.
  * Agarwal et al, 2024. "On-Policy Distillation of Language Models."
    arXiv:2306.13649. Why training on the student's own samples beats
    training on the teacher's when the gap is large.
  * Gu et al, 2024. "MiniLLM: Knowledge Distillation of Large Language
    Models." arXiv:2306.08543. Reverse-KL formulation that keeps the
    student from over-spreading mass.

Surface:

    from apps.trainer.distill import distill_trainer, DistillConfig, KDObjective

    trainer = distill_trainer(
        teacher_model="Qwen/Qwen2.5-14B-Instruct",
        student_model="Qwen/Qwen2.5-3B-Instruct",
        train_jsonl="captures.jsonl",
        out_dir="distilled/",
        config=DistillConfig(
            temperature=2.0,
            alpha=0.9,
            objective=KDObjective.FORWARD_KL,
            top_k=0,
            on_policy=False,
        ),
    )
    trainer.train()

Input JSONL shape (one line per prompt):

    {"prompt": "...", "response": "..."}  # response is optional; if absent, teacher samples one

Receipt records the teacher CID, the temperature, the KD objective, the alpha,
the final KL value, and the student's perplexity on a held-out split.
"""

from __future__ import annotations

import argparse
import enum
import json
import math
import os
import random
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import torch
    import torch.nn.functional as F
    from torch.utils.data import Dataset, WeightedRandomSampler
    _HAS_TORCH = True
except Exception:
    _HAS_TORCH = False


# W711-2/-3 — importance-weighted sampling + run-meta feedback bit.
#
# When the CLI passes --importance-weights /path/to/weights.jsonl, we wrap
# the underlying train sampler in torch.utils.data.WeightedRandomSampler so
# captures with high importance score are oversampled. The weights JSONL is
# produced by src/capture-importance.js (CLI side) and has one row per
# training capture: {"capture_id": "...", "importance": float in [0, 1]}.
#
# Honesty contracts:
#   * When the flag is omitted, the default sampler is preserved verbatim.
#   * When the flag is present but the JSONL is empty / malformed / has no
#     overlap with the training set, we DOWNGRADE to default sampling and
#     stamp the run-meta with {importance_weights_used: false,
#     importance_weights_skipped_reason: "<reason>"} — never silently fake
#     "weighted" runs.
#   * After training, we write a feedback block to run-meta.importance.json
#     so each run records whether weighting helped. W741 aggregates these.

IMPORTANCE_VERSION = "w711-v1"

# W712 — progressive distillation + capability gating.
#
# Three-pass curriculum. Pass-1 trains on ALL captures (format/tone/structure);
# pass-2 narrows to rows with reasoning_trace or token_count > 200 (multi-step
# proxy); pass-3 trains on a caller-provided failure slice (passed via the
# JSONL itself — the CLI side filters before invocation). At each pass the
# K-Score axis gate is evaluated AFTER training to decide whether to advance.
#
# Honesty contracts:
#   * --pass=N filters the training JSONL in-process. The filter NEVER throws;
#     a row missing both reasoning_trace and a usable token count is silently
#     dropped from pass-2 (the CLI's own progress envelope warns about the
#     dropped count via captures_remaining).
#   * --gate=<axis> is a label only — the trainer doesn't compute the gate
#     itself (that's the JS CLI's job after reading run-meta.json). We stamp
#     the requested gate label into run-meta.progressive.json so an operator
#     reading the artifact later can see which curriculum stage produced it.
#   * Without --pass, behavior is UNCHANGED (preserves W711 + base contract).

PROGRESSIVE_VERSION = "w712-v1"

PROGRESSIVE_GATES = {
    1: {"axis": "F", "threshold": 0.65, "label": "format"},
    2: {"axis": "R", "threshold": 0.60, "label": "reasoning"},
    3: {"axis": "E", "threshold": 0.55, "label": "edge"},
}

PROGRESSIVE_MULTI_STEP_TOKEN_FLOOR = 200


def _progressive_token_count(row: dict) -> int:
    """Best-effort token estimator for a training row (no torch needed).

    Whitespace-split underestimates BPE counts by ~1.3x, but we only need
    a ratio against MULTI_STEP_TOKEN_FLOOR, so the underestimate is fine."""
    tc = row.get("token_count")
    if isinstance(tc, (int, float)):
        return int(tc)
    tk = row.get("tokens")
    if isinstance(tk, (int, float)):
        return int(tk)
    resp = row.get("response", "")
    if not isinstance(resp, str) or not resp:
        return 0
    return sum(1 for t in resp.split() if t)


def _progressive_filter_rows(rows: list[dict], pass_num: int) -> list[dict]:
    """Apply the --pass filter to the loaded JSONL rows.

    Pass 1: pass-through (uniform).
    Pass 2: keep rows where reasoning_trace is non-null OR token_count > 200.
    Pass 3: pass-through (the CLI already filtered to pass-2 failures before
            handing us the JSONL — see cmdDistillProgressive in cli/kolm.js).
    """
    if not isinstance(rows, list) or pass_num not in (1, 2, 3):
        return rows or []
    if pass_num == 1:
        return rows
    if pass_num == 2:
        out: list[dict] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            if r.get("reasoning_trace") is not None:
                out.append(r)
                continue
            if _progressive_token_count(r) > PROGRESSIVE_MULTI_STEP_TOKEN_FLOOR:
                out.append(r)
        return out
    # pass_num == 3 — passthrough.
    return rows


def _write_progressive_run_meta(
    out_dir: str,
    pass_num: int,
    gate_label: str | None,
    n_before: int,
    n_after: int,
) -> Optional[str]:
    """Write a sibling run-meta.progressive.json so the curriculum stage is
    recoverable independent of the main HF Trainer state.

    Mirrors the W711 _write_importance_run_meta pattern: best-effort write,
    OSError is logged not raised."""
    if not out_dir:
        return None
    gate_spec = PROGRESSIVE_GATES.get(pass_num)
    meta = {
        "progressive_version": PROGRESSIVE_VERSION,
        "pass": pass_num,
        "gate_axis": gate_spec["axis"] if gate_spec else None,
        "gate_threshold": gate_spec["threshold"] if gate_spec else None,
        "gate_label_requested": gate_label,
        "captures_in": int(n_before),
        "captures_after_filter": int(n_after),
    }
    try:
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, "run-meta.progressive.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        return p
    except OSError as e:
        print(
            f"distill.py: could not write run-meta.progressive.json: {e}",
            file=sys.stderr,
        )
        return None


def _load_importance_weights_jsonl(path: str) -> dict[str, float]:
    """Load a weights JSONL into a {capture_id: importance} dict.

    Malformed rows are SKIPPED with a warning; we never abort the run for a
    bad weights file. The hooked-in sampler downgrades cleanly to uniform
    if the dict ends up empty (see _build_weighted_sampler)."""
    if not path:
        return {}
    weights: dict[str, float] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as e:
                    print(
                        f"distill.py: importance weights {path}:{ln} malformed JSON; skipping ({e.msg})",
                        file=sys.stderr,
                    )
                    continue
                cid = obj.get("capture_id")
                imp = obj.get("importance")
                if not isinstance(cid, str) or not isinstance(imp, (int, float)):
                    print(
                        f"distill.py: importance weights {path}:{ln} missing capture_id/importance; skipping",
                        file=sys.stderr,
                    )
                    continue
                # Clamp into [0, 1]; the JS side already clamps but defense-in-depth.
                weights[cid] = max(0.0, min(1.0, float(imp)))
    except FileNotFoundError:
        print(
            f"distill.py: --importance-weights file not found: {path}",
            file=sys.stderr,
        )
        return {}
    except OSError as e:
        print(
            f"distill.py: --importance-weights read failed: {path}: {e}",
            file=sys.stderr,
        )
        return {}
    return weights


def _build_weighted_sampler(rows: list[dict], weights: dict[str, float]):
    """Map per-row importance scores to a WeightedRandomSampler.

    Returns (sampler, n_matched, n_total). When weights is empty OR no row
    has a matching capture_id, returns (None, 0, len(rows)) so the caller
    can fall back to default sampling and stamp the skip reason."""
    if not _HAS_TORCH or not weights or not rows:
        return None, 0, len(rows) if rows else 0
    per_row: list[float] = []
    matched = 0
    for r in rows:
        cid = r.get("capture_id") or r.get("id") or r.get("event_id") or r.get("trace_id")
        if cid and cid in weights:
            per_row.append(float(weights[cid]))
            matched += 1
        else:
            # Unmatched rows still need a weight — neutral midpoint preserves
            # them in the sample so the trainer doesn't drop unweighted data.
            per_row.append(0.5)
    if matched == 0:
        return None, 0, len(rows)
    # Ensure no all-zero weights (degenerate sampler); replace with small eps.
    if sum(per_row) <= 0:
        per_row = [1e-6 for _ in per_row]
    weights_tensor = torch.as_tensor(per_row, dtype=torch.double)
    sampler = WeightedRandomSampler(
        weights=weights_tensor,
        num_samples=len(per_row),
        replacement=True,
    )
    return sampler, matched, len(rows)


def _write_importance_run_meta(out_dir: str, meta: dict) -> Optional[str]:
    """Write a sibling run-meta.importance.json so the importance trail is
    recoverable independent of the main HF Trainer state."""
    if not out_dir:
        return None
    try:
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, "run-meta.importance.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        return p
    except OSError as e:
        print(
            f"distill.py: could not write run-meta.importance.json: {e}",
            file=sys.stderr,
        )
        return None


class KDObjective(str, enum.Enum):
    """Which divergence to minimize between student and teacher."""
    FORWARD_KL = "forward_kl"
    REVERSE_KL = "reverse_kl"
    JSD = "jsd"

    @classmethod
    def from_str(cls, s: str) -> "KDObjective":
        s = (s or "").strip().lower()
        for o in cls:
            if o.value == s:
                return o
        raise ValueError(
            f"distill.py: unknown KD objective '{s}'. "
            f"Pick one of: {[o.value for o in cls]}"
        )


@dataclass
class DistillConfig:
    """All knobs the KD recipe takes. Defaults are the Hinton 2015 values
    plus a few modern additions (top-k logit pruning, on-policy sampling)."""

    temperature: float = 2.0
    """Softmax temperature for both teacher and student during KD. Higher
    spreads probability mass across more tokens; the canonical T=2.0 keeps
    the second-best alternative visible without flattening the distribution."""

    alpha: float = 0.9
    """Weight on the KD term. The remaining (1 - alpha) goes to a standard
    cross-entropy loss against the teacher's argmax. alpha=1.0 is pure
    distillation; alpha=0.0 is pure SFT against teacher samples."""

    objective: KDObjective = KDObjective.FORWARD_KL
    """forward_kl is Hinton's original. reverse_kl is the MiniLLM formulation,
    which keeps the student from spreading mass across modes the teacher
    rejects. jsd is the symmetric variant."""

    top_k: int = 0
    """If > 0, only the top-k teacher logits enter the KL term; the rest are
    renormalized into a single 'other' bucket. Saves memory when the teacher
    vocabulary is large; mildly degrades quality. 0 = full distribution."""

    on_policy: bool = False
    """If True, sample the response from the student instead of using the
    teacher's response or a captured ground-truth. Reduces train/test
    distribution mismatch but doubles forward-pass cost. Agarwal 2024 shows
    on-policy KD beats off-policy KD when the student is small."""

    learning_rate: float = 1e-4
    """LoRA-friendly LR. Lower than SFT because the gradient magnitude is
    larger (the loss is a divergence, not a cross-entropy)."""

    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.0
    target_modules: tuple[str, ...] = ("q_proj", "k_proj", "v_proj", "o_proj")

    max_length: int = 2048
    batch_size: int = 4
    grad_accum: int = 4
    num_epochs: int = 1
    warmup_ratio: float = 0.03
    seed: int = 42
    bf16: bool = True
    save_steps: int = 200
    eval_split: float = 0.05


# -- Loss functions. Each one takes student_logits and teacher_logits at the
# response positions (after masking out the prompt) and returns a scalar loss.

def _forward_kl(student_logits, teacher_logits, T: float):
    """KL(student || teacher) with temperature. The Hinton 2015 recipe.

    The T^2 factor comes from the chain rule on softmax/T; without it the
    gradient magnitude shrinks as T grows and the loss stops being a useful
    training signal."""
    log_p_s = F.log_softmax(student_logits / T, dim=-1)
    p_t = F.softmax(teacher_logits / T, dim=-1)
    return F.kl_div(log_p_s, p_t, reduction="batchmean") * (T * T)


def _reverse_kl(student_logits, teacher_logits, T: float):
    """KL(teacher || student). MiniLLM formulation. Penalizes the student for
    placing mass where the teacher puts none. Keeps the student from
    over-hedging on modes the teacher rejects."""
    log_p_t = F.log_softmax(teacher_logits / T, dim=-1)
    p_s = F.softmax(student_logits / T, dim=-1)
    return F.kl_div(log_p_t, p_s, reduction="batchmean") * (T * T)


def _jensen_shannon(student_logits, teacher_logits, T: float):
    """Symmetric: 0.5 * KL(s||m) + 0.5 * KL(t||m) where m = (s+t)/2.

    JSD is bounded in [0, log 2], which gives stable gradients when the
    two distributions are far apart. Slightly more expensive (three softmaxes)."""
    p_s = F.softmax(student_logits / T, dim=-1)
    p_t = F.softmax(teacher_logits / T, dim=-1)
    p_m = 0.5 * (p_s + p_t)
    log_p_m = (p_m + 1e-10).log()
    kl_sm = F.kl_div(log_p_m, p_s, reduction="batchmean", log_target=False)
    kl_tm = F.kl_div(log_p_m, p_t, reduction="batchmean", log_target=False)
    return 0.5 * (kl_sm + kl_tm) * (T * T)


_KD_FNS = {
    KDObjective.FORWARD_KL: _forward_kl,
    KDObjective.REVERSE_KL: _reverse_kl,
    KDObjective.JSD: _jensen_shannon,
}


def _topk_prune(student_logits, teacher_logits, k: int):
    """Keep only the top-k teacher tokens (by teacher prob) and dump the rest
    into a single 'other' bucket on both sides. Returns reduced logits that
    can be fed straight into the loss functions above."""
    if k <= 0 or k >= teacher_logits.size(-1):
        return student_logits, teacher_logits
    _, idx = torch.topk(teacher_logits, k=k, dim=-1)
    t_top = teacher_logits.gather(-1, idx)
    s_top = student_logits.gather(-1, idx)
    # 'Other' bucket: log-sum-exp of the rest.
    mask = torch.ones_like(teacher_logits, dtype=torch.bool)
    mask.scatter_(-1, idx, False)
    t_other = teacher_logits.masked_fill(~mask, float("-inf")).logsumexp(dim=-1, keepdim=True)
    s_other = student_logits.masked_fill(~mask, float("-inf")).logsumexp(dim=-1, keepdim=True)
    return torch.cat([s_top, s_other], dim=-1), torch.cat([t_top, t_other], dim=-1)


class _PromptResponseDataset:
    """Pure-Python dataset; transformers Trainer wraps it via DataCollatorForLM.

    Each row produces a tokenized (input_ids, labels) where labels masks the
    prompt positions with -100. The KD loss is only computed on response
    tokens; the teacher CE on the same span.
    """

    def __init__(self, rows: list[dict], tokenizer, max_length: int):
        self.rows = rows
        self.tok = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i: int) -> dict:
        row = self.rows[i]
        prompt = row["prompt"]
        response = row.get("response", "")
        # Tokenize prompt and response separately so we can mask prompt positions.
        p_ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
        r_ids = self.tok(response, add_special_tokens=False)["input_ids"]
        input_ids = p_ids + r_ids
        labels = ([-100] * len(p_ids)) + r_ids
        # Truncate from the left of the prompt if needed.
        if len(input_ids) > self.max_length:
            over = len(input_ids) - self.max_length
            input_ids = input_ids[over:]
            labels = labels[over:]
        return {
            "input_ids": input_ids,
            "labels": labels,
            "attention_mask": [1] * len(input_ids),
        }


def _load_jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"distill.py: malformed JSONL at {path}:{ln}: {e.msg}") from e
            if "prompt" not in obj or not isinstance(obj["prompt"], str):
                raise ValueError(
                    f"distill.py: {path}:{ln} missing string field 'prompt'. "
                    f"Required shape: {{'prompt', 'response'?}}."
                )
            rows.append(obj)
    if not rows:
        raise ValueError(f"distill.py: no rows in {path}")
    return rows


@dataclass
class DistillSession:
    teacher_model: str
    student_model: str
    config: DistillConfig
    n_train: int
    n_eval: int
    _trainer: Any = None
    # W258-ML-5: refs the trainer doesn't expose. We walk the eval set
    # against both teacher and student post-train to emit holdout
    # accuracies into the receipt block (anchoring T = student/teacher).
    _teacher: Any = None
    _tokenizer: Any = None
    _eval_rows: Any = None
    # W711-2/-3: importance-weighting metadata + a path the train() method
    # appends the feedback block to.
    _importance_meta: dict = field(default_factory=dict)
    _importance_meta_path: Optional[str] = None
    _importance_weights: dict = field(default_factory=dict)
    _train_rows: Any = None
    _out_dir: Optional[str] = None

    def train(self) -> dict[str, Any]:
        if self._trainer is None:
            raise RuntimeError("distill.py: train() called before trainer was built")
        result = self._trainer.train()
        summary = {
            "loss_final": float(result.training_loss) if result.training_loss is not None else None,
            "global_step": int(result.global_step),
        }
        try:
            metrics = self._trainer.evaluate()
            summary["ppl_eval"] = float(math.exp(metrics["eval_loss"])) if "eval_loss" in metrics else None
        except Exception:
            summary["ppl_eval"] = None
        # W258-ML-5: token-level holdout accuracy. computeKScoreV2 needs both
        # `holdout_accuracy` (the student's score on the held-out split,
        # input to R = robustness) and `teacher_holdout_accuracy` (the
        # teacher's score on the SAME split, input to T = teacher fidelity).
        # Without these the K-score v2 R / T axes redistribute their weight
        # away and the manifest never anchors the distillation honesty claim.
        accs = self._evaluate_holdout_accuracies()
        if accs is not None:
            summary["student_token_accuracy"] = accs["student"]
            summary["teacher_token_accuracy"] = accs["teacher"]
            summary["holdout_token_count"] = accs["count"]
        # W711-3 feedback bit: compute the per-capture loss estimates and
        # write them into run-meta.importance.json so downstream aggregation
        # (planned W741) can answer "did importance weighting actually help?"
        # across many runs.
        feedback = self._compute_importance_feedback(summary)
        if feedback is not None:
            summary["importance_feedback"] = feedback
            self._persist_importance_feedback(feedback)
        return summary

    def _compute_importance_feedback(self, summary: dict) -> Optional[dict]:
        """Estimate the loss with vs. without importance weighting.

        We don't have a real counterfactual (we'd have to re-run training
        from scratch with default sampling), so the "without-weights
        estimate" is the UNWEIGHTED mean of the per-row weights' contribution
        — explicitly labeled an estimator, not a control. W741 will tighten
        this when it can correlate run-meta deltas across many runs."""
        if not self._importance_meta or not self._importance_meta.get("importance_weights_used"):
            return None
        final_loss = summary.get("loss_final")
        if final_loss is None:
            return None
        weights = list(self._importance_weights.values()) if self._importance_weights else []
        if not weights:
            return {
                "final_loss_with_weights": float(final_loss),
                "final_loss_without_weights_estimate": float(final_loss),
                "delta_loss_estimate": 0.0,
                "estimator_note": "no per-capture weights available; estimator collapses to identity",
            }
        # If high-importance rows had been DOWN-weighted (i.e. uniform), the
        # contribution per row would be 1/N each instead of w_i / sum(w_i).
        # The expected loss ratio under that uniform reweighting is roughly
        # (sum(w_i)/N) / (mean(w_i)) = 1.0 — exactly identity for a flat
        # mean-loss objective. But if the loss is correlated with importance
        # (more pedagogically valuable rows have higher per-row loss until
        # the student catches up), the unweighted estimate is HIGHER. We
        # surface a simple ratio so a future aggregator can fit the
        # correlation across runs without assuming the relationship now.
        mean_w = sum(weights) / len(weights)
        weighted_concentration = max(weights) / (mean_w + 1e-9)
        # Heuristic estimator: the larger the concentration of high weights,
        # the larger the assumed gap between weighted and unweighted loss.
        # Bounded conservatively: never claim more than a 10% delta from a
        # single-run estimator with no counterfactual.
        delta_estimate = float(final_loss) * 0.05 * min(1.0, (weighted_concentration - 1.0) / 4.0)
        return {
            "final_loss_with_weights": float(final_loss),
            "final_loss_without_weights_estimate": float(final_loss) + max(0.0, delta_estimate),
            "delta_loss_estimate": float(delta_estimate),
            "estimator_note": (
                "single-run estimator without counterfactual; "
                "negative delta = weighting helped, positive = no signal; "
                "aggregate across runs (planned W741) for a real control"
            ),
            "weight_concentration_max_over_mean": float(weighted_concentration),
            "n_weights": len(weights),
        }

    def _persist_importance_feedback(self, feedback: dict) -> None:
        """Append the feedback block to run-meta.importance.json.

        We read-merge-write so the pre-train metadata (which has the
        importance_weights_used / importance_jsonl_path fields) is preserved.
        Silent OSError is acceptable here — the feedback is also in the
        train summary, which the caller is free to log elsewhere."""
        if not self._importance_meta_path:
            return
        existing: dict = {}
        try:
            with open(self._importance_meta_path, "r", encoding="utf-8") as f:
                existing = json.load(f) or {}
        except (OSError, json.JSONDecodeError):
            existing = dict(self._importance_meta or {})
        existing["importance_feedback"] = feedback
        try:
            with open(self._importance_meta_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2, sort_keys=True)
        except OSError as e:
            print(
                f"distill.py: could not append importance_feedback to {self._importance_meta_path}: {e}",
                file=sys.stderr,
            )

    def _evaluate_holdout_accuracies(self) -> Optional[dict[str, Any]]:
        """Walk eval rows; for each, run teacher and student on prompt+response
        and compute token-level top-1 accuracy on the RESPONSE positions only.

        Returns {"teacher": float, "student": float, "count": int} or None
        when eval set is empty / torch absent. The two ratios share the same
        denominator so they're comparable as input to T = student/teacher.
        """
        if not _HAS_TORCH or not self._eval_rows or self._teacher is None or self._tokenizer is None:
            return None
        try:
            student_model = self._trainer.model
        except AttributeError:
            return None
        teacher = self._teacher
        tokenizer = self._tokenizer
        max_len = int(self.config.max_length)
        device_t = next(teacher.parameters()).device
        device_s = next(student_model.parameters()).device

        student_correct = 0
        teacher_correct = 0
        total_response_tokens = 0
        student_model.eval()
        with torch.no_grad():
            for row in self._eval_rows:
                prompt = row.get("prompt", "")
                response = row.get("response", "")
                if not prompt or not response:
                    continue
                prompt_ids = tokenizer(
                    prompt, return_tensors="pt", truncation=True, max_length=max_len,
                ).input_ids
                full_ids = tokenizer(
                    prompt + response, return_tensors="pt", truncation=True, max_length=max_len,
                ).input_ids
                p_len = int(prompt_ids.shape[1])
                f_len = int(full_ids.shape[1])
                if f_len <= p_len:
                    continue
                response_tokens = full_ids[0, p_len:f_len]
                # Teacher / student logits over the full sequence; the loss at
                # position i predicts token i+1, so we slice logits[p_len-1:f_len-1]
                # to align with the response tokens at positions p_len..f_len-1.
                t_logits = teacher(input_ids=full_ids.to(device_t)).logits[0]
                s_logits = student_model(input_ids=full_ids.to(device_s)).logits[0]
                t_pred = t_logits[p_len - 1:f_len - 1].argmax(dim=-1).cpu()
                s_pred = s_logits[p_len - 1:f_len - 1].argmax(dim=-1).cpu()
                resp_cpu = response_tokens.cpu()
                teacher_correct += int((t_pred == resp_cpu).sum().item())
                student_correct += int((s_pred == resp_cpu).sum().item())
                total_response_tokens += int(resp_cpu.numel())
        if total_response_tokens == 0:
            return None
        return {
            "teacher": teacher_correct / total_response_tokens,
            "student": student_correct / total_response_tokens,
            "count": total_response_tokens,
        }


def distill_trainer(
    teacher_model: str,
    student_model: str,
    train_jsonl: str,
    out_dir: str,
    config: Optional[DistillConfig] = None,
    eval_jsonl: Optional[str] = None,
    importance_weights_path: Optional[str] = None,
    progressive_pass: Optional[int] = None,
    progressive_gate: Optional[str] = None,
) -> DistillSession:
    """Build a configured KD trainer ready for .train().

    The teacher is loaded read-only (frozen, no_grad on every forward). The
    student is loaded with LoRA adapters on attention projections. Both
    tokenizers must share the same vocabulary; if they do not, the KL is
    undefined and the function raises.
    """

    if not _HAS_TORCH:
        raise RuntimeError(
            "distill.py: torch is required. "
            "pip install 'torch>=2.4' transformers peft accelerate"
        )

    try:
        from transformers import (
            AutoTokenizer,
            AutoModelForCausalLM,
            TrainingArguments,
            Trainer,
            DataCollatorForLanguageModeling,
        )
        from peft import LoraConfig, get_peft_model, TaskType
    except ImportError as e:
        raise RuntimeError(
            f"distill.py: missing dependency {e.name}. "
            f"pip install 'transformers>=4.46' 'peft>=0.13' accelerate"
        ) from e

    cfg = config or DistillConfig()
    torch.manual_seed(cfg.seed)

    teacher_tok = AutoTokenizer.from_pretrained(teacher_model, use_fast=True)
    student_tok = AutoTokenizer.from_pretrained(student_model, use_fast=True)
    if teacher_tok.get_vocab() != student_tok.get_vocab():
        raise ValueError(
            "distill.py: teacher and student tokenizers must share a vocabulary "
            "for token-level KD. Use cross-tokenizer distillation (sequence-level) "
            "or pick a student from the teacher's family."
        )
    tokenizer = student_tok
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if cfg.bf16 else torch.float32

    teacher = AutoModelForCausalLM.from_pretrained(teacher_model, torch_dtype=dtype)
    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad = False

    student_base = AutoModelForCausalLM.from_pretrained(student_model, torch_dtype=dtype)
    lora_cfg = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=list(cfg.target_modules),
    )
    student = get_peft_model(student_base, lora_cfg)
    student.config.pad_token_id = tokenizer.pad_token_id

    rows = _load_jsonl(train_jsonl)
    # W712: progressive-distillation pass filter. Applied BEFORE eval-split
    # so the held-out slice reflects the same capability stage as the
    # training data. When --pass is omitted, this is a no-op.
    n_before_filter = len(rows)
    if progressive_pass in (1, 2, 3):
        rows = _progressive_filter_rows(rows, progressive_pass)
        if not rows:
            raise ValueError(
                f"distill.py: --pass={progressive_pass} filter dropped all rows. "
                f"For pass=2 ensure captures carry reasoning_trace or response > "
                f"{PROGRESSIVE_MULTI_STEP_TOKEN_FLOOR} tokens. For pass=3 ensure "
                f"the supplied failures slice is non-empty."
            )
    eval_rows: list[dict] = []
    if eval_jsonl:
        eval_rows = _load_jsonl(eval_jsonl)
    elif cfg.eval_split > 0 and len(rows) >= 50:
        # W252 Bug 2: shuffle before splitting so a sorted JSONL doesn't
        # produce a class-imbalanced eval split. Seeded for reproducibility.
        random.seed(cfg.seed)
        random.shuffle(rows)
        cut = max(1, int(len(rows) * cfg.eval_split))
        rows, eval_rows = rows[:-cut], rows[-cut:]
        if len(rows) == 0 or len(eval_rows) == 0:
            raise ValueError(
                "distill.py: train/eval split produced empty side. "
                "Lower cfg.eval_split or supply more rows."
            )

    # If response is missing, draw one from the teacher at sampling temperature 1.
    for r in (*rows, *eval_rows):
        if not r.get("response"):
            r["response"] = _teacher_sample(teacher, tokenizer, r["prompt"], max_new=256)

    train_ds = _PromptResponseDataset(rows, tokenizer, cfg.max_length)
    eval_ds = _PromptResponseDataset(eval_rows, tokenizer, cfg.max_length) if eval_rows else None

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    args = TrainingArguments(
        output_dir=out_dir,
        num_train_epochs=cfg.num_epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.batch_size,
        gradient_accumulation_steps=cfg.grad_accum,
        learning_rate=cfg.learning_rate,
        warmup_ratio=cfg.warmup_ratio,
        save_steps=cfg.save_steps,
        eval_strategy="steps" if eval_ds else "no",
        eval_steps=cfg.save_steps if eval_ds else None,
        logging_steps=20,
        bf16=cfg.bf16,
        seed=cfg.seed,
        report_to=[],
        remove_unused_columns=False,
    )

    kd_fn = _KD_FNS[cfg.objective]
    T = cfg.temperature
    alpha = cfg.alpha
    top_k = cfg.top_k

    class _DistillTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            labels = inputs.pop("labels")
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]

            with torch.no_grad():
                t_out = teacher(input_ids=input_ids, attention_mask=attention_mask).logits
            s_out = model(input_ids=input_ids, attention_mask=attention_mask).logits

            # Shift for next-token prediction.
            s_shift = s_out[..., :-1, :].contiguous()
            t_shift = t_out[..., :-1, :].contiguous()
            l_shift = labels[..., 1:].contiguous()
            mask = (l_shift != -100)
            if not mask.any():
                # All prompt tokens; nothing to distill against.
                zero = s_shift.new_zeros(())
                return (zero, {"loss_kd": zero, "loss_ce": zero}) if return_outputs else zero

            s_flat = s_shift[mask]
            t_flat = t_shift[mask]
            l_flat = l_shift[mask]

            if top_k > 0:
                s_flat, t_flat = _topk_prune(s_flat, t_flat, top_k)

            loss_kd = kd_fn(s_flat, t_flat, T)
            loss_ce = F.cross_entropy(s_flat, l_flat) if top_k == 0 else \
                      F.cross_entropy(s_shift.view(-1, s_shift.size(-1)),
                                      l_shift.view(-1), ignore_index=-100)

            loss = alpha * loss_kd + (1.0 - alpha) * loss_ce
            if return_outputs:
                return loss, {"loss_kd": loss_kd.detach(), "loss_ce": loss_ce.detach()}
            return loss

    # W711-2: optional importance-weighted sampling. When the CLI passes
    # --importance-weights <jsonl>, we load it, build a WeightedRandomSampler,
    # and override the trainer's default sampler via a custom subclass. When
    # the flag is absent OR the JSONL fails to match any rows, we leave the
    # default sampler intact and record the skip reason.
    importance_weights: dict[str, float] = {}
    importance_meta: dict[str, Any] = {
        "importance_weights_used": False,
        "importance_version": IMPORTANCE_VERSION,
        "importance_jsonl_path": importance_weights_path,
    }
    weighted_sampler = None
    if importance_weights_path:
        importance_weights = _load_importance_weights_jsonl(importance_weights_path)
        weighted_sampler, n_matched, n_total = _build_weighted_sampler(rows, importance_weights)
        importance_meta["importance_rows_matched"] = n_matched
        importance_meta["importance_rows_total"] = n_total
        if weighted_sampler is None:
            importance_meta["importance_weights_skipped_reason"] = (
                "empty_weights_file" if not importance_weights else "no_capture_id_overlap"
            )
        else:
            importance_meta["importance_weights_used"] = True

    if weighted_sampler is not None:
        _captured_sampler = weighted_sampler

        class _DistillTrainerWeighted(_DistillTrainer):
            def _get_train_sampler(self, *_args, **_kwargs):
                # HF Trainer 4.46+ may call this with the train_dataset arg; we
                # accept *args/**kwargs to stay forward-compatible.
                return _captured_sampler

        trainer = _DistillTrainerWeighted(
            model=student,
            args=args,
            train_dataset=train_ds,
            eval_dataset=eval_ds,
            data_collator=collator,
        )
    else:
        trainer = _DistillTrainer(
            model=student,
            args=args,
            train_dataset=train_ds,
            eval_dataset=eval_ds,
            data_collator=collator,
        )

    # Stamp run-meta.importance.json now (pre-train) so the path is recoverable
    # even if training crashes; the feedback block is appended post-train.
    importance_meta_path = _write_importance_run_meta(out_dir, importance_meta)

    # W712: stamp run-meta.progressive.json so the curriculum stage is
    # recoverable independent of HF Trainer state and the K-Score axis-gate
    # decision (made post-train by the CLI side) has a stable provenance file.
    if progressive_pass in (1, 2, 3):
        _write_progressive_run_meta(
            out_dir=out_dir,
            pass_num=progressive_pass,
            gate_label=progressive_gate,
            n_before=n_before_filter,
            n_after=len(rows),
        )

    session = DistillSession(
        teacher_model=teacher_model,
        student_model=student_model,
        config=cfg,
        n_train=len(rows),
        n_eval=len(eval_rows),
        _trainer=trainer,
        # W258-ML-5: hand teacher + tokenizer + raw eval_rows to the session
        # so train() can compute holdout token accuracies for the receipt.
        _teacher=teacher,
        _tokenizer=tokenizer,
        _eval_rows=eval_rows,
        # W711-2/-3: importance-weighting metadata threads through the session
        # so train() can append the feedback bit post-loop.
        _importance_meta=importance_meta,
        _importance_meta_path=importance_meta_path,
        _importance_weights=importance_weights,
        _train_rows=rows,
        _out_dir=out_dir,
    )
    return session


def _teacher_sample(teacher, tokenizer, prompt: str, *, max_new: int = 256) -> str:
    """Single-shot teacher sample. Used when the buyer ships prompts without
    paired responses. Sampling at T=1 keeps the natural distribution; the KD
    loss itself runs at config.temperature."""
    if not _HAS_TORCH:
        raise RuntimeError("distill.py: torch required for teacher sampling")
    ids = tokenizer(prompt, return_tensors="pt").input_ids
    with torch.no_grad():
        out = teacher.generate(
            ids.to(teacher.device),
            max_new_tokens=max_new,
            do_sample=True,
            temperature=1.0,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
    new_ids = out[0, ids.shape[1]:]
    return tokenizer.decode(new_ids, skip_special_tokens=True)


def receipt_block(session: DistillSession, train_summary: dict) -> dict:
    """The receipt fragment the K-score gate and audit log both read.

    `papers` cites the canonical KD references so a binder render can footnote
    them. The teacher_model and config land verbatim so a buyer's auditor can
    reproduce the run.

    W258-ML-5: `holdout_accuracy` (student) and `teacher_holdout_accuracy`
    (teacher) are surfaced at the top level so computeKScoreV2 has the inputs
    for R (robustness) and T (teacher fidelity). Without them the K-score v2
    axes redistribute weight and the cross-vendor distillation honesty claim
    cannot be verified.
    """
    cfg = asdict(session.config)
    # enum -> str for JSON
    cfg["objective"] = session.config.objective.value
    student_acc = train_summary.get("student_token_accuracy")
    teacher_acc = train_summary.get("teacher_token_accuracy")
    return {
        "method": "kd_response_distillation",
        "teacher_model": session.teacher_model,
        "student_model": session.student_model,
        "seed": int(session.config.seed),
        "config": cfg,
        "n_train_rows": session.n_train,
        "n_eval_rows": session.n_eval,
        "loss_final": train_summary.get("loss_final"),
        "ppl_eval": train_summary.get("ppl_eval"),
        # T-axis anchor: student / teacher token-level top-1 accuracy on the
        # held-out split. None when no eval set or torch absent.
        "holdout_accuracy": student_acc,
        "teacher_holdout_accuracy": teacher_acc,
        "holdout_token_count": train_summary.get("holdout_token_count"),
        "papers": [
            "arXiv:1503.02531",  # Hinton soft labels
            "arXiv:1606.07947",  # Kim & Rush seq-level
            "arXiv:2306.08543",  # MiniLLM reverse-KL
            "arXiv:2306.13649",  # On-policy distillation
        ],
    }


__all__ = [
    "DistillConfig",
    "DistillSession",
    "KDObjective",
    "distill_trainer",
    "receipt_block",
]


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="distill.py",
        description=(
            "Response distillation: train a small student to imitate a large "
            "teacher by matching its next-token distribution."
        ),
    )
    p.add_argument("--teacher-model", type=str, default=None,
                   help="HF model id of the teacher (e.g. Qwen/Qwen2.5-14B-Instruct).")
    p.add_argument("--student-model", type=str, default=None,
                   help="HF model id of the student (e.g. Qwen/Qwen2.5-3B-Instruct).")
    p.add_argument("--train-jsonl", type=str, default=None,
                   help="Input JSONL of {prompt,response?} rows.")
    p.add_argument("--eval-jsonl", type=str, default=None,
                   help="Optional eval JSONL; if omitted, eval_split is taken from --train-jsonl.")
    p.add_argument("--out-dir", type=str, default=None,
                   help="Where the LoRA adapter + tokenizer are written.")
    p.add_argument("--seed", type=int, default=DistillConfig.seed,
                   help="PRNG seed for shuffle, torch, and HF Trainer.")
    p.add_argument("--eval-split", type=float, default=DistillConfig.eval_split,
                   help="Fraction of rows held out when --eval-jsonl is absent.")
    p.add_argument("--temperature", type=float, default=DistillConfig.temperature,
                   help="Softmax temperature for KD; Hinton recipe T=2.0.")
    p.add_argument("--alpha", type=float, default=DistillConfig.alpha,
                   help="Weight on the KD loss term (1-alpha goes to CE).")
    p.add_argument("--objective", type=str, default=DistillConfig.objective.value,
                   choices=[o.value for o in KDObjective],
                   help="KD divergence to minimize.")
    p.add_argument("--num-epochs", type=int, default=DistillConfig.num_epochs)
    p.add_argument("--batch-size", type=int, default=DistillConfig.batch_size)
    p.add_argument("--learning-rate", type=float, default=DistillConfig.learning_rate)
    p.add_argument("--lora-r", type=int, default=DistillConfig.lora_r)
    p.add_argument("--lora-alpha", type=int, default=DistillConfig.lora_alpha)
    p.add_argument("--max-length", type=int, default=DistillConfig.max_length)
    p.add_argument("--print-config", action="store_true",
                   help="Print the resolved DistillConfig as JSON and exit; do not load any models.")
    # W711-2: importance-weighted sampling. JSONL produced by
    # src/capture-importance.js (one row per capture: {capture_id, importance}).
    # When omitted, sampling is uniform (existing behavior preserved verbatim).
    p.add_argument("--importance-weights", type=str, default=None,
                   help="Path to a JSONL file of {'capture_id': str, 'importance': float in [0,1]} "
                        "produced by src/capture-importance.js. When set, training uses a "
                        "WeightedRandomSampler so high-importance captures are oversampled.")
    # W712: progressive distillation curriculum knobs. --pass selects which
    # capability stage (1=format, 2=reasoning, 3=edge); --gate is a label-only
    # field that gets stamped into run-meta.progressive.json so the artifact
    # carries provenance of the curriculum stage that produced it. Neither
    # flag is required; without them the trainer behavior is UNCHANGED.
    p.add_argument("--pass", dest="prog_pass", type=int, default=None,
                   choices=[1, 2, 3],
                   help="W712 progressive-distillation pass: 1=format, 2=reasoning, 3=edge. "
                        "Filters the training JSONL in-process before the sampler runs. "
                        "Omit for the default pass-through behavior.")
    p.add_argument("--gate", dest="prog_gate", type=str, default=None,
                   choices=["format", "reasoning", "edge"],
                   help="W712 gate label (informational; stamped into run-meta.progressive.json). "
                        "The K-Score axis gate itself is evaluated by the CLI side post-train.")
    return p


def _config_from_args(args: argparse.Namespace) -> DistillConfig:
    return DistillConfig(
        temperature=args.temperature,
        alpha=args.alpha,
        objective=KDObjective.from_str(args.objective),
        learning_rate=args.learning_rate,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        max_length=args.max_length,
        batch_size=args.batch_size,
        num_epochs=args.num_epochs,
        seed=args.seed,
        eval_split=args.eval_split,
    )


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    cfg = _config_from_args(args)
    if args.print_config:
        cfg_dict = asdict(cfg)
        cfg_dict["objective"] = cfg.objective.value
        print(json.dumps(cfg_dict, indent=2))
        return 0
    missing = [k for k, v in (
        ("--teacher-model", args.teacher_model),
        ("--student-model", args.student_model),
        ("--train-jsonl", args.train_jsonl),
        ("--out-dir", args.out_dir),
    ) if not v]
    if missing:
        print(
            f"distill.py: missing required args: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 2
    session = distill_trainer(
        teacher_model=args.teacher_model,
        student_model=args.student_model,
        train_jsonl=args.train_jsonl,
        out_dir=args.out_dir,
        eval_jsonl=args.eval_jsonl,
        config=cfg,
        importance_weights_path=args.importance_weights,
        progressive_pass=args.prog_pass,
        progressive_gate=args.prog_gate,
    )
    summary = session.train()
    receipt = receipt_block(session, summary)
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
