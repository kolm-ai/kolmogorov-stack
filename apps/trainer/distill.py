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
from dataclasses import dataclass, asdict, field, replace
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import torch
    import torch.nn.functional as F
    from torch.utils.data import Dataset, WeightedRandomSampler, SequentialSampler
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

# W717 — curriculum distillation.
#
# When --curriculum is passed, sort training rows by ascending complexity_proxy
# (computed JS-side by src/curriculum-sort.js and stamped on each JSONL row).
# Rows missing complexity_proxy get a neutral 0.5 so the sort stays well-defined
# without dropping data. The trainer then swaps its sampler for a
# SequentialSampler — a WeightedRandomSampler or shuffle would defeat the
# curriculum ordering.
#
# Order of operations:
#   1. --pass filter (W712) narrows the corpus to the capability stage.
#   2. --curriculum reorders WITHIN the stage (this wave).
#   3. SequentialSampler walks the ordered rows in order.
#
# When --curriculum AND --importance-weights are both set, --curriculum WINS:
# importance weighting is incompatible with deterministic curriculum order.
# The trainer logs the conflict to run-meta.curriculum.json and skips the
# weighted sampler (never silently fakes both).
#
# Honesty contract: --curriculum without complexity_proxy on any row falls
# back to length-based ordering (response char count) so the trainer still
# produces a deterministic order rather than ValueError-ing the run.

CURRICULUM_VERSION = "w717-v1"

# W971 - DP-SGD fine-tuning path.
#
# src/dp-training.js already owns the JS-side DP-SGD/PATE accounting contract
# and exports KOLM_DP_* env vars for this Python worker. This module now reads
# the same knobs, prices the same RDP/moments-accountant budget locally, and
# requires Opacus PrivacyEngine before any DP-SGD run starts. The important
# honesty boundary: if DP-SGD is requested but Opacus is missing or cannot wrap
# the trainer, the run fails loud instead of silently training non-DP weights.

DP_TRAINING_VERSION = "finalized-c2-v1"
DP_ACCOUNTANT = "rdp_moments_v1"
DP_MECHANISM = "dp_sgd_sampled_gaussian"

# W828-3/-4 — TRACE-AWARE LOSS.
#
# W713 captured reasoning traces (Anthropic thinking blocks, OpenAI o1
# reasoning_tokens, DeepSeek-R1 <think>...</think>) and inlined them as
# training rows of shape "<think>{reasoning}</think>{answer}". The base
# distillation loss treats every response token uniformly though, so the
# student ends up over-fitting to the (longer) reasoning portion while
# under-weighting the (shorter, more important) final answer — or vice
# versa, depending on the corpus.
#
# trace_aware_loss splits the per-position loss into two means:
#   * answer_loss: mean -log p over tokens BETWEEN </think> and end-of-seq.
#   * trace_loss : mean -log p over tokens BETWEEN <think> and </think>.
# and combines them as
#   loss = (1 - w) * answer_loss + w * trace_loss
# where w = args.reasoning_trace_loss_weight (default 0.0 → behaves
# identically to the W713 baseline, which is the W828-4 opt-in contract).
#
# Honesty contracts:
#   * Default weight 0.0 means trace tokens contribute ZERO additional
#     loss; the existing W713 path is byte-identical when --reasoning-
#     trace-loss-weight is omitted.
#   * trace_mask MUST be aligned 1:1 with target_ids (same shape). The
#     dataset builder tags <think>..</think> spans by setting trace_mask=1
#     on those positions, 0 elsewhere.
#   * When trace_mask.sum() == 0 (no traces in batch), the trace term is
#     identically 0 and the answer term carries the full weight — never
#     NaN, never divide-by-zero (we clamp denominators to min=1).
#   * Branch only when args.reasoning_trace_loss_weight > 0; the W713
#     baseline path stays untouched at weight=0.

REASONING_TRACE_LOSS_VERSION = "w828-v1"


# W921-NEXT4 — MoE-AWARE DISTILLATION (load-balanced expert training).
#
# The dense KD path above is proven (QAD on a 5090, DistiLLM-2 works). These
# additions are STRICTLY ADDITIVE and GATED on the STUDENT being a sparse-MoE
# model. When the student config carries no expert fields, every branch below
# is skipped and the dense loss is byte-for-byte unchanged.
#
# Why a MoE student needs a load-balancing term: a sparse mixture routes each
# token to top-k of N experts via a learned router. With only the KD/CE signal
# the router collapses — it learns to send (almost) every token to a handful of
# experts, leaving the rest dead. That wastes capacity and destabilizes
# training. The standard fix (Shazeer 2017 "Outrageously Large Neural
# Networks", Fedus 2021 Switch Transformer, and the Mixtral/Qwen-MoE HF
# implementations) is an auxiliary load-balancing loss added to the main loss:
#
#     aux = num_experts * mean_layers( sum_e  f_e * P_e )
#
# where, per layer, over the T routed tokens:
#     f_e = fraction of tokens whose top-k routing INCLUDES expert e
#     P_e = mean router probability assigned to expert e
# A perfectly balanced router (every expert gets 1/N of the tokens and 1/N of
# the probability mass) drives this product toward its minimum; a collapsed
# router (all tokens to one expert) drives it UP toward num_experts. The term
# is scaled by router_aux_loss_coef (HF default 0.001) and ADDED to KD+CE.
#
# Detection mirrors src/moe-support.js detectMoE() field names so the JS and
# Python sides agree on what "MoE" means: num_local_experts / num_experts /
# n_routed_experts / moe_num_experts on the config, plus the model exposing an
# output_router_logits-capable forward (Mixtral, Qwen2/3-MoE, DeepSeek-V2/V3,
# Phi-MoE, OLMoE, Granite-MoE, DBRX, Jamba, MiniMax, Llama4).
#
# Honesty contracts:
#   * Dense students: NO behavioral change. _student_is_moe() returns False,
#     output_router_logits is never set, and the aux term is never added.
#   * The aux loss is always >= 0 and is scaled by a configurable coefficient
#     (default 0.001). It is ADDED to the existing KD loss, never replaces it.
#   * moe:{num_experts, router_aux_loss_coef, aux_loss_last} is surfaced in the
#     training summary ONLY when the student is MoE.

MOE_VERSION = "w921-next4-v1"

MOE_DEFAULT_ROUTER_AUX_LOSS_COEF = 0.001

# Config keys that name the (total) routed-expert count. Mirrors the lookup
# order in src/moe-support.js _detectFromConfig so the two sides agree.
_MOE_NUM_EXPERTS_KEYS = (
    "num_local_experts",   # Mixtral, Phi-MoE
    "num_experts",         # Qwen2/3-MoE, OLMoE, Granite-MoE, generic
    "n_routed_experts",    # DeepSeek-V2/V3
    "moe_num_experts",     # DBRX-style / generic
    "num_experts_per_layer",
)
# Config keys that name the per-token top-k.
_MOE_TOP_K_KEYS = (
    "num_experts_per_tok",
    "n_activated_experts",
    "moe_top_k",
    "top_k_experts",
    "num_experts_per_token",
)


def _config_get(config, *names):
    """Read the first present attribute from an HF config (or a plain dict).

    HF PretrainedConfig is attribute-accessed; synthetic test configs may be
    plain dicts. Returns None when no key is present."""
    for n in names:
        if isinstance(config, dict):
            if n in config and config[n] is not None:
                return config[n]
        else:
            v = getattr(config, n, None)
            if v is not None:
                return v
    return None


def _moe_num_experts(config):
    """Total routed-expert count from a config, or 0 when dense/unknown."""
    v = _config_get(config, *_MOE_NUM_EXPERTS_KEYS)
    try:
        n = int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0
    return n if n > 1 else 0


def _moe_top_k(config):
    """Per-token top-k from a config, or 0 when absent."""
    v = _config_get(config, *_MOE_TOP_K_KEYS)
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0


def _student_is_moe(model_or_config) -> bool:
    """True iff the student is a sparse-MoE model.

    Accepts either an HF model (reads .config) or a config object/dict. The
    verdict is positive ONLY when a routed-expert count > 1 is present — this
    is the single gate that keeps the dense path untouched. A model that is
    capable of output_router_logits but reports <= 1 experts is treated as
    dense (no aux term, nothing to balance)."""
    config = getattr(model_or_config, "config", model_or_config)
    return _moe_num_experts(config) > 0


