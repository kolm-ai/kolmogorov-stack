"""
apps/trainer/merge.py

Adapter merging. Compose specialist LoRAs into one artifact.

After SFT + preference + GRPO, a buyer often ends up with several adapters
they want to combine: a refund-flagger, a PII-redactor, a tone-of-voice
adapter, a domain-jargon adapter. There are four ways to merge them, with
different math and different failure modes:

    linear          weighted sum of weights. Equivalent to task-arithmetic
                    with the original signs. Simplest and surprisingly strong
                    when the tasks don't conflict.

    slerp           spherical linear interpolation. Two-model only. Treats
                    each weight matrix as a point on a hypersphere and walks
                    the great-circle. Good for "midpoint" of two models.

    dare            DARE (Drop And REscale): for each parameter, drop with
                    probability p, rescale the rest by 1/(1-p). Reduces
                    interference between adapters with overlapping fine-tuning
                    deltas.

    ties            TIES-Merging (TRIM, Elect Sign, Disjoint Merge): trim
                    small magnitudes per-parameter, vote on sign across
                    adapters, then average only the agreeing-sign weights.
                    Best on multi-task suites in the Yadav 2023 paper.

mergekit (Goddard et al 2024, arXiv:2403.13257) is the reference open-source
implementation. This module re-implements the same recipes in a kolm-native
form so the merge step lives inside our trainer and produces a receipt block
identical in shape to SFT and GRPO. The merged result is a flat state-dict
that can be repacked as a single LoRA artifact.

Surface:

    from apps.trainer.merge import merge_state_dicts, MergeConfig

    merged = merge_state_dicts(
        adapters={
            "refund":  torch.load("refund/adapter_model.bin"),
            "pii":     torch.load("pii/adapter_model.bin"),
            "tone":    torch.load("tone/adapter_model.bin"),
        },
        config=MergeConfig(
            method="ties",
            weights={"refund": 0.5, "pii": 0.3, "tone": 0.2},
            density=0.5,
        ),
    )

Citations:
  TIES:          Yadav et al 2023, arXiv:2306.01708
  DARE:          Yu et al 2023, arXiv:2311.03099
  SLERP:         Shoemake 1985, ACM SIGGRAPH
  mergekit:      Goddard et al 2024, arXiv:2403.13257
  Task arith:    Ilharco et al 2023, arXiv:2212.04089
"""

from __future__ import annotations

import dataclasses
import logging
import math
from typing import Any, Iterable, Literal, Mapping, Optional

logger = logging.getLogger(__name__)

MergeMethod = Literal["linear", "slerp", "dare", "ties"]
VALID_METHODS: tuple[str, ...] = ("linear", "slerp", "dare", "ties")


@dataclasses.dataclass(frozen=True)
class MergeConfig:
    """
    method      one of linear, slerp, dare, ties
    weights     per-adapter weight; defaults to uniform 1/N
    density     for dare/ties: fraction of params kept (1.0 = no drop, 0.5 = drop half)
    slerp_t     for slerp: interpolation parameter in [0,1]
    seed        rng seed for dare random drops
    """

    method: MergeMethod = "ties"
    weights: Optional[Mapping[str, float]] = None
    density: float = 0.5
    slerp_t: float = 0.5
    seed: int = 42


def _import_torch():
    try:
        import torch  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "torch is not installed. install with: pip install torch"
        ) from e
    return torch


