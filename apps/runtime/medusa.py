"""
apps/runtime/medusa.py

Multi-head / tree-based speculative decoding beyond the draft-model baseline.

The 2023 draft-model spec decoding (already in apps/runtime/serve.py via
speculative.DRAFT_PAIRINGS) gets ~2x throughput on most chat workloads.
Two newer techniques beat it on the same hardware:

    MEDUSA      Cai et al, 2024, arXiv:2401.10774
                Train extra "medusa heads" on the base model that each
                predict a different future token position. No separate
                draft model; the heads share the base model's body.
                ~2.3-2.8x throughput, ~10% extra params.

    EAGLE / EAGLE-2  Li et al, 2024/2025, arXiv:2401.15077 / arXiv:2406.16858
                Single autoregressive head that predicts the next-layer
                hidden state instead of the next token, then verifies a
                dynamic tree of continuations. ~3-4x throughput, requires
                training the EAGLE head separately.

This module wires both into vLLM 0.6+ via its native --speculative-model
SPECULATIVE_MODEL_TYPE arg. The kolm runtime config carries the head
artifact pointer alongside the base.

Selection guide:

    technique         throughput on H100 7B       VRAM extra    train cost
    ------------------------------------------------------------------
    draft-model spec  ~2.0x                       +small base   none (use Qwen 1.5B)
    MEDUSA            ~2.3-2.8x                   ~10%          ~1 hr on A100
    EAGLE-2           ~3.0-4.0x                   ~5%           ~3 hr on A100
    lookahead (LADE)  ~1.5x                       0             0

Kolm's spec field for spec-decoding looks like:

    "serve": {
      "spec_decoding": {
        "mode": "draft|medusa|eagle2|lookahead|off",
        "draft_model": "Qwen/Qwen2.5-1.5B-Instruct",
        "head_artifact": "registry://kolm/eagle2-qwen-7b",
        "num_speculative_tokens": 5,
        "dynamic_tree": true
      }
    }
"""

from __future__ import annotations

import dataclasses
import enum
import logging
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)


class SpecMode(str, enum.Enum):
    OFF = "off"
    DRAFT = "draft"
    MEDUSA = "medusa"
    EAGLE = "eagle"
    EAGLE2 = "eagle2"
    LOOKAHEAD = "lookahead"
    SELF = "self"


@dataclasses.dataclass(frozen=True)
class SpecConfig:
    mode: SpecMode
    num_speculative_tokens: int = 5
    draft_model: Optional[str] = None
    head_artifact: Optional[str] = None
    dynamic_tree: bool = False
    lookahead_ngram_size: int = 4
    lookahead_window_size: int = 7
    skip_layers: Optional[list[int]] = None

    def for_vllm(self) -> dict[str, Any]:
        if self.mode is SpecMode.OFF:
            return {}

        if self.mode is SpecMode.DRAFT:
            if not self.draft_model:
                raise ValueError("DRAFT spec mode requires draft_model")
            return {
                "speculative_model": self.draft_model,
                "num_speculative_tokens": self.num_speculative_tokens,
            }

        if self.mode is SpecMode.MEDUSA:
            if not self.head_artifact:
                raise ValueError("MEDUSA spec mode requires head_artifact")
            return {
                "speculative_model": f"medusa:{self.head_artifact}",
                "num_speculative_tokens": self.num_speculative_tokens,
            }

        if self.mode in (SpecMode.EAGLE, SpecMode.EAGLE2):
            if not self.head_artifact:
                raise ValueError(f"{self.mode.value} spec mode requires head_artifact")
            tag = "eagle2" if self.mode is SpecMode.EAGLE2 else "eagle"
            args: dict[str, Any] = {
                "speculative_model": f"{tag}:{self.head_artifact}",
                "num_speculative_tokens": self.num_speculative_tokens,
            }
            if self.mode is SpecMode.EAGLE2 and self.dynamic_tree:
                args["speculative_disable_by_batch_size"] = 32
            return args

        if self.mode is SpecMode.LOOKAHEAD:
            return {
                "use_v2_block_manager": True,
                "prompt_lookup_max": max(self.lookahead_ngram_size, 1),
                "num_speculative_tokens": self.num_speculative_tokens,
            }

        if self.mode is SpecMode.SELF:
            return {}

        raise ValueError(f"unhandled spec mode {self.mode}")

    def for_transformers(self) -> dict[str, Any]:
        if self.mode is SpecMode.OFF:
            return {}

        if self.mode is SpecMode.DRAFT:
            if not self.draft_model:
                raise ValueError("DRAFT spec mode requires draft_model")
            return {"num_assistant_tokens": self.num_speculative_tokens}

        if self.mode is SpecMode.LOOKAHEAD:
            return {
                "prompt_lookup_num_tokens": max(self.lookahead_ngram_size, 1),
                "num_assistant_tokens": self.num_speculative_tokens,
            }

        return {}