def moe_load_balance_loss(router_logits, num_experts: int, top_k: int = 2,
                          attention_mask=None):
    """Standard MoE load-balancing auxiliary loss (Switch Transformer / Mixtral).

    aux = num_experts * mean_layers( sum_e  f_e * P_e )

    where, per routing layer, over the routed tokens:
      f_e = fraction of tokens whose top-k selection INCLUDES expert e
      P_e = mean router softmax probability assigned to expert e

    Args:
      router_logits: the per-layer router logits. Accepts either
          * a tuple/list of tensors, one per MoE layer, each shape
            (num_tokens, num_experts)  (HF outputs.router_logits convention), OR
          * a single tensor of shape (num_tokens, num_experts) (one layer).
        Layers whose last dim != num_experts (e.g. a None / dense layer) are
        skipped.
      num_experts: total routed-expert count N.
      top_k: experts selected per token. Clamped to [1, num_experts].
      attention_mask: optional (num_tokens,) 0/1 tensor to exclude pad tokens
        from the routed-token statistics. When None, every row counts.

    Returns:
      Scalar tensor >= 0. A perfectly balanced router yields ~1.0 (the minimum
      for this normalization); a collapsed router approaches num_experts.

    Honesty contract: returns a 0 scalar when there are no usable router-logit
    layers (e.g. dense forward) rather than raising; the caller gates on
    _student_is_moe() anyway, so this is defense-in-depth."""
    if not _HAS_TORCH:
        raise RuntimeError(
            "moe_load_balance_loss requires torch. Install with: pip install 'torch>=2.4'"
        )
    if isinstance(router_logits, (tuple, list)):
        layers = list(router_logits)
    else:
        layers = [router_logits]
    n_experts = int(num_experts)
    if n_experts < 2:
        # Not enough experts to balance — return a 0 scalar in the dtype of the
        # first available tensor (or a bare CPU zero).
        for rl in layers:
            if rl is not None and hasattr(rl, "new_zeros"):
                return rl.new_zeros(())
        return torch.zeros(())
    k = max(1, min(int(top_k) if top_k else 1, n_experts))

    per_layer = []
    ref = None
    for rl in layers:
        if rl is None or not hasattr(rl, "dim"):
            continue
        if rl.dim() != 2 or rl.size(-1) != n_experts:
            # Skip layers that don't look like (tokens, num_experts) router
            # logits (dense layers in a hybrid stack, or shape mismatches).
            continue
        ref = rl
        # routing_weights[t, e] = softmax over experts for token t.
        routing_weights = F.softmax(rl, dim=-1)
        # top-k selection mask: which experts each token routes to.
        _, selected = torch.topk(routing_weights, k=k, dim=-1)
        expert_mask = F.one_hot(selected, num_classes=n_experts)  # (T, k, N)
        # f_e: fraction of tokens that selected expert e (any of its k slots).
        tokens_per_expert = expert_mask.float().sum(dim=1).clamp(max=1.0)  # (T, N) 0/1 per (token,expert)
        # P_e: mean router probability mass on expert e.
        if attention_mask is not None and attention_mask.numel() == routing_weights.size(0):
            m = attention_mask.to(routing_weights.dtype).unsqueeze(-1)  # (T,1)
            denom = m.sum().clamp(min=1.0)
            f_e = (tokens_per_expert * m).sum(dim=0) / denom
            p_e = (routing_weights * m).sum(dim=0) / denom
        else:
            f_e = tokens_per_expert.mean(dim=0)
            p_e = routing_weights.mean(dim=0)
        per_layer.append((f_e * p_e).sum())

    if not per_layer:
        if ref is not None and hasattr(ref, "new_zeros"):
            return ref.new_zeros(())
        for rl in layers:
            if rl is not None and hasattr(rl, "new_zeros"):
                return rl.new_zeros(())
        return torch.zeros(())

    stacked = torch.stack(per_layer)
    return float(n_experts) * stacked.mean()


def _extract_router_logits(outputs):
    """Pull router_logits out of an HF MoE model output, or None when absent.

    HF MoE causal-LM outputs expose `.router_logits` (a tuple per layer) when
    the forward was called with output_router_logits=True. Some models also
    expose a precomputed `.aux_loss`/`.z_loss`; we prefer router_logits so the
    coefficient and normalization are under our control. Returns None for dense
    outputs so the caller can skip the aux term."""
    rl = getattr(outputs, "router_logits", None)
    if rl is None and isinstance(outputs, dict):
        rl = outputs.get("router_logits")
    return rl


def trace_aware_loss(logits, target_ids, trace_mask, attention_mask, w=0.5):
    """Weighted distillation loss that separates reasoning-trace tokens from
    final-answer tokens.

    Args:
      logits:         student logits at every position, shape (B, T, V).
      target_ids:     gold next-token ids, shape (B, T).
      trace_mask:     1 on positions inside <think>..</think>, else 0; same
                      shape as target_ids. Build via the dataset tagger that
                      walks the rendered prompt+response sequence.
      attention_mask: 1 on response positions, 0 on pad / prompt positions;
                      same shape as target_ids.
      w:              weight on the trace term. 0.0 = answer-only (W713 base),
                      0.5 = even split, 1.0 = trace-only (debug — does not
                      teach the student to produce final answers).

    Returns:
      Scalar tensor; (1 - w) * answer_loss + w * trace_loss.

    Honesty contract: when the masks zero out an entire side, that side's
    denominator clamps to 1, producing a 0 contribution rather than NaN.
    Never throws; shape mismatches propagate as torch errors (the caller is
    responsible for building masks aligned to target_ids).
    """
    if not _HAS_TORCH:
        raise RuntimeError(
            "trace_aware_loss requires torch. Install with: pip install 'torch>=2.4'"
        )
    # answer_mask = attention_mask AND NOT trace_mask. Both come in as 0/1
    # tensors; we cast to bool for the AND, then back to the dtype of
    # attention_mask so the multiplication below stays in float space.
    am_bool = attention_mask.bool()
    tm_bool = trace_mask.bool()
    answer_mask = (am_bool & ~tm_bool).to(attention_mask.dtype)
    trace_mask_f = tm_bool.to(attention_mask.dtype)
    # -log p at each position for the target token.
    log_probs = F.log_softmax(logits, dim=-1)
    # gather over the vocab dim; target_ids must be (B, T) -> (B, T, 1).
    lp = -log_probs.gather(-1, target_ids.unsqueeze(-1)).squeeze(-1)
    # Masked means with clamp-to-1 denominator to dodge divide-by-zero.
    answer_denom = answer_mask.sum().clamp(min=1)
    trace_denom = trace_mask_f.sum().clamp(min=1)
    answer_loss = (lp * answer_mask).sum() / answer_denom
    trace_loss = (lp * trace_mask_f).sum() / trace_denom
    return (1.0 - w) * answer_loss + w * trace_loss


def _build_trace_mask_from_text(prompt: str, response: str, tokenizer, max_length: int):
    """Tokenize prompt+response and produce a trace_mask tagging positions
    inside <think>..</think> within the response.

    Returns a (input_ids, trace_mask, attention_mask) tuple where each list
    is the same length. Defensive against unbalanced tags — falls back to
    all-zeros trace_mask (no trace) rather than raising.
    """
    open_tag = "<think>"
    close_tag = "</think>"
    open_idx = response.find(open_tag)
    close_idx = response.find(close_tag, open_idx + len(open_tag)) if open_idx >= 0 else -1
    p_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    if open_idx < 0 or close_idx < 0:
        # No well-formed trace — full response treated as answer.
        r_ids = tokenizer(response, add_special_tokens=False)["input_ids"]
        input_ids = p_ids + r_ids
        trace_mask = [0] * len(input_ids)
        attention_mask = [0] * len(p_ids) + [1] * len(r_ids)
    else:
        before = response[:open_idx]
        trace_text = response[open_idx + len(open_tag):close_idx]
        after = response[close_idx + len(close_tag):]
        before_ids = tokenizer(before, add_special_tokens=False)["input_ids"] if before else []
        trace_ids = tokenizer(trace_text, add_special_tokens=False)["input_ids"] if trace_text else []
        after_ids = tokenizer(after, add_special_tokens=False)["input_ids"] if after else []
        input_ids = p_ids + before_ids + trace_ids + after_ids
        trace_mask = (
            [0] * len(p_ids)
            + [0] * len(before_ids)
            + [1] * len(trace_ids)
            + [0] * len(after_ids)
        )
        attention_mask = (
            [0] * len(p_ids)
            + [1] * len(before_ids)
            + [1] * len(trace_ids)
            + [1] * len(after_ids)
        )
    if len(input_ids) > max_length:
        over = len(input_ids) - max_length
        input_ids = input_ids[over:]
        trace_mask = trace_mask[over:]
        attention_mask = attention_mask[over:]
    return input_ids, trace_mask, attention_mask