def _validate(adapters: Mapping[str, Mapping[str, Any]], cfg: MergeConfig) -> None:
    if cfg.method not in VALID_METHODS:
        raise ValueError(f"method must be one of {VALID_METHODS}, got {cfg.method!r}")
    if len(adapters) < 2:
        raise ValueError(f"need >= 2 adapters to merge, got {len(adapters)}")
    if cfg.method == "slerp" and len(adapters) != 2:
        raise ValueError(
            f"slerp requires exactly 2 adapters, got {len(adapters)}; "
            f"use linear or ties for 3+"
        )
    if not (0.0 < cfg.density <= 1.0):
        raise ValueError(f"density must be in (0, 1], got {cfg.density}")
    if not (0.0 <= cfg.slerp_t <= 1.0):
        raise ValueError(f"slerp_t must be in [0, 1], got {cfg.slerp_t}")

    # Ensure all adapters share the same key set.
    key_sets = [set(state.keys()) for state in adapters.values()]
    if any(ks != key_sets[0] for ks in key_sets[1:]):
        only_first = key_sets[0] - set.union(*key_sets[1:])
        only_rest = set.union(*key_sets[1:]) - key_sets[0]
        raise ValueError(
            f"adapters disagree on parameter keys; "
            f"first-only={sorted(only_first)[:3]}... rest-only={sorted(only_rest)[:3]}..."
        )


def _normalized_weights(adapters: Mapping[str, Any], cfg: MergeConfig) -> dict[str, float]:
    if cfg.weights is None:
        n = len(adapters)
        return {k: 1.0 / n for k in adapters}
    missing = set(adapters) - set(cfg.weights)
    if missing:
        raise ValueError(f"weights missing for adapters: {sorted(missing)}")
    total = sum(float(cfg.weights[k]) for k in adapters)
    if total <= 0:
        raise ValueError(f"weights must sum to a positive value, got {total}")
    return {k: float(cfg.weights[k]) / total for k in adapters}


def merge_state_dicts(
    *,
    adapters: Mapping[str, Mapping[str, Any]],
    config: Optional[MergeConfig] = None,
) -> dict[str, Any]:
    """
    Merge multiple LoRA state-dicts into one. Returns a new state-dict with
    the same keys.

    Caller should hand us state_dicts already loaded into the same dtype
    and on the same device (or all on CPU). We do not cast.
    """
    cfg = config or MergeConfig()
    torch = _import_torch()
    _validate(adapters, cfg)
    weights = _normalized_weights(adapters, cfg)

    if cfg.method == "linear":
        return _merge_linear(adapters, weights, torch)
    if cfg.method == "slerp":
        return _merge_slerp(adapters, cfg, torch)
    if cfg.method == "dare":
        return _merge_dare(adapters, weights, cfg, torch)
    if cfg.method == "ties":
        return _merge_ties(adapters, weights, cfg, torch)
    raise AssertionError(f"unreachable: method={cfg.method}")


def _merge_linear(
    adapters: Mapping[str, Mapping[str, Any]], weights: Mapping[str, float], torch
) -> dict[str, Any]:
    keys = list(next(iter(adapters.values())).keys())
    merged: dict[str, Any] = {}
    for k in keys:
        acc = None
        for name, state in adapters.items():
            w = weights[name]
            t = state[k]
            if acc is None:
                acc = w * t.float()
            else:
                acc = acc + w * t.float()
        merged[k] = acc.to(next(iter(adapters.values()))[k].dtype)
    return merged


def _merge_slerp(
    adapters: Mapping[str, Mapping[str, Any]], cfg: MergeConfig, torch
) -> dict[str, Any]:
    names = list(adapters.keys())
    a, b = adapters[names[0]], adapters[names[1]]
    t = cfg.slerp_t
    merged: dict[str, Any] = {}
    for k in a.keys():
        va = a[k].float().flatten()
        vb = b[k].float().flatten()
        # angle between the two flattened tensors
        denom = (va.norm() * vb.norm()).clamp_min(1e-12)
        cos_theta = (va @ vb) / denom
        cos_theta = cos_theta.clamp(-1.0, 1.0)
        theta = torch.arccos(cos_theta)
        sin_theta = torch.sin(theta).clamp_min(1e-8)
        # SLERP formula. When theta is tiny, fall back to linear interpolation.
        if sin_theta < 1e-6:
            out_flat = (1 - t) * va + t * vb
        else:
            s_a = torch.sin((1 - t) * theta) / sin_theta
            s_b = torch.sin(t * theta) / sin_theta
            out_flat = s_a * va + s_b * vb
        merged[k] = out_flat.reshape(a[k].shape).to(a[k].dtype)
    return merged


