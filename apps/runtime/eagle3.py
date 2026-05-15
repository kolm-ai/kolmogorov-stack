"""
apps/runtime/eagle3.py

EAGLE-3 speculative decoding. The 2025 upgrade to EAGLE-2.

Speculative decoding lets a small draft model propose K tokens which the
target model verifies in a single forward pass. EAGLE (Li 2024) showed the
draft head should consume the target's hidden state, not the target's
predicted next-token logits — that's the feature-level autoregression
trick. EAGLE-2 (Li 2024, arXiv:2406.16858) added a confidence-aware
draft tree.

EAGLE-3 (Li 2025, arXiv:2503.01840) drops the feature-prediction auxiliary
loss and trains the draft on multi-layer hidden states with target-policy
data. The result: ~30% throughput improvement over EAGLE-2 at the same
target-model quality. The training recipe is what differs; serving-side
this module accepts an EAGLE-3 checkpoint and dispatches it to vLLM or to
a HuggingFace `generate(..., assistant_model=...)` path.

This module is config + dispatch. The training side lives in a companion
script outside this wave because EAGLE-3 training requires a target-rollout
dataset that is not bundled with the trainer; we link the buyer to the
upstream repo.

Surface:

    from apps.runtime.eagle3 import Eagle3Config, attach_eagle3

    attach_eagle3(
        engine=vllm_engine,
        config=Eagle3Config(
            target_model_id="Qwen/Qwen2.5-7B-Instruct",
            draft_model_id="kolm/eagle3-qwen2.5-7b",
            num_speculative_tokens=5,
        ),
    )

Citations:
  EAGLE:      Li et al 2024, arXiv:2401.15077
  EAGLE-2:    Li et al 2024, arXiv:2406.16858
  EAGLE-3:    Li et al 2025, arXiv:2503.01840
  Medusa:     Cai et al 2024, arXiv:2401.10774 (companion in medusa.py)
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclasses.dataclass(frozen=True)
class Eagle3Config:
    """
    target_model_id           the large model EAGLE-3 drafts for
    draft_model_id            the EAGLE-3 checkpoint id or local path
    num_speculative_tokens    tree depth; 5-7 is the published sweet spot
    posterior_threshold       acceptance threshold on the verify forward
    posterior_alpha           temperature scaling for the verify decision
    """

    target_model_id: str
    draft_model_id: str
    num_speculative_tokens: int = 5
    posterior_threshold: float = 0.09
    posterior_alpha: float = 0.3


def attach_eagle3(*, engine: Any, config: Eagle3Config) -> Any:
    """
    Wire EAGLE-3 into a vLLM engine. Returns the engine for chaining.

    vLLM's speculative-decoding config is set via the engine's
    `speculative_config` field; we update it idempotently.
    """
    if not hasattr(engine, "speculative_config"):
        raise TypeError(
            "engine has no .speculative_config; this expects a vllm.LLMEngine "
            "or compatible. For HF transformers Generation, use the "
            "assistant_model parameter on .generate() with the draft model."
        )
    engine.speculative_config = {
        "model": config.draft_model_id,
        "num_speculative_tokens": int(config.num_speculative_tokens),
        "draft_model_type": "eagle3",
        "posterior_threshold": float(config.posterior_threshold),
        "posterior_alpha": float(config.posterior_alpha),
    }
    logger.info(
        "EAGLE-3 attached: target=%s draft=%s K=%d",
        config.target_model_id,
        config.draft_model_id,
        config.num_speculative_tokens,
    )
    return engine


def hf_eagle3_generate_kwargs(config: Eagle3Config) -> dict[str, Any]:
    """
    For non-vLLM serving (HuggingFace generate). Returns kwargs you pass
    alongside an assistant_model. The HF integration doesn't expose all the
    EAGLE-3 knobs, but it does respect num_assistant_tokens.
    """
    return {
        "assistant_model_kwargs": {
            "num_assistant_tokens": int(config.num_speculative_tokens),
            "do_sample": True,
        }
    }


def receipt_block(config: Eagle3Config) -> dict[str, Any]:
    return {
        "algo": "speculative_decoding.eagle3",
        "target_model_id": config.target_model_id,
        "draft_model_id": config.draft_model_id,
        "num_speculative_tokens": int(config.num_speculative_tokens),
        "posterior_threshold": float(config.posterior_threshold),
        "posterior_alpha": float(config.posterior_alpha),
        "papers": [
            "arXiv:2503.01840",  # EAGLE-3
            "arXiv:2406.16858",  # EAGLE-2
            "arXiv:2401.15077",  # EAGLE
        ],
        "schema_version": "eagle3.v1",
    }


__all__ = ["Eagle3Config", "attach_eagle3", "hf_eagle3_generate_kwargs", "receipt_block"]
