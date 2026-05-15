"""
apps/trainer/lora_variants.py

Modern LoRA variants beyond the 2021 baseline.

LoRA (Hu et al 2021, arXiv:2106.09685) ships as the default in PEFT. It is
not the only useful low-rank update. This module exposes the variants that
beat plain LoRA on at least one of:

    - sample efficiency (fewer captures needed for the same K-score)
    - VRAM at train time
    - final K-score on the held-out eval pack

Variants:

    LoRA      baseline                            (PEFT LoraConfig)
    rsLoRA    rank-stabilized                     (use_rslora=True in PEFT >= 0.7)
    LoRA+     separate LR for A and B matrices    (custom optimizer hook)
    DoRA      weight-decomposed LoRA              (use_dora=True in PEFT >= 0.9)
    LoRA-FA   LoRA with frozen A                  (trainable_token_indices=B-only)
    NEFTune   noise embeddings during forward     (TrainingArguments.neftune_noise_alpha)

Selection guide:

    variant   gain over LoRA              cost           use when
    -----------------------------------------------------------------------
    rsLoRA    +stable at rank > 32        free           rank >= 32 (most distills)
    DoRA      +0.5-1.5 pp K-score         ~10% slower    final-mile quality push
    LoRA+     +1-3 pp K-score             free           small-data regime (<1k pairs)
    LoRA-FA   -25% trainable params       free           tight VRAM, small model
    NEFTune   +0.5-2 pp instruction-foll. free           SFT instruction tuning

These compose. The default kolm config when --quality flag is set:

    rsLoRA=True + DoRA=True + LoRA+=True + NEFTune_alpha=5.0

This module never imports peft or trl at module load — they import on call.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)


@dataclasses.dataclass
class LoraVariantConfig:
    """Plain dataclass describing which variants to enable. Maps to PEFT LoraConfig
    and our optimizer param-group splitter."""

    r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: Optional[list[str]] = None
    bias: str = "none"
    task_type: str = "CAUSAL_LM"

    # Variants
    use_rslora: bool = True
    use_dora: bool = False
    use_lora_plus: bool = False
    lora_plus_ratio: float = 16.0          # LR(B) = LR(A) * ratio, per LoRA+ paper
    freeze_a: bool = False                 # LoRA-FA mode
    neftune_noise_alpha: Optional[float] = None  # set in TrainingArguments

    def alpha_scaling(self) -> float:
        """LoRA effective scale = alpha / r for plain, alpha / sqrt(r) for rsLoRA."""
        import math
        if self.use_rslora:
            return self.lora_alpha / math.sqrt(self.r)
        return self.lora_alpha / self.r


def build_peft_lora_config(cfg: LoraVariantConfig):
    """
    Build a PEFT LoraConfig from a LoraVariantConfig.

    PEFT version-gates:
      - use_rslora: requires peft >= 0.7
      - use_dora:   requires peft >= 0.9.0 (sometimes 0.10 for stability)
    Both are tolerated with a feature-detect fallback so older PEFT installs
    still produce a working LoraConfig (with a logged warning).
    """
    try:
        from peft import LoraConfig
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "peft is required for LoRA training. "
            "Run `pip install peft>=0.10.0` then retry."
        ) from exc

    base_kwargs: dict[str, Any] = dict(
        r=cfg.r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        bias=cfg.bias,
        task_type=cfg.task_type,
    )
    if cfg.target_modules:
        base_kwargs["target_modules"] = list(cfg.target_modules)

    # Feature-detect by trying. PEFT raises TypeError on unknown kwargs.
    optional_kwargs: dict[str, Any] = {}
    if cfg.use_rslora:
        optional_kwargs["use_rslora"] = True
    if cfg.use_dora:
        optional_kwargs["use_dora"] = True

    try:
        return LoraConfig(**base_kwargs, **optional_kwargs)
    except TypeError as exc:
        # Strip one optional flag at a time and retry, logging which we lost.
        for flag in list(optional_kwargs):
            try:
                stripped = {k: v for k, v in optional_kwargs.items() if k != flag}
                return LoraConfig(**base_kwargs, **stripped)
            except TypeError:
                continue
        logger.warning(
            "[lora_variants] peft too old for any rsLoRA/DoRA flag; "
            "falling back to plain LoRA. peft upgrade recommended. %s",
            exc,
        )
        return LoraConfig(**base_kwargs)


def _split_lora_plus_params(model, *, ratio: float, base_lr: float):
    """
    Split LoRA A and B parameters into two optimizer groups for LoRA+ (Hayou et al 2024).
    LR(B) = ratio * LR(A); A and B in PEFT are named ".lora_A." and ".lora_B." inside
    LoRA layers.

    Returns a list[dict] suitable for `optim.AdamW(param_groups, ...)`.
    """
    a_params: list = []
    b_params: list = []
    other_params: list = []

    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if ".lora_B." in name:
            b_params.append(param)
        elif ".lora_A." in name:
            a_params.append(param)
        else:
            other_params.append(param)

    groups = []
    if a_params:
        groups.append({"params": a_params, "lr": base_lr})
    if b_params:
        groups.append({"params": b_params, "lr": base_lr * ratio})
    if other_params:
        groups.append({"params": other_params, "lr": base_lr})

    logger.info(
        "[lora_variants] LoRA+ groups: A=%d B=%d other=%d ratio=%.1fx",
        len(a_params), len(b_params), len(other_params), ratio,
    )
    return groups


def apply_freeze_a(model) -> int:
    """LoRA-FA: freeze all .lora_A. parameters in the model. Returns frozen count."""
    n = 0
    for name, param in model.named_parameters():
        if ".lora_A." in name:
            param.requires_grad = False
            n += 1
    logger.info("[lora_variants] LoRA-FA: froze %d A-matrix parameters", n)
    return n


def build_optimizer(
    model,
    cfg: LoraVariantConfig,
    *,
    base_lr: float,
    weight_decay: float = 0.0,
    paged_8bit: bool = False,
):
    """
    Build an optimizer with the requested LoRA variants applied.

    paged_8bit=True picks bitsandbytes.optim.PagedAdamW8bit when available; otherwise
    transformers default AdamW.
    """
    if cfg.freeze_a:
        apply_freeze_a(model)

    if cfg.use_lora_plus:
        groups = _split_lora_plus_params(model, ratio=cfg.lora_plus_ratio, base_lr=base_lr)
    else:
        groups = [
            {
                "params": [p for p in model.parameters() if p.requires_grad],
                "lr": base_lr,
            }
        ]

    if paged_8bit:
        try:
            from bitsandbytes.optim import PagedAdamW8bit
            return PagedAdamW8bit(groups, weight_decay=weight_decay)
        except Exception as exc:
            logger.warning(
                "[lora_variants] PagedAdamW8bit unavailable (%s); falling back to torch.AdamW",
                exc,
            )

    import torch
    return torch.optim.AdamW(groups, weight_decay=weight_decay)


def neftune_args_patch(args, alpha: Optional[float]) -> None:
    """
    Patch a TrainingArguments-like object in place with neftune_noise_alpha.

    NEFTune (Jain et al 2023, arXiv:2310.05914) injects uniform noise into the
    input embeddings during forward pass. Free wins on instruction tuning.
    Transformers Trainer reads this field directly.
    """
    if alpha is None or alpha <= 0:
        return
    setattr(args, "neftune_noise_alpha", float(alpha))
    logger.info("[lora_variants] NEFTune enabled with alpha=%.2f", alpha)


def quality_preset(*, r: int = 16) -> LoraVariantConfig:
    """The kolm `--quality` preset. Composes rsLoRA + DoRA + LoRA+ + NEFTune."""
    return LoraVariantConfig(
        r=r,
        lora_alpha=2 * r,
        lora_dropout=0.05,
        use_rslora=True,
        use_dora=True,
        use_lora_plus=True,
        lora_plus_ratio=16.0,
        neftune_noise_alpha=5.0,
    )


def fast_preset(*, r: int = 8) -> LoraVariantConfig:
    """The kolm `--fast` preset. Plain LoRA, no variants. Use when iterating."""
    return LoraVariantConfig(r=r, lora_alpha=2 * r, lora_dropout=0.05)


def balanced_preset(*, r: int = 16) -> LoraVariantConfig:
    """Default. rsLoRA only; the safe, free win."""
    return LoraVariantConfig(r=r, lora_alpha=2 * r, lora_dropout=0.05, use_rslora=True)


__all__ = [
    "LoraVariantConfig",
    "build_peft_lora_config",
    "build_optimizer",
    "neftune_args_patch",
    "quality_preset",
    "balanced_preset",
    "fast_preset",
]