def _merge_dare(
    adapters: Mapping[str, Mapping[str, Any]],
    weights: Mapping[str, float],
    cfg: MergeConfig,
    torch,
) -> dict[str, Any]:
    # DARE: per adapter, sample a Bernoulli mask with probability `density`
    # (keep p, drop 1-p), rescale kept by 1/density, then linear-sum.
    g = torch.Generator()
    g.manual_seed(cfg.seed)
    keys = list(next(iter(adapters.values())).keys())
    merged: dict[str, Any] = {}
    p = cfg.density
    for k in keys:
        acc = None
        for name, state in adapters.items():
            t = state[k].float()
            mask = torch.bernoulli(torch.full_like(t, p), generator=g)
            masked = mask * t / p
            scaled = weights[name] * masked
            acc = scaled if acc is None else acc + scaled
        merged[k] = acc.to(next(iter(adapters.values()))[k].dtype)
    return merged


def _merge_ties(
    adapters: Mapping[str, Mapping[str, Any]],
    weights: Mapping[str, float],
    cfg: MergeConfig,
    torch,
) -> dict[str, Any]:
    # TIES: 1) trim small-magnitude params per adapter, 2) elect sign by sum,
    # 3) merge only the entries whose sign agrees with the elected sign.
    keys = list(next(iter(adapters.values())).keys())
    merged: dict[str, Any] = {}
    keep_q = cfg.density

    for k in keys:
        adapter_tensors: list[tuple[str, Any]] = []
        for name, state in adapters.items():
            t = state[k].float()
            # Per-parameter trim: keep top-keep_q by magnitude, zero the rest.
            flat = t.abs().flatten()
            if flat.numel() == 0:
                adapter_tensors.append((name, t))
                continue
            kth = max(1, int(flat.numel() * keep_q))
            threshold = torch.topk(flat, kth).values.min()
            trimmed = torch.where(t.abs() >= threshold, t, torch.zeros_like(t))
            adapter_tensors.append((name, trimmed))

        # Elect sign by weighted sum of signs.
        sign_sum = None
        for name, t in adapter_tensors:
            s = torch.sign(t) * weights[name]
            sign_sum = s if sign_sum is None else sign_sum + s
        elected_sign = torch.sign(sign_sum)

        # Sum the agreeing entries, normalized by the number of agreeing adapters.
        acc = None
        agree_count = None
        for name, t in adapter_tensors:
            agree = (torch.sign(t) == elected_sign) & (t != 0)
            contrib = torch.where(agree, weights[name] * t, torch.zeros_like(t))
            acc = contrib if acc is None else acc + contrib
            agree_count = agree.float() if agree_count is None else agree_count + agree.float()
        # Avoid /0; entries where no adapter agreed end up zero anyway.
        denom = torch.where(agree_count > 0, agree_count, torch.ones_like(agree_count))
        merged_t = acc / denom * sum(weights.values())  # rescale back
        merged[k] = merged_t.to(next(iter(adapters.values()))[k].dtype)
    return merged