def _curriculum_sort_rows(rows: list[dict]) -> tuple[list[dict], dict]:
    """Sort training rows by ascending complexity_proxy.

    Returns (sorted_rows, meta) where meta captures the sort provenance for
    run-meta.curriculum.json. Pure: does not mutate the input list."""
    if not isinstance(rows, list) or not rows:
        return rows or [], {
            "curriculum_version": CURRICULUM_VERSION,
            "rows_in": 0,
            "rows_with_proxy": 0,
            "fallback": None,
        }
    n_with_proxy = 0
    decorated: list[tuple[float, int, dict]] = []
    for i, r in enumerate(rows):
        cp = r.get("complexity_proxy") if isinstance(r, dict) else None
        if isinstance(cp, (int, float)) and 0.0 <= float(cp) <= 1.0:
            decorated.append((float(cp), i, r))
            n_with_proxy += 1
        else:
            # Fallback: length-based proxy. response_chars / 4096 clamped.
            resp = r.get("response", "") if isinstance(r, dict) else ""
            chars = len(resp) if isinstance(resp, str) else 0
            length_norm = min(1.0, chars / 4096.0)
            decorated.append((length_norm, i, r))
    # Stable sort: tuple compares by score then by original index.
    decorated.sort(key=lambda t: (t[0], t[1]))
    sorted_rows = [t[2] for t in decorated]
    meta = {
        "curriculum_version": CURRICULUM_VERSION,
        "rows_in": len(rows),
        "rows_with_proxy": n_with_proxy,
        "fallback": (
            None if n_with_proxy == len(rows)
            else f"{len(rows) - n_with_proxy} rows used length-based fallback"
        ),
    }
    return sorted_rows, meta


def _write_curriculum_run_meta(out_dir: str, meta: dict) -> Optional[str]:
    """Write a sibling run-meta.curriculum.json so the curriculum stamp is
    recoverable independent of HF Trainer state. Best-effort write, mirrors
    the W711/W712 pattern."""
    if not out_dir:
        return None
    try:
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, "run-meta.curriculum.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        return p
    except OSError as e:
        print(
            f"distill.py: could not write run-meta.curriculum.json: {e}",
            file=sys.stderr,
        )
        return None


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


def _env_truthy(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return bool(default)
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: Optional[float]) -> Optional[float]:
    v = os.environ.get(name)
    if v is None or str(v).strip() == "":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _env_int(name: str, default: Optional[int]) -> Optional[int]:
    v = os.environ.get(name)
    if v is None or str(v).strip() == "":
        return default
    try:
        return int(round(float(v)))
    except ValueError:
        return default


def _default_rdp_orders() -> list[int]:
    return list(range(2, 129)) + [160, 192, 224, 256, 320, 384, 512]


def _log_sum_exp(logs: Iterable[float]) -> float:
    vals = list(logs)
    if not vals:
        return -math.inf
    m = max(vals)
    if not math.isfinite(m):
        return m
    return m + math.log(sum(math.exp(v - m) for v in vals))


def _sgm_rdp_at_order(q: float, sigma: float, alpha: int) -> float:
    """Integer-order RDP upper bound for the sampled Gaussian mechanism."""
    if sigma <= 0:
        return math.inf
    if q <= 0:
        return 0.0
    if q >= 1:
        return float(alpha) / (2.0 * sigma * sigma)
    a = int(round(alpha))
    if a < 2:
        return 0.0
    log1mq = math.log1p(-q)
    logq = math.log(q)
    sig2 = sigma * sigma
    terms = []
    for k in range(a + 1):
        log_comb = math.lgamma(a + 1) - math.lgamma(k + 1) - math.lgamma(a - k + 1)
        log_prob = (a - k) * log1mq + k * logq
        gauss_term = (k * k - k) / (2.0 * sig2)
        terms.append(log_comb + log_prob + gauss_term)
    return _log_sum_exp(terms) / (a - 1)


def compute_dp_sgd_budget(
    *,
    noise_multiplier: float,
    sample_rate: float,
    steps: int,
    delta: float = 1e-5,
    orders: Optional[Iterable[int]] = None,
) -> dict[str, Any]:
    """Return the conservative (epsilon, delta) DP-SGD budget for a run."""
    sigma = float(noise_multiplier)
    q = float(sample_rate)
    t = int(round(steps))
    d = float(delta)
    if not (0 <= q <= 1):
        raise ValueError("sample_rate must be in [0,1]")
    if t < 0:
        raise ValueError("steps must be a non-negative integer")
    if not (0 < d < 1):
        raise ValueError("delta must be in (0,1)")
    if not math.isfinite(sigma) or sigma <= 0:
        return {
            "epsilon": math.inf,
            "delta": d,
            "noise_multiplier": sigma if math.isfinite(sigma) else 0.0,
            "sample_rate": q,
            "steps": t,
            "dp_effective": False,
            "mechanism": DP_MECHANISM,
            "accountant": DP_ACCOUNTANT,
            "note": "noise_multiplier<=0: no calibrated noise added, epsilon is infinite.",
            "version": DP_TRAINING_VERSION,
        }
    best_eps = math.inf
    best_order = None
    scanned = list(orders or _default_rdp_orders())
    for alpha in scanned:
        a = int(alpha)
        rdp_total = _sgm_rdp_at_order(q, sigma, a) * t
        eps = (
            rdp_total
            + math.log((a - 1) / a)
            - (math.log(d) + math.log(a)) / (a - 1)
        )
        if math.isfinite(eps) and eps < best_eps:
            best_eps = eps
            best_order = a
    return {
        "epsilon": best_eps,
        "delta": d,
        "optimal_order": best_order,
        "noise_multiplier": sigma,
        "sample_rate": q,
        "steps": t,
        "dp_effective": True,
        "mechanism": DP_MECHANISM,
        "accountant": DP_ACCOUNTANT,
        "orders_scanned": len(scanned),
        "version": DP_TRAINING_VERSION,
    }


def _json_epsilon(value: Any) -> Any:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    return "Infinity" if math.isinf(v) else v


def _build_privacy_budget_block(
    *,
    path: str = "none",
    budget: Optional[dict[str, Any]] = None,
    teacher_source: Optional[str] = None,
    region: Optional[str] = None,
    cross_region: Optional[bool] = None,
    l2_clip: Optional[float] = None,
    implementation: Optional[str] = None,
) -> dict[str, Any]:
    base = {
        "privacy_path": path,
        "teacher_source": teacher_source,
        "region": region,
        "accountant": DP_ACCOUNTANT,
        "version": DP_TRAINING_VERSION,
    }
    if path == "none" or not budget:
        return {
            **base,
            "privacy_path": "none",
            "dp_effective": False,
            "epsilon": None,
            "delta": None,
            "note": "No differential-privacy training path was applied to this artifact.",
        }
    eps = float(budget.get("epsilon", math.inf))
    block = {
        **base,
        "dp_effective": bool(budget.get("dp_effective") is not False and not math.isinf(eps)),
        "epsilon": _json_epsilon(eps),
        "delta": budget.get("delta"),
        "mechanism": budget.get("mechanism"),
        "noise_multiplier": budget.get("noise_multiplier"),
        "sample_rate": budget.get("sample_rate"),
        "steps": budget.get("steps"),
        "n_queries": budget.get("n_queries"),
        "optimal_order": budget.get("optimal_order"),
        "region_allocation": None,
        "cross_region": cross_region,
    }
    if l2_clip is not None:
        block["l2_clip"] = float(l2_clip)
    if implementation:
        block["implementation"] = implementation
    if budget.get("note"):
        block["note"] = budget.get("note")
    if budget.get("opacus_epsilon") is not None:
        block["opacus_epsilon"] = _json_epsilon(budget.get("opacus_epsilon"))
    return block


def _dp_sample_rate(cfg: "DistillConfig", n_train: int) -> tuple[float, str]:
    if cfg.dp_sample_rate is not None:
        return float(cfg.dp_sample_rate), "config"
    if n_train <= 0:
        return 0.0, "empty_train_set"
    physical_batch = max(1, min(int(cfg.batch_size), int(n_train)))
    return min(1.0, physical_batch / float(n_train)), "batch_size_over_n_train"


def _estimate_optimizer_steps(cfg: "DistillConfig", n_train: int) -> int:
    if cfg.dp_steps is not None:
        return max(0, int(cfg.dp_steps))
    if n_train <= 0:
        return 0
    physical_batch = max(1, int(cfg.batch_size))
    batches_per_epoch = max(1, math.ceil(n_train / physical_batch))
    accum = 1 if cfg.dp_sgd else max(1, int(cfg.grad_accum))
    return int(math.ceil(batches_per_epoch / accum) * max(1, int(cfg.num_epochs)))


