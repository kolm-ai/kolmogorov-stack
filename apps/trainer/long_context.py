"""
apps/trainer/long_context.py

Long-context fine-tuning via RoPE scaling.

The pretraining context window of an open-weights model (8k for Llama 3.1
before stretching, 32k for Qwen2.5) is a property of the rotary positional
embedding (RoPE) frequencies and the data the model saw. If you want the model
to attend over a longer window without catastrophic loss, you modify the RoPE
frequency schedule. The three production methods, in order of preference:

    yarn        Yet another RoPE extensioN. Two-stage: NTK on high-freq bands,
                attention temperature on low-freq bands. Best perplexity at
                strong stretch factors. Peng et al 2023, arXiv:2309.00071.

    ntk         NTK-aware. Modifies the RoPE base frequency so high-freq bands
                stretch less than low-freq bands. bloc97 r/LocalLLaMA 2023.

    linear      Linear position interpolation. Multiplies positions by 1/factor
                so the existing RoPE table covers a longer range. Cheap but
                hurts perplexity beyond factor=2. Chen et al 2023, arXiv:2306.15595.

This module applies the scaling configuration to a HuggingFace model's
config.rope_scaling and validates the factor + original window pair. We do
NOT re-implement the RoPE kernel; transformers reads the config field and
the model picks up the new schedule at the next forward pass.

Surface:

    from apps.trainer.long_context import apply_rope_scaling, LongContextConfig

    apply_rope_scaling(
        model,
        config=LongContextConfig(
            method="yarn",
            factor=4.0,
            original_max_position_embeddings=8192,
        ),
    )
    # model now supports up to ~32768 tokens, ready for long-context SFT.

To then fine-tune on long-context data, pair this with a long-context dataset
(e.g. PG-19, codebases, long medical notes) and standard SFT. The receipt
block carries the scaling config so the same artifact can be loaded later.

Citations:
  YaRN:    Peng et al 2023, arXiv:2309.00071
  NTK:     bloc97 r/LocalLLaMA 2023 ("NTK-aware Scaled RoPE")
  Linear:  Chen et al 2023, arXiv:2306.15595
  Ring attention: Liu et al 2023, arXiv:2310.01889 (companion for >256k)
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Literal, Mapping, Optional

logger = logging.getLogger(__name__)

ScalingMethod = Literal["linear", "ntk", "yarn"]
VALID_METHODS: tuple[str, ...] = ("linear", "ntk", "yarn")


@dataclasses.dataclass(frozen=True)
class LongContextConfig:
    """
    Stable config. The receipt records this dataclass so an auditor can
    reproduce the exact RoPE schedule.

    factor                          target_window / original_window
    original_max_position_embeddings the model's pretraining context
    method                          'linear' | 'ntk' | 'yarn'
    attn_factor                     yarn temperature factor (default 1.0)
    beta_fast, beta_slow            yarn band boundaries (32, 1 default)
    """

    method: ScalingMethod = "yarn"
    factor: float = 4.0
    original_max_position_embeddings: int = 8192
    attn_factor: float = 1.0
    beta_fast: float = 32.0
    beta_slow: float = 1.0


def _validate(cfg: LongContextConfig) -> None:
    if cfg.method not in VALID_METHODS:
        raise ValueError(f"method must be one of {VALID_METHODS}, got {cfg.method!r}")
    if cfg.factor < 1.0:
        raise ValueError(f"factor must be >= 1.0, got {cfg.factor}")
    if cfg.factor > 1.0 and cfg.method == "linear" and cfg.factor > 4.0:
        logger.warning(
            "linear interpolation with factor>4 typically hurts perplexity badly. "
            "consider method='yarn' for stronger stretch."
        )
    if cfg.original_max_position_embeddings < 1024:
        raise ValueError(
            f"original_max_position_embeddings must be >= 1024, got "
            f"{cfg.original_max_position_embeddings}"
        )


def _build_rope_scaling_dict(cfg: LongContextConfig) -> dict[str, Any]:
    """
    Build the dict that goes into model.config.rope_scaling. The field names
    follow transformers convention (>=4.43): type, factor, plus method-specific
    extras for yarn.
    """
    base: dict[str, Any] = {
        "type": cfg.method,
        "factor": float(cfg.factor),
        "original_max_position_embeddings": int(cfg.original_max_position_embeddings),
    }
    if cfg.method == "yarn":
        base.update(
            {
                "attn_factor": float(cfg.attn_factor),
                "beta_fast": float(cfg.beta_fast),
                "beta_slow": float(cfg.beta_slow),
            }
        )
    return base


def apply_rope_scaling(model: Any, *, config: LongContextConfig) -> Any:
    """
    Patch model.config.rope_scaling and bump max_position_embeddings.

    The new max window is original * factor. The caller is expected to follow
    up with SFT on long-context data; without further training the model
    "compiles" without crashing but will not exploit the new range.

    Returns the same model instance (in-place mutation).
    """
    _validate(config)
    if not hasattr(model, "config"):
        raise TypeError(
            "model has no .config attribute; expected a transformers PreTrainedModel"
        )

    rope_scaling = _build_rope_scaling_dict(config)
    new_max = int(config.original_max_position_embeddings * config.factor)

    # Set on both the top-level config and the underlying text config when
    # this is a multimodal wrapper.
    targets = [model.config]
    if hasattr(model.config, "text_config"):
        targets.append(model.config.text_config)

    for c in targets:
        c.rope_scaling = dict(rope_scaling)
        if hasattr(c, "max_position_embeddings"):
            c.max_position_embeddings = max(getattr(c, "max_position_embeddings", 0), new_max)

    logger.info(
        "applied rope_scaling: method=%s factor=%.2f original=%d new_max=%d",
        config.method,
        config.factor,
        config.original_max_position_embeddings,
        new_max,
    )
    return model


def detect_context_window(model: Any) -> int:
    """
    Best-effort read of the current effective max context window from a
    loaded model's config. Useful for runtime checks before submitting a
    long prompt.
    """
    if not hasattr(model, "config"):
        return 0
    c = model.config
    if hasattr(c, "max_position_embeddings"):
        return int(c.max_position_embeddings)
    text_cfg = getattr(c, "text_config", None)
    if text_cfg is not None and hasattr(text_cfg, "max_position_embeddings"):
        return int(text_cfg.max_position_embeddings)
    return 0


def receipt_block(
    cfg: LongContextConfig,
    *,
    model_id: str,
    train_examples: int,
    final_loss: Optional[float] = None,
) -> dict[str, Any]:
    return {
        "algo": "rope_scaling",
        "model_id": model_id,
        "config": dataclasses.asdict(cfg),
        "effective_max_position_embeddings": int(
            cfg.original_max_position_embeddings * cfg.factor
        ),
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "papers": [
            "arXiv:2309.00071",  # YaRN
            "arXiv:2306.15595",  # Linear PI
            "arXiv:2310.01889",  # Ring attention
        ],
        "schema_version": "long_context.v1",
    }


__all__ = [
    "LongContextConfig",
    "ScalingMethod",
    "VALID_METHODS",
    "apply_rope_scaling",
    "detect_context_window",
    "receipt_block",
]