def receipt_block(
    cfg: MergeConfig,
    *,
    adapter_ids: Iterable[str],
    weights: Optional[Mapping[str, float]] = None,
    merge_space: str = "factor",
    out_rank: Optional[int] = None,
    svd_rank: Optional[int] = None,
) -> dict[str, Any]:
    """Stable receipt sub-block recording how a merged adapter was composed.

    W921: merge_space records whether the merge ran in delta-W space ('delta_w',
    the correct LoRA path) or by merging A/B factors separately ('factor', the
    rank-locked footgun path) or as a record-only stub ('record_only')."""
    return {
        "algo": f"merge.{cfg.method}",
        "adapter_ids": list(adapter_ids),
        "weights": dict(weights) if weights else None,
        "density": float(cfg.density),
        "slerp_t": float(cfg.slerp_t),
        "seed": int(cfg.seed),
        "merge_space": merge_space,
        "out_rank": int(out_rank) if out_rank is not None else None,
        "svd_rank": int(svd_rank) if svd_rank is not None else None,
        "papers": [
            "arXiv:2306.01708",  # TIES
            "arXiv:2311.03099",  # DARE
            "arXiv:2406.11617",  # DELLA
            "arXiv:2410.19735",  # KnOTS (SVD-align LoRA before merge)
            "arXiv:2403.13257",  # mergekit
            "arXiv:2212.04089",  # task arithmetic
        ],
        "schema_version": "merge.v2",
    }


# =============================================================================
# W921 — delta-W-space LoRA merge (the CORRECT path) + DELLA + dare_ties.
#
# Merging LoRA A and B FACTORS separately (merge_state_dicts above) is NOT equal
# to merging the products B@A and is only valid at identical rank — a documented
# PEFT footgun. The functions below reconstruct delta_W_i = scale_i * B_i @ A_i,
# run the merge method IN DELTA-W SPACE, then SVD-refactorize back to (A,B) at a
# chosen output rank so the merged adapter loads on the original frozen base.
# =============================================================================

def _flat_delta(dw, density: float, torch):
    """Magnitude-prune (TRIM) a delta tensor to the top-`density` fraction."""
    if density >= 1.0:
        return dw
    flat = dw.abs().flatten()
    if flat.numel() == 0:
        return dw
    k = max(1, int(flat.numel() * density))
    threshold = torch.topk(flat, k).values.min()
    return torch.where(dw.abs() >= threshold, dw, torch.zeros_like(dw))


def _ties_elect_and_merge(deltas, weights, torch):
    """TIES on a list of (name, delta) pairs already trimmed: elect a per-coord
    sign, then average only the sign-agreeing entries."""
    sign_sum = None
    for name, dw in deltas:
        s = torch.sign(dw) * weights[name]
        sign_sum = s if sign_sum is None else sign_sum + s
    elected = torch.sign(sign_sum)
    acc = None
    agree_count = None
    for name, dw in deltas:
        agree = (torch.sign(dw) == elected) & (dw != 0)
        contrib = torch.where(agree, weights[name] * dw, torch.zeros_like(dw))
        acc = contrib if acc is None else acc + contrib
        agree_count = agree.float() if agree_count is None else agree_count + agree.float()
    denom = torch.where(agree_count > 0, agree_count, torch.ones_like(agree_count))
    return acc / denom * sum(weights.values())


def _merge_della(deltas, weights, cfg: MergeConfig, torch):
    """DELLA (arXiv:2406.11617): rank coordinates by magnitude WITHIN each row
    and assign drop probability INVERSELY proportional to magnitude (keep big
    changes), rescale survivors by 1/keep_prob, then TIES-merge."""
    g = torch.Generator()
    g.manual_seed(cfg.seed)
    p_keep_max = cfg.density  # the largest-magnitude coord keeps with this prob
    processed = []
    for name, dw in deltas:
        flat = dw.flatten()
        n = flat.numel()
        if n == 0:
            processed.append((name, dw))
            continue
        # Rank by magnitude -> normalized rank in [0,1]; keep_prob scales with rank.
        order = torch.argsort(flat.abs())  # ascending magnitude
        ranks = torch.empty_like(order, dtype=torch.float)
        ranks[order] = torch.arange(n, dtype=torch.float, device=flat.device)
        norm_rank = ranks / max(n - 1, 1)  # 0 = smallest, 1 = largest
        keep_prob = (0.1 + (p_keep_max - 0.1) * norm_rank).clamp(0.0, 1.0)
        mask = torch.bernoulli(keep_prob, generator=g)
        survivors = torch.where(mask > 0, flat / keep_prob.clamp_min(1e-6), torch.zeros_like(flat))
        processed.append((name, survivors.reshape(dw.shape)))
    return _ties_elect_and_merge(processed, weights, torch)