def _validate_dp_config(cfg: "DistillConfig") -> None:
    if not cfg.dp_sgd:
        return
    if not (float(cfg.dp_l2_clip) > 0):
        raise ValueError("distill.py: --dp-l2-clip must be > 0")
    if not (float(cfg.dp_noise_multiplier) > 0):
        raise ValueError(
            "distill.py: DP-SGD requested but dp_noise_multiplier must be > 0 "
            "to provide a finite privacy guarantee"
        )
    if not (0 < float(cfg.dp_delta) < 1):
        raise ValueError("distill.py: --dp-delta must be in (0,1)")
    if cfg.dp_sample_rate is not None and not (0 < float(cfg.dp_sample_rate) <= 1):
        raise ValueError("distill.py: --dp-sample-rate must be in (0,1]")
    if cfg.dp_steps is not None and int(cfg.dp_steps) < 0:
        raise ValueError("distill.py: --dp-steps must be >= 0")


def _write_dp_run_meta(out_dir: str, meta: dict) -> Optional[str]:
    try:
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, "run-meta.dp.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        return p
    except OSError as e:
        print(f"distill.py: could not write run-meta.dp.json: {e}", file=sys.stderr)
        return None


def _require_opacus_privacy_engine():
    try:
        from opacus import PrivacyEngine  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "distill.py: DP-SGD requested (KOLM_DP_SGD=1 or --dp-sgd) but "
            "Opacus is not installed. Install with: pip install 'opacus>=1.4'. "
            "The trainer refuses to run without real DP-SGD."
        ) from e
    return PrivacyEngine


class KDObjective(str, enum.Enum):
    """Which divergence to minimize between student and teacher."""
    FORWARD_KL = "forward_kl"
    REVERSE_KL = "reverse_kl"
    JSD = "jsd"
    # W921 — DistiLLM-2 contrastive asymmetric SKL+SRKL objective (Ko et al.,
    # ICML 2025 Oral, arXiv:2503.07067). See skewed_kl/skewed_reverse_kl/
    # distillm2_loss below. Local-teacher only (needs logits).
    DISTILLM2 = "distillm2"

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

    dp_sgd: bool = False
    """If True, run the student update under Opacus DP-SGD. This is fail-loud:
    missing Opacus or invalid noise/clip settings abort before model download."""

    dp_l2_clip: float = 1.0
    dp_noise_multiplier: float = 0.0
    dp_delta: float = 1e-5
    dp_sample_rate: Optional[float] = None
    dp_steps: Optional[int] = None


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


# =============================================================================
# W921 — DistiLLM-2 contrastive asymmetric SKL/SRKL objective.
#
# DistiLLM-2 (Ko et al., ICML 2025 Oral, arXiv:2503.07067) uses a CONTRASTIVE
# asymmetric loss that simultaneously RAISES the likelihood of teacher
# (chosen) responses via skewed-KL and LOWERS the likelihood of student
# (rejected) responses via skewed-reverse-KL.
#
# Skew with skew alpha mixes the distributions in LOG-space so log-ratios never
# blow up (DistiLLM v1, arXiv:2402.03898). All functions take per-token LOG-
# probabilities (already log_softmax'd) of shape [..., V] and return a per-
# token scalar (sum over V). NOTE: with the DistiLLM convention base_alpha is
# SMALL (default 0.1); skewed_kl -> forward KL(p_t || p_s) as alpha -> 0, and
# -> 0 as alpha -> 1. The unit tests assert the alpha->0 reduction, not alpha=1.
# =============================================================================

def skewed_kl(student_logps, teacher_logps, alpha):
    """Per-token Skewed-KL on TEACHER (chosen) tokens.

      SKL^alpha = sum_v exp(t_v) * ( t_v - logsumexp(log(alpha)+t_v, log(1-alpha)+s_v) )

    i.e. KL(p_t || alpha*p_t + (1-alpha)*p_s). The mixture lives in the SECOND
    slot so the ratio is bounded. Returns a tensor with the last (vocab) dim
    summed out."""
    import math
    a = float(alpha)
    log_a = math.log(max(a, 1e-12))
    log_1ma = math.log(max(1.0 - a, 1e-12))
    # mix_v = log( alpha*p_t + (1-alpha)*p_s )  in log-space, numerically stable
    stacked = torch.stack([log_a + teacher_logps, log_1ma + student_logps], dim=0)
    mix = torch.logsumexp(stacked, dim=0)
    per_tok = (teacher_logps.exp() * (teacher_logps - mix)).sum(dim=-1)
    return per_tok


def skewed_reverse_kl(student_logps, teacher_logps, alpha):
    """Per-token Skewed-Reverse-KL on STUDENT (rejected) tokens.

      SRKL^alpha = sum_v exp(s_v) * ( s_v - logsumexp(log(1-alpha)+t_v, log(alpha)+s_v) )

    i.e. KL(p_s || (1-alpha)*p_t + alpha*p_s). The teacher-anchor term is
    DETACHED on the gradient path (we lower the student likelihood toward the
    teacher mixture without pushing the teacher)."""
    import math
    a = float(alpha)
    log_a = math.log(max(a, 1e-12))
    log_1ma = math.log(max(1.0 - a, 1e-12))
    teacher_anchor = teacher_logps.detach() if hasattr(teacher_logps, "detach") else teacher_logps
    stacked = torch.stack([log_1ma + teacher_anchor, log_a + student_logps], dim=0)
    mix = torch.logsumexp(stacked, dim=0)
    per_tok = (student_logps.exp() * (student_logps - mix)).sum(dim=-1)
    return per_tok


def distillm2_loss(skl_chosen, srkl_rejected, beta):
    """Contrastive combination: L = (2 - beta) * SKL(chosen) + beta * SRKL(rejected).
    beta in [1, 1.5] per the gradual schedule; at beta=1 this is SKL + SRKL."""
    b = float(beta)
    return (2.0 - b) * skl_chosen + b * srkl_rejected


def _distillm2(student_logits, teacher_logits, T: float, alpha: float = 0.1):
    """DistiLLM-2 objective for the offline SFT loop — the skewed-KL
    "raise-the-chosen" component (SKL toward the teacher distribution).

    The full DistiLLM-2 recipe is CONTRASTIVE: SKL on teacher (chosen) responses
    PLUS skewed-reverse-KL on on-policy student (rejected) generations (see
    distillm2_loss + the on-policy path). On-policy sampling is not available in
    this per-batch teacher-forced loop, so here we apply the SKL half, which is
    the core skewed forward KL toward the teacher and is signature-compatible
    with the other _KD_FNS objectives. Skew (alpha) mixes the distributions in
    log-space so the log-ratio stays bounded (DistiLLM v1); the T^2 factor
    matches the Hinton gradient-scaling used by the other losses."""
    log_p_s = F.log_softmax(student_logits / T, dim=-1)
    log_p_t = F.log_softmax(teacher_logits / T, dim=-1)
    per_tok = skewed_kl(log_p_s, log_p_t, alpha)  # vocab summed -> per-token
    return per_tok.mean() * (T * T)


# Register the offline DistiLLM-2 objective so `--objective distillm2` trains
# through the standard KD loop (the contrastive on-policy variant rides the
# dedicated path). Without this the per-batch loop KeyErrors on DISTILLM2.
_KD_FNS[KDObjective.DISTILLM2] = _distillm2


def adaptive_alpha(tea_logp_sum, stu_logp_sum, base_alpha=0.1, eps=1e-5):
    """Per-sample adaptive skew from the sentence-level teacher-student gap.
    Larger gap (harder sample) -> larger alpha (more skew), clipped to
    [1e-2, base_alpha]. tea_logp_sum/stu_logp_sum are per-sample sums of the
    per-token gold log-probabilities (the reference impl's anchor)."""
    # gap >= 0 when the teacher is more confident than the student.
    anchor = (tea_logp_sum - stu_logp_sum)
    # alpha = clip(1 - (1-base_alpha) * anchor / (|stu_logp_sum| + eps), 1e-2, base_alpha)
    denom = stu_logp_sum.abs() + eps if hasattr(stu_logp_sum, "abs") else abs(stu_logp_sum) + eps
    raw = 1.0 - (1.0 - base_alpha) * (anchor / denom)
    if hasattr(raw, "clamp"):
        return raw.clamp(1e-2, base_alpha)
    return max(1e-2, min(base_alpha, raw))


def gradual_beta(global_step, max_steps, beta_0=1.0):
    """beta ramp: 1.0 + 0.5 * min(1, 2*step/max_steps). Starts emphasizing the
    teacher SKL term and ramps the student-correction SRKL term as the student
    improves. Returns a float in [beta_0, beta_0 + 0.5]."""
    if max_steps <= 0:
        return float(beta_0)
    frac = min(1.0, 2.0 * float(global_step) / float(max_steps))
    return float(beta_0) + 0.5 * frac


def build_contrastive_rows(prompts, teacher_outputs, student_outputs):
    """Reshape into the DistiLLM-2 DPO data shape: each row =
    {prompt, chosen=teacher_generated, rejected=student_generated}."""
    rows = []
    n = min(len(prompts), len(teacher_outputs), len(student_outputs))
    for i in range(n):
        rows.append({
            "prompt": prompts[i],
            "chosen": teacher_outputs[i],
            "rejected": student_outputs[i],
        })
    return rows