def pick_spec_mode(
    *,
    base_model: str,
    available_head_artifacts: Mapping[str, str] | None = None,
    available_draft_models: Mapping[str, str] | None = None,
    target_throughput: str = "balanced",
) -> SpecConfig:
    if target_throughput == "off":
        return SpecConfig(mode=SpecMode.OFF)

    heads = available_head_artifacts or {}
    drafts = available_draft_models or {}

    if base_model in heads:
        return SpecConfig(
            mode=SpecMode.EAGLE2,
            head_artifact=heads[base_model],
            num_speculative_tokens=5,
            dynamic_tree=True,
        )
    if base_model in drafts:
        return SpecConfig(
            mode=SpecMode.DRAFT,
            draft_model=drafts[base_model],
            num_speculative_tokens=5,
        )
    if target_throughput == "max":
        return SpecConfig(mode=SpecMode.LOOKAHEAD, lookahead_ngram_size=4)
    return SpecConfig(mode=SpecMode.OFF)


def from_spec_field(field: Mapping[str, Any] | None) -> SpecConfig:
    if not field:
        return SpecConfig(mode=SpecMode.OFF)
    mode_str = field.get("mode", "off")
    mode = SpecMode(mode_str)
    return SpecConfig(
        mode=mode,
        num_speculative_tokens=int(field.get("num_speculative_tokens", 5)),
        draft_model=field.get("draft_model"),
        head_artifact=field.get("head_artifact"),
        dynamic_tree=bool(field.get("dynamic_tree", False)),
        lookahead_ngram_size=int(field.get("lookahead_ngram_size", 4)),
        lookahead_window_size=int(field.get("lookahead_window_size", 7)),
        skip_layers=field.get("skip_layers"),
    )


DEFAULT_EAGLE_HEADS: dict[str, str] = {
    "Qwen/Qwen2.5-7B-Instruct":     "registry://kolm/eagle2-qwen2.5-7b-v1",
    "Qwen/Qwen2.5-14B-Instruct":    "registry://kolm/eagle2-qwen2.5-14b-v1",
    "meta-llama/Llama-3.2-3B-Instruct": "registry://kolm/eagle2-llama-3.2-3b-v1",
    "meta-llama/Meta-Llama-3-8B-Instruct": "registry://kolm/eagle2-llama-3-8b-v1",
    "google/gemma-2-9b-it":         "registry://kolm/eagle2-gemma-2-9b-v1",
}

DEFAULT_MEDUSA_HEADS: dict[str, str] = {
    "Qwen/Qwen2.5-7B-Instruct":     "registry://kolm/medusa-qwen2.5-7b-v1",
    "meta-llama/Meta-Llama-3-8B-Instruct": "registry://kolm/medusa-llama-3-8b-v1",
}


__all__ = [
    "SpecMode",
    "SpecConfig",
    "pick_spec_mode",
    "from_spec_field",
    "DEFAULT_EAGLE_HEADS",
    "DEFAULT_MEDUSA_HEADS",
]