def _merge_dare_ties(deltas, weights, cfg: MergeConfig, torch):
    """DARE drop+rescale, then TIES sign-election (dare_ties)."""
    g = torch.Generator()
    g.manual_seed(cfg.seed)
    p = cfg.density
    processed = []
    for name, dw in deltas:
        mask = torch.bernoulli(torch.full_like(dw, p), generator=g)
        processed.append((name, mask * dw / p))
    return _ties_elect_and_merge(processed, weights, torch)


def _svd_refactor(merged_dw, scale: float, out_rank: int, torch):
    """SVD-refactorize a merged delta-W back to (A, B) at out_rank such that
    (alpha/r) * B @ A == merged_dw approximately. We fold the LoRA scale into B
    so the saved adapter reconstructs the merged delta when applied with the
    same alpha/r. Returns (A [r x in], B [out x r])."""
    U, S, Vh = torch.linalg.svd(merged_dw.float(), full_matrices=False)
    r = min(out_rank, S.numel())
    U_r = U[:, :r]
    S_r = S[:r]
    Vh_r = Vh[:r, :]
    sqrt_s = torch.sqrt(S_r)
    # B = U_r * sqrt(S) / scale ; A = sqrt(S) * Vh_r  -> scale * B @ A == U S Vh
    B = (U_r * sqrt_s.unsqueeze(0)) / max(scale, 1e-8)
    A = sqrt_s.unsqueeze(1) * Vh_r
    return A, B


def merge_lora_deltas(
    *,
    adapters: Mapping[str, Mapping[str, Any]],
    lora_scales: Mapping[str, float],
    config: Optional[MergeConfig] = None,
    out_rank: Optional[int] = None,
) -> dict[str, Any]:
    """Reconstruct dW_i = scale_i * B_i @ A_i per adapter and per LoRA module,
    merge in dW-space, then SVD back to (A, B) at out_rank. Returns
    {state_dict, merge_space:'delta_w', out_rank}.

    adapters[name] is a state-dict mapping with PEFT lora_A/lora_B keys. We pair
    lora_A.<m>.weight with lora_B.<m>.weight by module path.
    """
    cfg = config or MergeConfig()
    torch = _import_torch()
    names = list(adapters.keys())
    if len(names) < 2:
        raise ValueError(f"merge_lora_deltas needs >= 2 adapters, got {len(names)}")
    # normalize weights
    if cfg.weights is None:
        weights = {k: 1.0 / len(names) for k in names}
    else:
        total = sum(float(cfg.weights[k]) for k in names)
        weights = {k: float(cfg.weights[k]) / total for k in names}

    # Discover LoRA module roots from the first adapter (keys like
    # "...lora_A.weight" / "...lora_A.default.weight").
    first = adapters[names[0]]

    def _module_roots(sd):
        roots = set()
        for k in sd.keys():
            if "lora_A" in k:
                roots.add(k.replace("lora_A", "<X>"))
        return roots

    roots = _module_roots(first)
    out_state: dict[str, Any] = {}
    max_in_rank = 0
    for a_key_tmpl in sorted(roots):
        b_key_tmpl = a_key_tmpl  # same template, swap marker
        a_key = a_key_tmpl.replace("<X>", "lora_A")
        b_key = a_key_tmpl.replace("<X>", "lora_B")
        # Reconstruct each adapter's dW for this module.
        deltas = []
        ref_scale = None
        for name in names:
            sd = adapters[name]
            if a_key not in sd or b_key not in sd:
                continue
            A = sd[a_key].float()  # [r, in]
            B = sd[b_key].float()  # [out, r]
            r = A.shape[0]
            max_in_rank = max(max_in_rank, r)
            scale = float(lora_scales.get(name, 1.0))
            ref_scale = scale if ref_scale is None else ref_scale
            dw = scale * (B @ A)  # [out, in]
            deltas.append((name, dw))
        if len(deltas) < 1:
            continue
        # Trim then merge per method.
        method = cfg.method
        if method in ("ties",):
            trimmed = [(n, _flat_delta(dw, cfg.density, torch)) for n, dw in deltas]
            merged = _ties_elect_and_merge(trimmed, weights, torch)
        elif method == "dare_ties":
            merged = _merge_dare_ties(deltas, weights, cfg, torch)
        elif method == "della":
            merged = _merge_della(deltas, weights, cfg, torch)
        elif method in ("dare", "dare_linear"):
            g = torch.Generator(); g.manual_seed(cfg.seed)
            acc = None
            for n, dw in deltas:
                mask = torch.bernoulli(torch.full_like(dw, cfg.density), generator=g)
                contrib = weights[n] * mask * dw / cfg.density
                acc = contrib if acc is None else acc + contrib
            merged = acc
        else:  # linear / svd / task-arithmetic
            acc = None
            for n, dw in deltas:
                contrib = weights[n] * dw
                acc = contrib if acc is None else acc + contrib
            merged = acc
        # SVD refactor back to (A, B).
        chosen_rank = out_rank or max_in_rank or 16
        A_m, B_m = _svd_refactor(merged, ref_scale or 1.0, chosen_rank, torch)
        out_state[a_key] = A_m.to(first[a_key].dtype if a_key in first else torch.float32)
        out_state[b_key] = B_m.to(first[b_key].dtype if b_key in first else torch.float32)
    return {
        "state_dict": out_state,
        "merge_space": "delta_w",
        "out_rank": out_rank or max_in_rank,
    }