def generate_student_responses(student, tokenizer, prompts, temperature=0.8,
                               max_new_tokens=512, batch_size=8):
    """On-policy pre-pass: sample y_s from the CURRENT student (HF .generate,
    batched). Returns a list of decoded completions for the rejected branch.
    Deterministic when temperature<=0 (greedy). Imported lazily; GPU path."""
    import torch as _torch
    outs = []
    student.eval()
    do_sample = temperature is not None and temperature > 0
    with _torch.no_grad():
        for i in range(0, len(prompts), batch_size):
            batch = prompts[i:i + batch_size]
            enc = tokenizer(batch, return_tensors="pt", padding=True, truncation=True)
            device = next(student.parameters()).device
            enc = {k: v.to(device) for k, v in enc.items()}
            gen = student.generate(
                **enc,
                do_sample=do_sample,
                temperature=temperature if do_sample else None,
                max_new_tokens=max_new_tokens,
                pad_token_id=getattr(tokenizer, "pad_token_id", None) or getattr(tokenizer, "eos_token_id", None),
            )
            for j in range(gen.size(0)):
                new_tokens = gen[j][enc["input_ids"].size(1):]
                outs.append(tokenizer.decode(new_tokens, skip_special_tokens=True))
    return outs


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
    _dp_meta: dict = field(default_factory=dict)
    _dp_meta_path: Optional[str] = None
    _dp_privacy_engine: Any = None
    # W921-NEXT4: MoE-student metadata. When the student is dense these stay at
    # their defaults and train() omits the moe:{...} block entirely (dense path
    # surface is unchanged). _moe_aux_ref is the mutable container compute_loss
    # writes the last pre-coefficient aux value through.
    _moe_is_moe: bool = False
    _moe_num_experts: int = 0
    _moe_top_k: int = 0
    _moe_router_aux_loss_coef: float = MOE_DEFAULT_ROUTER_AUX_LOSS_COEF
    _moe_aux_ref: Any = None

    def train(self) -> dict[str, Any]:
        if self._trainer is None:
            raise RuntimeError("distill.py: train() called before trainer was built")
        result = self._trainer.train()
        summary = {
            "loss_final": float(result.training_loss) if result.training_loss is not None else None,
            "global_step": int(result.global_step),
        }
        dp_budget = self._finalize_dp_budget(summary["global_step"])
        if dp_budget is not None:
            summary["privacy_budget"] = dp_budget
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
        # W921-NEXT4 — surface the MoE training-summary block ONLY when the
        # student is a sparse-MoE model. Dense runs omit this key entirely so
        # the dense summary shape is unchanged.
        if self._moe_is_moe:
            aux_last = self._moe_aux_ref.get("value") if isinstance(self._moe_aux_ref, dict) else None
            summary["moe"] = {
                "num_experts": int(self._moe_num_experts),
                "experts_per_token": int(self._moe_top_k),
                "router_aux_loss_coef": float(self._moe_router_aux_loss_coef),
                "aux_loss_last": aux_last,
                "moe_version": MOE_VERSION,
            }
        return summary

    def _finalize_dp_budget(self, observed_steps: int) -> Optional[dict[str, Any]]:
        if not self.config.dp_sgd:
            return None
        q, q_source = _dp_sample_rate(self.config, self.n_train)
        steps = max(0, int(observed_steps))
        budget = compute_dp_sgd_budget(
            noise_multiplier=float(self.config.dp_noise_multiplier),
            sample_rate=q,
            steps=steps,
            delta=float(self.config.dp_delta),
        )
        engine = self._dp_privacy_engine
        opacus_eps = None
        if engine is not None and hasattr(engine, "get_epsilon"):
            try:
                opacus_eps = float(engine.get_epsilon(float(self.config.dp_delta)))
            except Exception:
                opacus_eps = None
        if opacus_eps is not None:
            budget["opacus_epsilon"] = opacus_eps
            local_eps = float(budget.get("epsilon", math.inf))
            if math.isfinite(opacus_eps) and opacus_eps > local_eps:
                budget["epsilon"] = opacus_eps
                budget["note"] = (
                    "Opacus observed epsilon exceeded the local integer-order "
                    "accountant; stamped the larger privacy spend."
                )
        block = _build_privacy_budget_block(
            path="dp_sgd",
            budget=budget,
            l2_clip=float(self.config.dp_l2_clip),
            implementation="opacus_privacy_engine",
        )
        block["sample_rate_source"] = q_source
        block["requested_steps"] = self._dp_meta.get("requested_steps")
        block["observed_steps"] = steps
        block["grad_accum_effective"] = int(self.config.grad_accum)
        existing = dict(self._dp_meta or {})
        existing["privacy_budget"] = block
        existing["observed_steps"] = steps
        if self._dp_meta_path:
            try:
                with open(self._dp_meta_path, "w", encoding="utf-8") as f:
                    json.dump(existing, f, indent=2, sort_keys=True)
            except OSError as e:
                print(f"distill.py: could not finalize run-meta.dp.json: {e}", file=sys.stderr)
        return block

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
    curriculum: bool = False,
    reasoning_trace_loss_weight: float = 0.0,
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
            DataCollatorForSeq2Seq,
        )
        from peft import LoraConfig, get_peft_model, TaskType
    except ImportError as e:
        raise RuntimeError(
            f"distill.py: missing dependency {e.name}. "
            f"pip install 'transformers>=4.46' 'peft>=0.13' accelerate"
        ) from e

    cfg = config or DistillConfig()
    if cfg.dp_sgd and cfg.grad_accum != 1:
        # Opacus accounts physical private batches. HF gradient accumulation
        # would change the realized mechanism, so DP-SGD forces the effective
        # accumulation to 1 and records that in the config/receipt.
        cfg = replace(cfg, grad_accum=1)
    _validate_dp_config(cfg)
    PrivacyEngine = _require_opacus_privacy_engine() if cfg.dp_sgd else None
    if cfg.dp_sgd and (importance_weights_path or curriculum):
        raise ValueError(
            "distill.py: DP-SGD uses Opacus' private sampler; disable "
            "--importance-weights and --curriculum for this run."
        )
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
    # The HF Trainer moves the STUDENT to its device but does NOT manage the
    # teacher (it is only invoked inside compute_loss). Pin the teacher to the
    # same device as the student/inputs, else the teacher forward hits an
    # index_select device mismatch (teacher weights on CPU, input_ids on CUDA).
    _kd_device = "cuda" if torch.cuda.is_available() else "cpu"
    teacher.to(_kd_device)

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

    # W921-NEXT4 — MoE student detection. Gated: dense students take NO change.
    # We read the BASE config (PEFT wraps it, but .config delegates through).
    # When the student is a sparse-MoE model we set output_router_logits=True
    # on the forward config so compute_loss can read outputs.router_logits and
    # add the load-balancing aux term. _moe_top_k falls back to 2 (the Mixtral
    # / Switch default) when the config doesn't name a top-k.
    student_is_moe = _student_is_moe(student)
    moe_num_experts = 0
    moe_top_k = 0
    if student_is_moe:
        moe_num_experts = _moe_num_experts(student.config)
        moe_top_k = _moe_top_k(student.config) or 2
        # Turn on router-logit output for both the wrapped model config and the
        # underlying base config (PEFT delegates getattr but the forward reads
        # the base model's config object directly).
        try:
            student.config.output_router_logits = True
        except Exception:
            pass
        try:
            base = getattr(student, "base_model", None)
            base_cfg = getattr(getattr(base, "model", base), "config", None)
            if base_cfg is not None:
                base_cfg.output_router_logits = True
        except Exception:
            pass

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

    # W717: curriculum sort applies AFTER pass-filter (W712) and the
    # eval-split shuffle but BEFORE the sampler is chosen, since the trainer
    # walks `rows` in order via SequentialSampler when --curriculum is set.
    curriculum_meta: dict[str, Any] = {
        "curriculum_version": CURRICULUM_VERSION,
        "curriculum_used": False,
    }
    if curriculum:
        rows, sort_meta = _curriculum_sort_rows(rows)
        curriculum_meta = {
            **curriculum_meta,
            "curriculum_used": True,
            **sort_meta,
        }

    train_ds = _PromptResponseDataset(rows, tokenizer, cfg.max_length)
    eval_ds = _PromptResponseDataset(eval_rows, tokenizer, cfg.max_length) if eval_rows else None

    # DataCollatorForSeq2Seq pads BOTH input_ids and the custom variable-length
    # `labels` (prompt positions masked to -100) consistently. The LM collator
    # only handled input_ids, so batches with differing lengths raised a tensor-
    # stacking ValueError on `labels`. label_pad_token_id=-100 keeps padded
    # label positions out of the loss.
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, label_pad_token_id=-100, padding=True)

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
    # W828-3/-4 — when reasoning_trace_loss_weight > 0, ADD a trace-aware
    # cross-entropy term on top of the KD+CE base. Weight=0.0 keeps the loop
    # byte-identical to the W713 baseline (honesty contract).
    rt_loss_w = float(max(0.0, min(1.0, reasoning_trace_loss_weight or 0.0)))

    # W921-NEXT4 — MoE closure state for compute_loss. _moe_aux_last holds the
    # most recent (pre-coefficient) load-balance value so train() can surface
    # moe.aux_loss_last in the summary. Mutable container so the nested
    # compute_loss can write through it (closures can't rebind names).
    _moe_on = bool(student_is_moe)
    _moe_n = int(moe_num_experts)
    _moe_k = int(moe_top_k)
    _moe_coef = float(MOE_DEFAULT_ROUTER_AUX_LOSS_COEF)
    _moe_aux_last = {"value": None}

    class _DistillTrainer(Trainer):
        def get_train_dataloader(self):
            dp_loader = getattr(self, "_kolm_dp_train_dataloader", None)
            if dp_loader is not None:
                return dp_loader
            return super().get_train_dataloader()

        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            labels = inputs.pop("labels")
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]
            # W828-3 — trace_mask is supplied per-row by the dataset when the
            # row carries reasoning_trace; absent → all-zeros (no trace, the
            # trace branch contributes 0 and the answer term carries full
            # weight, identical to W713 behavior).
            trace_mask = inputs.pop("trace_mask", None)

            with torch.no_grad():
                t_out = teacher(input_ids=input_ids, attention_mask=attention_mask).logits
            # W921-NEXT4 — when the student is MoE, request router logits so we
            # can add the load-balancing aux loss. Dense students take the
            # original single-tensor `.logits` path with zero behavioral change.
            if _moe_on:
                s_full = model(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    output_router_logits=True,
                )
                s_out = s_full.logits
            else:
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
            # W828-3 — additive trace-aware loss. Default rt_loss_w == 0.0 so
            # this branch contributes 0 and the loop matches the W713 baseline.
            loss_trace = s_shift.new_zeros(())
            if rt_loss_w > 0 and trace_mask is not None:
                tm_shift = trace_mask[..., 1:].contiguous()
                # answer_mask = response positions AND NOT trace positions.
                # Use the labels mask (l_shift != -100) as the response gate.
                am = mask
                # trace_aware_loss expects full (B,T,V) shapes; we pass
                # unflattened slices so the per-position mask alignment works.
                loss_trace = trace_aware_loss(
                    s_shift, l_shift.clamp(min=0), tm_shift, am, w=rt_loss_w,
                )
                loss = loss + loss_trace
            # W921-NEXT4 — MoE load-balancing aux loss. ADDITIVE and gated on
            # the student being MoE; dense students never enter this branch so
            # the loss is byte-for-byte the KD+CE(+trace) value above.
            loss_moe_aux = s_shift.new_zeros(())
            if _moe_on:
                router_logits = _extract_router_logits(s_full)
                if router_logits is not None:
                    loss_moe_aux = moe_load_balance_loss(
                        router_logits, num_experts=_moe_n, top_k=_moe_k,
                    )
                    # Stash the pre-coefficient value for the run summary.
                    try:
                        _moe_aux_last["value"] = float(loss_moe_aux.detach())
                    except Exception:
                        _moe_aux_last["value"] = None
                    loss = loss + _moe_coef * loss_moe_aux
            if return_outputs:
                outputs = {
                    "loss_kd": loss_kd.detach(),
                    "loss_ce": loss_ce.detach(),
                }
                if rt_loss_w > 0:
                    outputs["loss_trace"] = loss_trace.detach()
                if _moe_on:
                    outputs["loss_moe_aux"] = loss_moe_aux.detach()
                return loss, outputs
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

    # W717: --curriculum WINS over --importance-weights. Curriculum order is a
    # deterministic sweep simple->complex; a WeightedRandomSampler would
    # shuffle that into random order and defeat the point. When both flags are
    # set, log the conflict and drop the weighted sampler.
    if curriculum and weighted_sampler is not None:
        weighted_sampler = None
        importance_meta["importance_weights_used"] = False
        importance_meta["importance_weights_skipped_reason"] = "curriculum_active"
        curriculum_meta["importance_weights_skipped"] = True

    if curriculum:
        _curriculum_sampler = SequentialSampler(train_ds)

        class _DistillTrainerCurriculum(_DistillTrainer):
            def _get_train_sampler(self, *_args, **_kwargs):
                # SequentialSampler walks indices in order — matches the
                # curriculum sort we did pre-dataset.
                return _curriculum_sampler

        trainer = _DistillTrainerCurriculum(
            model=student,
            args=args,
            train_dataset=train_ds,
            eval_dataset=eval_ds,
            data_collator=collator,
        )
    elif weighted_sampler is not None:
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

    dp_privacy_engine = None
    dp_meta: dict[str, Any] = {
        "dp_sgd_requested": bool(cfg.dp_sgd),
        "dp_training_version": DP_TRAINING_VERSION,
    }
    dp_meta_path: Optional[str] = None
    if cfg.dp_sgd:
        q, q_source = _dp_sample_rate(cfg, len(rows))
        requested_steps = _estimate_optimizer_steps(cfg, len(rows))
        requested_budget = compute_dp_sgd_budget(
            noise_multiplier=float(cfg.dp_noise_multiplier),
            sample_rate=q,
            steps=requested_steps,
            delta=float(cfg.dp_delta),
        )
        dp_meta.update({
            "implementation": "opacus_privacy_engine",
            "sample_rate": q,
            "sample_rate_source": q_source,
            "requested_steps": requested_steps,
            "noise_multiplier": float(cfg.dp_noise_multiplier),
            "l2_clip": float(cfg.dp_l2_clip),
            "delta": float(cfg.dp_delta),
            "requested_privacy_budget": _build_privacy_budget_block(
                path="dp_sgd",
                budget=requested_budget,
                l2_clip=float(cfg.dp_l2_clip),
                implementation="opacus_privacy_engine",
            ),
        })
        dp_meta_path = _write_dp_run_meta(out_dir, dp_meta)
        try:
            trainer.create_optimizer()
            base_loader = trainer.get_train_dataloader()
            dp_privacy_engine = PrivacyEngine(accountant="rdp")
            private_model, private_optimizer, private_loader = dp_privacy_engine.make_private(
                module=trainer.model,
                optimizer=trainer.optimizer,
                data_loader=base_loader,
                noise_multiplier=float(cfg.dp_noise_multiplier),
                max_grad_norm=float(cfg.dp_l2_clip),
            )
            trainer.model = private_model
            trainer.model_wrapped = private_model
            trainer.optimizer = private_optimizer
            trainer._kolm_dp_train_dataloader = private_loader
        except Exception as e:
            raise RuntimeError(
                "distill.py: DP-SGD requested but Opacus could not wrap the "
                f"trainer: {e}. Refusing to continue without real DP-SGD."
            ) from e

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

    # W717: stamp run-meta.curriculum.json so the curriculum-sort provenance
    # is recoverable. Always write (even when --curriculum was OFF) so an
    # auditor reading the artifact can confirm the trainer ran with the
    # curriculum knob in the OFF position rather than inferring from absence.
    _write_curriculum_run_meta(out_dir, curriculum_meta)

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
        _dp_meta=dp_meta,
        _dp_meta_path=dp_meta_path,
        _dp_privacy_engine=dp_privacy_engine,
        # W921-NEXT4: thread MoE-student metadata + the mutable aux container
        # so train() can surface moe:{...} (dense students leave these default).
        _moe_is_moe=_moe_on,
        _moe_num_experts=_moe_n,
        _moe_top_k=_moe_k,
        _moe_router_aux_loss_coef=_moe_coef,
        _moe_aux_ref=_moe_aux_last,
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
    block = {
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
    # W921-NEXT4 — surface the MoE block + its references in the receipt ONLY
    # when the student was a sparse-MoE model (dense receipts are unchanged).
    moe_summary = train_summary.get("moe")
    if moe_summary:
        block["moe"] = moe_summary
        block["papers"] = block["papers"] + [
            "arXiv:1701.06538",  # Shazeer 2017 — sparsely-gated MoE + load balance
            "arXiv:2101.03961",  # Fedus 2021 — Switch Transformer aux loss
        ]
    privacy_budget = train_summary.get("privacy_budget")
    if privacy_budget:
        block["privacy_budget"] = privacy_budget
    return block


__all__ = [
    "DistillConfig",
    "DistillSession",
    "KDObjective",
    "distill_trainer",
    "receipt_block",
    "compute_dp_sgd_budget",
    "DP_TRAINING_VERSION",
    # W828-3 — trace-aware loss exposed so a worker harness can call the
    # primitive directly without invoking the full trainer (the bench scaffold
    # bench_trace_aware.py uses this path).
    "trace_aware_loss",
    "REASONING_TRACE_LOSS_VERSION",
    # W921-NEXT4 — MoE-aware distillation primitives exposed for the worker
    # harness + the --self-test-moe path.
    "moe_load_balance_loss",
    "MOE_VERSION",
    "MOE_DEFAULT_ROUTER_AUX_LOSS_COEF",
]


def _self_test_dp() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def _check(name: str, cond: bool, detail: str = "") -> None:
        checks.append({"name": name, "pass": bool(cond), "detail": detail})
        assert cond, f"dp self-test FAILED: {name} ({detail})"

    ref = compute_dp_sgd_budget(
        noise_multiplier=1.1,
        sample_rate=0.01,
        steps=1000,
        delta=1e-5,
    )
    _check(
        "reference_epsilon_conservative",
        1.0 < float(ref["epsilon"]) < 2.2,
        f"epsilon={ref['epsilon']}",
    )
    low_noise = compute_dp_sgd_budget(
        noise_multiplier=0.7, sample_rate=0.01, steps=1000, delta=1e-5,
    )
    high_noise = compute_dp_sgd_budget(
        noise_multiplier=2.0, sample_rate=0.01, steps=1000, delta=1e-5,
    )
    _check(
        "epsilon_monotone_noise",
        float(high_noise["epsilon"]) < float(low_noise["epsilon"]),
        f"low={low_noise['epsilon']} high={high_noise['epsilon']}",
    )
    few = compute_dp_sgd_budget(
        noise_multiplier=1.1, sample_rate=0.01, steps=100, delta=1e-5,
    )
    many = compute_dp_sgd_budget(
        noise_multiplier=1.1, sample_rate=0.01, steps=10000, delta=1e-5,
    )
    _check(
        "epsilon_monotone_steps",
        float(many["epsilon"]) > float(few["epsilon"]),
        f"few={few['epsilon']} many={many['epsilon']}",
    )
    zero = compute_dp_sgd_budget(
        noise_multiplier=0, sample_rate=0.01, steps=10, delta=1e-5,
    )
    zero_block = _build_privacy_budget_block(path="dp_sgd", budget=zero, l2_clip=1.0)
    _check("zero_noise_not_effective", zero_block["dp_effective"] is False)
    _check("infinity_serializes", zero_block["epsilon"] == "Infinity")
    roundtrip = json.loads(json.dumps(
        _build_privacy_budget_block(path="dp_sgd", budget=ref, l2_clip=1.0)
    ))
    _check("privacy_block_json_roundtrip", roundtrip["version"] == DP_TRAINING_VERSION)
    return {
        "ok": True,
        "dp_training_version": DP_TRAINING_VERSION,
        "accountant": DP_ACCOUNTANT,
        "reference_epsilon": ref["epsilon"],
        "checks": checks,
        "n_checks": len(checks),
    }


def _self_test_moe() -> dict[str, Any]:
    """W921-NEXT4 — pure self-test of the MoE-aware additions on SYNTHETIC data.

    No model download: we build fake router_logits over 8 experts and a
    synthetic config, then assert the load-balancing invariants and the dense
    no-op contract. Deterministic (seeded torch); returns
    {ok, checks:[...]} and raises AssertionError on a logic regression."""
    if not _HAS_TORCH:
        return {
            "ok": False,
            "error": "torch_absent",
            "detail": "moe self-test requires torch (it asserts on real tensors)",
            "moe_version": MOE_VERSION,
        }
    torch.manual_seed(0)
    checks: list[dict[str, Any]] = []

    def _check(name: str, cond: bool, detail: str = "") -> None:
        checks.append({"name": name, "pass": bool(cond), "detail": detail})
        assert cond, f"moe self-test FAILED: {name} ({detail})"

    N = 8           # experts
    T = 64          # routed tokens
    K = 2           # top-k

    # --- (detect) synthetic MoE config lights up; dense config does not. ----
    moe_cfg = {"num_local_experts": N, "num_experts_per_tok": K, "hidden_size": 16}
    dense_cfg = {"hidden_size": 16, "intermediate_size": 64}
    _check("detect_moe_config", _student_is_moe(moe_cfg) is True,
           f"num_experts={_moe_num_experts(moe_cfg)}")
    _check("detect_dense_config", _student_is_moe(dense_cfg) is False,
           "dense config must not be flagged MoE")
    _check("detect_top_k", _moe_top_k(moe_cfg) == K, f"got {_moe_top_k(moe_cfg)}")
    # A config reporting <=1 experts is dense (nothing to balance).
    _check("detect_single_expert_is_dense",
           _student_is_moe({"num_experts": 1}) is False)

    # --- (a) aux loss computed + >= 0 on a balanced router. -----------------
    # Perfectly balanced: every expert gets equal logits -> uniform softmax,
    # and a deterministic round-robin top-k selection that hits each expert
    # equally. Build logits so softmax is uniform (all zeros) for P_e, and the
    # f_e term is uniform by construction of the topk on a tie-broken arange.
    balanced = torch.zeros(T, N)
    # Make each token prefer a rotating pair of experts so top-2 selection is
    # perfectly even across all 8 experts (T divisible by N).
    for t in range(T):
        e0 = t % N
        e1 = (t + 1) % N
        balanced[t, e0] = 1e-6 * 0  # keep uniform-ish; selection driven below
    # To get an exactly-even top-k WITHOUT disturbing the (near) uniform P_e,
    # we nudge two rotating experts by a tiny epsilon so topk picks them.
    eps = 1e-3
    for t in range(T):
        balanced[t, t % N] += eps
        balanced[t, (t + 1) % N] += eps
    aux_balanced = moe_load_balance_loss(balanced, num_experts=N, top_k=K)
    _check("aux_is_scalar", aux_balanced.dim() == 0, f"shape={tuple(aux_balanced.shape)}")
    _check("aux_nonneg", float(aux_balanced) >= 0.0, f"got {float(aux_balanced)}")

    # --- (b) balanced ~= minimal baseline; collapsed router is HIGHER. ------
    # Minimal value for the Switch/Mixtral normalization is top_k: a perfectly
    # balanced router gives every expert f_e = k/N (each of the N experts wins
    # k/N of the token-slots) and P_e = 1/N, so
    #   sum_e f_e*P_e = N * (k/N)(1/N) = k/N,  times num_experts N = k.
    # The balanced router should sit very close to that top_k floor.
    _check("aux_balanced_near_baseline",
           abs(float(aux_balanced) - float(K)) < 0.05,
           f"balanced aux={float(aux_balanced)} (expected ~top_k={K})")
    # Collapsed: every token routes (overwhelmingly) to expert 0.
    collapsed = torch.full((T, N), -10.0)
    collapsed[:, 0] = 10.0
    collapsed[:, 1] = 5.0   # second-best so top-2 is well-defined
    aux_collapsed = moe_load_balance_loss(collapsed, num_experts=N, top_k=K)
    _check("aux_collapsed_higher_than_balanced",
           float(aux_collapsed) > float(aux_balanced) + 0.5,
           f"collapsed={float(aux_collapsed)} balanced={float(aux_balanced)}")
    # Collapsed term penalizes imbalance: must exceed the balanced floor clearly
    # and stay within the theoretical ceiling (num_experts).
    _check("aux_collapsed_bounded",
           float(aux_balanced) <= float(aux_collapsed) <= float(N) + 1e-3,
           f"collapsed={float(aux_collapsed)} ceiling={N}")

    # --- multi-layer tuple averages per layer (HF router_logits convention). -
    aux_tuple = moe_load_balance_loss((balanced, collapsed), num_experts=N, top_k=K)
    mean_of_two = 0.5 * (float(aux_balanced) + float(aux_collapsed))
    _check("aux_tuple_is_layer_mean",
           abs(float(aux_tuple) - mean_of_two) < 1e-4,
           f"tuple={float(aux_tuple)} mean={mean_of_two}")

    # --- (c) dense path adds ZERO aux. --------------------------------------
    # _extract_router_logits returns None for a dense output (no router_logits
    # attribute) so the aux term is never added. We model a dense forward
    # output as a plain object without router_logits.
    class _DenseOut:
        router_logits = None
    _check("dense_extract_none",
           _extract_router_logits(_DenseOut()) is None,
           "dense output must expose no router_logits")
    _check("dense_extract_dict_none",
           _extract_router_logits({"logits": "x"}) is None,
           "dict output without router_logits must yield None")
    # And the aux helper itself returns a 0 scalar when handed an empty/dense
    # layer list (defense-in-depth; the caller gates on _student_is_moe).
    aux_empty = moe_load_balance_loss([None], num_experts=N, top_k=K)
    _check("aux_dense_layer_zero", float(aux_empty) == 0.0,
           f"got {float(aux_empty)}")
    # num_experts < 2 -> 0 scalar (a dense student that somehow reached here).
    aux_one = moe_load_balance_loss(balanced, num_experts=1, top_k=1)
    _check("aux_single_expert_zero", float(aux_one) == 0.0, f"got {float(aux_one)}")

    # --- attention-mask path: padded tokens excluded from the statistics. ----
    am = torch.ones(T)
    am[T // 2:] = 0.0  # mask the back half
    aux_masked = moe_load_balance_loss(balanced, num_experts=N, top_k=K,
                                       attention_mask=am)
    _check("aux_masked_nonneg", float(aux_masked) >= 0.0, f"got {float(aux_masked)}")
    _check("aux_masked_scalar", aux_masked.dim() == 0)

    # --- determinism: same inputs -> same output. ---------------------------
    aux_again = moe_load_balance_loss(balanced, num_experts=N, top_k=K)
    _check("aux_deterministic",
           abs(float(aux_balanced) - float(aux_again)) < 1e-9,
           f"{float(aux_balanced)} vs {float(aux_again)}")

    return {
        "ok": True,
        "checks": checks,
        "n_checks": len(checks),
        "moe_version": MOE_VERSION,
        "router_aux_loss_coef_default": MOE_DEFAULT_ROUTER_AUX_LOSS_COEF,
        "aux_balanced": float(aux_balanced),
        "aux_collapsed": float(aux_collapsed),
    }


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
    p.add_argument("--grad-accum", type=int, default=DistillConfig.grad_accum,
                   help="Gradient accumulation steps. DP-SGD forces the effective value to 1.")
    p.add_argument("--learning-rate", type=float, default=DistillConfig.learning_rate)
    p.add_argument("--lora-r", type=int, default=DistillConfig.lora_r)
    p.add_argument("--lora-alpha", type=int, default=DistillConfig.lora_alpha)
    p.add_argument("--max-length", type=int, default=DistillConfig.max_length)
    p.add_argument("--print-config", action="store_true",
                   help="Print the resolved DistillConfig as JSON and exit; do not load any models.")
    # W921-NEXT4 — pure self-test of the MoE-aware load-balancing additions on
    # SYNTHETIC router logits (no model download, no network). Exits 0 on pass,
    # 5 on a logic regression — mirrors the ropd.py --self-test contract.
    p.add_argument("--self-test-moe", dest="self_test_moe", action="store_true",
                   help="Run the synthetic MoE load-balancing self-test (no torch model "
                        "download, no network) and exit. Exit 0 pass / 5 fail.")
    p.add_argument("--self-test-dp", dest="self_test_dp", action="store_true",
                   help="Run the synthetic DP-SGD accountant self-test (no model download, "
                        "no Opacus import) and exit. Exit 0 pass / 5 fail.")
    p.set_defaults(dp_sgd=_env_truthy("KOLM_DP_SGD", False))
    p.add_argument("--dp-sgd", dest="dp_sgd", action="store_true",
                   help="Enable Opacus DP-SGD for the student trainer. Fails loud if Opacus "
                        "is unavailable or the DP knobs are invalid. Also enabled by "
                        "KOLM_DP_SGD=1.")
    p.add_argument("--no-dp-sgd", dest="dp_sgd", action="store_false",
                   help="Disable DP-SGD even if KOLM_DP_SGD is set.")
    p.add_argument("--dp-l2-clip", dest="dp_l2_clip", type=float,
                   default=_env_float("KOLM_DP_L2_CLIP", DistillConfig.dp_l2_clip),
                   help="DP-SGD per-example L2 clipping norm. Env: KOLM_DP_L2_CLIP.")
    p.add_argument("--dp-noise-multiplier", dest="dp_noise_multiplier", type=float,
                   default=_env_float("KOLM_DP_NOISE_MULTIPLIER", DistillConfig.dp_noise_multiplier),
                   help="DP-SGD Gaussian noise multiplier. Must be >0 when DP is enabled. "
                        "Env: KOLM_DP_NOISE_MULTIPLIER.")
    p.add_argument("--dp-delta", dest="dp_delta", type=float,
                   default=_env_float("KOLM_DP_DELTA", DistillConfig.dp_delta),
                   help="Target DP delta. Env: KOLM_DP_DELTA.")
    p.add_argument("--dp-sample-rate", dest="dp_sample_rate", type=float,
                   default=_env_float("KOLM_DP_SAMPLE_RATE", DistillConfig.dp_sample_rate),
                   help="Override DP sample rate q. Defaults to batch_size/n_train. "
                        "Env: KOLM_DP_SAMPLE_RATE.")
    p.add_argument("--dp-steps", dest="dp_steps", type=int,
                   default=_env_int("KOLM_DP_STEPS", DistillConfig.dp_steps),
                   help="Override requested DP optimizer steps for pre-run accounting. "
                        "The final receipt reconciles against observed global_step. "
                        "Env: KOLM_DP_STEPS.")
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
    # W717: curriculum-distillation flag. When set, sort training rows by
    # ascending complexity_proxy (computed JS-side by src/curriculum-sort.js
    # and stamped on each JSONL row), then walk them with SequentialSampler.
    # Wins over --importance-weights when both are set (logged in
    # run-meta.curriculum.json).
    p.add_argument("--curriculum", dest="curriculum", action="store_true",
                   default=False,
                   help="W717 curriculum-distillation: sort rows by ascending "
                        "complexity_proxy and walk them with SequentialSampler. "
                        "Wins over --importance-weights when both are set.")
    # W828-4 — trace-aware loss weight. Default 0.0 → behaves identically to
    # the W713 baseline (the trace branch contributes 0). Values up to 1.0
    # progressively shift loss mass toward reasoning-trace tokens vs final-
    # answer tokens. Env var KOLM_REASONING_TRACE_LOSS_WEIGHT overrides the
    # default when the flag is omitted so the worker can be configured
    # without changing the CLI invocation.
    _env_rt_weight = os.environ.get("KOLM_REASONING_TRACE_LOSS_WEIGHT", "")
    try:
        _env_rt_weight_val = float(_env_rt_weight) if _env_rt_weight else 0.0
    except ValueError:
        _env_rt_weight_val = 0.0
    p.add_argument("--reasoning-trace-loss-weight", dest="reasoning_trace_loss_weight",
                   type=float, default=_env_rt_weight_val,
                   help="W828 trace-aware loss weight in [0.0, 1.0]. Default 0.0 "
                        "behaves identically to the W713 baseline; values >0 add "
                        "a per-position weighted CE term over <think>..</think> "
                        "trace tokens vs final-answer tokens. Overridable via "
                        "env KOLM_REASONING_TRACE_LOSS_WEIGHT when flag omitted.")
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
        grad_accum=args.grad_accum,
        num_epochs=args.num_epochs,
        seed=args.seed,
        eval_split=args.eval_split,
        dp_sgd=bool(args.dp_sgd),
        dp_l2_clip=args.dp_l2_clip,
        dp_noise_multiplier=args.dp_noise_multiplier,
        dp_delta=args.dp_delta,
        dp_sample_rate=args.dp_sample_rate,
        dp_steps=args.dp_steps,
    )


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    # W921-NEXT4 — synthetic MoE self-test runs first (no models, no network).
    if getattr(args, "self_test_moe", False):
        try:
            env = _self_test_moe()
        except AssertionError as e:
            print(json.dumps(
                {"ok": False, "error": "self_test_moe_failed", "detail": str(e),
                 "moe_version": MOE_VERSION},
                indent=2,
            ))
            return 5
        print(json.dumps(env, indent=2))
        return 0 if env.get("ok") else 5
    if getattr(args, "self_test_dp", False):
        try:
            env = _self_test_dp()
        except AssertionError as e:
            print(json.dumps(
                {"ok": False, "error": "self_test_dp_failed", "detail": str(e),
                 "dp_training_version": DP_TRAINING_VERSION},
                indent=2,
            ))
            return 5
        print(json.dumps(env, indent=2))
        return 0 if env.get("ok") else 5
    cfg = _config_from_args(args)
    if cfg.dp_sgd and cfg.grad_accum != 1:
        cfg = replace(cfg, grad_accum=1)
    try:
        _validate_dp_config(cfg)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
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
    # W828-4 — clamp into [0.0, 1.0] defensively; the trainer itself also
    # clamps, but logging an out-of-range value here aids debugging.
    rt_weight = float(max(0.0, min(1.0, args.reasoning_trace_loss_weight or 0.0)))
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
        curriculum=args.curriculum,
        reasoning_trace_loss_weight=rt_weight,
    )
    summary = session.train()
    receipt = receipt_block(session, summary)
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