def merge_lora_to_base(
    *,
    adapter_dir: str,
    base_model: str | None,
    out_dir: str,
) -> str:
    """
    Bake a LoRA adapter directly into the base model and save the merged
    weights to `out_dir` in HF format. Used by the native-backend exporters
    (apps/export/) so downstream converters (gguf, mlx, onnx, tensorrt) can
    operate on a single full-weight model.

    `adapter_dir` must contain `adapter_config.json` and `adapter_model.*`
    (peft layout). `base_model` defaults to whatever `base_model_name_or_path`
    field is in adapter_config; pass an override to point at a local copy.

    Returns the absolute path of the merged dir on success.
    """
    import json
    import os
    from pathlib import Path

    adapter_dir = Path(adapter_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not adapter_dir.exists():
        raise FileNotFoundError(f"adapter_dir not found: {adapter_dir}")
    cfg_path = adapter_dir / "adapter_config.json"
    if not cfg_path.exists():
        raise FileNotFoundError(
            f"adapter_config.json missing under {adapter_dir} — "
            "this is not a peft LoRA layout"
        )

    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    base = base_model or cfg.get("base_model_name_or_path")
    if not base:
        raise ValueError(
            "base_model not supplied and adapter_config has no base_model_name_or_path"
        )

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import PeftModel
    except Exception as e:
        raise RuntimeError(
            "merge_lora_to_base needs torch + transformers + peft. "
            "Install: pip install torch transformers peft safetensors"
        ) from e

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=dtype, low_cpu_mem_usage=True)
    model = PeftModel.from_pretrained(model, str(adapter_dir))
    merged = model.merge_and_unload()
    merged.save_pretrained(str(out_dir), safe_serialization=True)

    try:
        tok = AutoTokenizer.from_pretrained(base)
        tok.save_pretrained(str(out_dir))
    except Exception:
        # Tokenizer is optional for some downstream converters; skip silently.
        pass

    return os.path.abspath(str(out_dir))


__all__ = [
    "MergeConfig",
    "MergeMethod",
    "VALID_METHODS",
    "merge_state_dicts",
    "merge_lora_to_base",
    "receipt_block",
    # W921 delta-W path
    "merge_lora_deltas",
]
