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
            head_id="kolm/eagle3-qwen2.5-7b",
            head_kind="eagle3",
            num_speculative_tokens=5,
        ),
    )

    # Sets engine.speculative_config = {"method": "eagle3",
    #   "model": "kolm/eagle3-qwen2.5-7b", "num_speculative_tokens": 5}

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
    target_model_id           the large model the EAGLE head drafts for
    head_id                   the EAGLE-3 head checkpoint id or local path
                              (the kolm-trained head, or a pretrained one)
    head_kind                 'eagle' | 'eagle2' | 'eagle3' — the vLLM
                              speculative_config 'method' value
    num_speculative_tokens    tree depth; 5-7 is the published sweet spot
    eagle_topk                dynamic draft-tree branching factor (EAGLE-2/3)
    num_steps                 dynamic draft-tree depth (EAGLE-2/3)
    draft_model_id            DEPRECATED alias for head_id (kept for callers
                              that constructed the old shape positionally)
    num_draft_tokens          dynamic tree token budget recorded in receipts
    """

    target_model_id: str
    head_id: str = ""
    head_kind: str = "eagle3"
    num_speculative_tokens: int = 5
    eagle_topk: int = 8
    num_steps: int = 5
    # Back-compat alias. Older call sites passed draft_model_id; if head_id is
    # empty we fall back to it so existing constructors keep working.
    draft_model_id: str = ""
    num_draft_tokens: int = 32

    @property
    def resolved_head_id(self) -> str:
        return self.head_id or self.draft_model_id


def attach_eagle3(*, engine: Any, config: Eagle3Config) -> Any:
    """
    Wire an EAGLE head into a vLLM engine via the MODERN speculative_config
    dict. Returns the engine for chaining.

    vLLM >=0.10 reads `speculative_config = {'method': <eagle|eagle3>, 'model':
    <head>, 'num_speculative_tokens': K}`. We set EXACTLY those real keys — no
    deprecated flat `speculative_model` kwarg, and no fabricated
    `draft_model_type` key (which no vLLM version reads).
    """
    if not hasattr(engine, "speculative_config"):
        raise TypeError(
            "engine has no .speculative_config; this expects a vllm.LLMEngine "
            "or compatible. For HF transformers Generation, use the "
            "assistant_model parameter on .generate() with the draft model."
        )
    head_id = config.resolved_head_id
    if not head_id:
        raise ValueError("Eagle3Config requires head_id (or legacy draft_model_id)")
    engine.speculative_config = {
        "method": config.head_kind,
        "model": head_id,
        "num_speculative_tokens": int(config.num_speculative_tokens),
    }
    logger.info(
        "EAGLE attached: method=%s target=%s head=%s K=%d",
        config.head_kind,
        config.target_model_id,
        head_id,
        config.num_speculative_tokens,
    )
    return engine


def build_vllm_speculative_config(resolved: dict, tp: int = 1):
    """
    Pure helper: turn a resolved-head dict (the JS resolveEagleHead() shape, or
    an Eagle3Config-equivalent) into the modern vLLM speculative_config dict, or
    None when speculation is off/unsupported. EAGLE tree policy is preserved
    separately by build_speculative_tree_policy() because current vLLM
    SpeculativeConfig does not expose eagle_topk, num_steps, or
    num_draft_tokens as engine knobs.

    Mirror of src/serve-config.js buildVllmSpeculativeConfig — keep in sync.
    """
    if not resolved or not isinstance(resolved, dict):
        return None
    head_id = resolved.get("head_id") or resolved.get("model") or ""
    k = int(resolved.get("num_speculative_tokens") or 0)
    if not head_id or not resolved.get("supported", True) or k <= 0:
        return None
    head_kind = (resolved.get("head_kind") or "draft_model").lower()
    if head_kind in ("eagle", "eagle2", "eagle3"):
        cfg = {"method": head_kind, "model": head_id, "num_speculative_tokens": k}
        if isinstance(tp, int) and tp > 1:
            cfg["draft_tensor_parallel_size"] = int(tp)
        return cfg
    if head_kind == "medusa":
        return {"method": "medusa", "model": head_id, "num_speculative_tokens": k}
    cfg = {"model": head_id, "num_speculative_tokens": k}
    if isinstance(tp, int) and tp > 1:
        cfg["draft_tensor_parallel_size"] = int(tp)
    return cfg


def build_speculative_tree_policy(resolved: dict, runtime: str = "vllm"):
    """Preserve EAGLE tree knobs as runtime metadata without mutating vLLM cfg."""
    if not resolved or not isinstance(resolved, dict):
        return None
    head_kind = (resolved.get("head_kind") or "").lower()
    if head_kind not in ("eagle", "eagle2", "eagle3"):
        return None
    tree = {}
    for key in ("eagle_topk", "num_steps", "num_draft_tokens"):
        if resolved.get(key) is not None:
            tree[key] = int(resolved[key])
    if not tree:
        return None
    rt = (runtime or "vllm").lower()
    tree["runtime"] = rt
    tree["engine_configurable"] = rt == "sglang"
    tree["note"] = (
        "preserved by Kolm; current vLLM SpeculativeConfig does not expose EAGLE tree knobs"
        if rt == "vllm"
        else "passed to runtime when supported"
    )
    return tree


def build_sglang_spec_args(resolved: dict) -> list:
    """SGLang launch_server EAGLE args from a resolved-head dict (or [])."""
    if not resolved or not isinstance(resolved, dict):
        return []
    head_id = resolved.get("head_id") or ""
    k = int(resolved.get("num_speculative_tokens") or 0)
    if not head_id or not resolved.get("supported", True) or k <= 0:
        return []
    algo_map = {"eagle": "EAGLE", "eagle2": "EAGLE", "eagle3": "EAGLE3", "medusa": "EAGLE"}
    algo = algo_map.get((resolved.get("head_kind") or "").lower())
    if not algo:
        return []
    args = ["--speculative-algorithm", algo, "--speculative-draft-model-path", head_id]
    if resolved.get("num_steps") is not None:
        args += ["--speculative-num-steps", str(int(resolved["num_steps"]))]
    if resolved.get("eagle_topk") is not None:
        args += ["--speculative-eagle-topk", str(int(resolved["eagle_topk"]))]
    if resolved.get("num_draft_tokens") is not None:
        args += ["--speculative-num-draft-tokens", str(int(resolved["num_draft_tokens"]))]
    return args


def build_llamacpp_draft_args(resolved: dict) -> list:
    """llama.cpp --model-draft args (separate-draft GGUF only; or [])."""
    if not resolved or not isinstance(resolved, dict):
        return []
    head_id = resolved.get("head_id") or ""
    k = int(resolved.get("num_speculative_tokens") or 0)
    if not head_id or k <= 0:
        return []
    if (resolved.get("head_kind") or "").lower() != "draft_model":
        return []  # EAGLE heads unsupported on llama.cpp upstream
    return ["--model-draft", head_id, "--draft-max", str(k), "--draft-min", "1"]


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
        "algo": "speculative_decoding." + config.head_kind,
        "target_model_id": config.target_model_id,
        "head_id": config.resolved_head_id,
        "head_kind": config.head_kind,
        "num_speculative_tokens": int(config.num_speculative_tokens),
        "eagle_topk": int(config.eagle_topk),
        "num_steps": int(config.num_steps),
        "num_draft_tokens": int(config.num_draft_tokens),
        "papers": [
            "arXiv:2503.01840",  # EAGLE-3
            "arXiv:2406.16858",  # EAGLE-2
            "arXiv:2401.15077",  # EAGLE
        ],
        "schema_version": "eagle3.v2",
    }


__all__ = [
    "Eagle3Config",
    "attach_eagle3",
    "build_vllm_speculative_config",
    "build_speculative_tree_policy",
    "build_sglang_spec_args",
    "build_llamacpp_draft_args",
    "hf_eagle3_generate_kwargs",
    "receipt_block",
]


def _self_test() -> int:
    """No-GPU self-test of the pure config builders. Exits 0 on pass.

    Run: python -m apps.runtime.eagle3 --self-test
    """
    resolved_eagle = {
        "head_kind": "eagle3",
        "head_id": "RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3",
        "num_speculative_tokens": 5,
        "eagle_topk": 8,
        "num_steps": 5,
        "num_draft_tokens": 32,
        "supported": True,
    }
    cfg = build_vllm_speculative_config(resolved_eagle, tp=2)
    assert cfg == {
        "method": "eagle3",
        "model": "RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3",
        "num_speculative_tokens": 5,
        "draft_tensor_parallel_size": 2,
    }, cfg
    assert "speculative_model" not in cfg and "draft_model_type" not in cfg
    assert "eagle_topk" not in cfg and "num_steps" not in cfg and "num_draft_tokens" not in cfg
    sidecar = build_speculative_tree_policy(resolved_eagle, runtime="vllm")
    assert sidecar == {
        "eagle_topk": 8,
        "num_steps": 5,
        "num_draft_tokens": 32,
        "runtime": "vllm",
        "engine_configurable": False,
        "note": "preserved by Kolm; current vLLM SpeculativeConfig does not expose EAGLE tree knobs",
    }, sidecar

    sg = build_sglang_spec_args(resolved_eagle)
    assert "EAGLE3" in sg and "--speculative-draft-model-path" in sg, sg
    assert build_llamacpp_draft_args(resolved_eagle) == [], "EAGLE not on llama.cpp"

    resolved_draft = {"head_kind": "draft_model", "head_id": "/m/draft.gguf", "num_speculative_tokens": 4, "supported": True}
    lc = build_llamacpp_draft_args(resolved_draft)
    assert lc == ["--model-draft", "/m/draft.gguf", "--draft-max", "4", "--draft-min", "1"], lc
    assert build_sglang_spec_args(resolved_draft) == [], "draft_model has no EAGLE algo"

    off = build_vllm_speculative_config({"head_kind": "eagle3", "head_id": "x", "num_speculative_tokens": 0, "supported": True})
    assert off is None, off

    # attach_eagle3 sets the REAL 'method' key on a fake engine.
    class _FakeEngine:
        speculative_config = None
    eng = _FakeEngine()
    attach_eagle3(engine=eng, config=Eagle3Config(target_model_id="t", head_id="h", head_kind="eagle3"))
    assert eng.speculative_config["method"] == "eagle3", eng.speculative_config
    assert "draft_model_type" not in eng.speculative_config

    print("apps.runtime.eagle3 self-test: OK")
    return 0


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        raise SystemExit(_self_test())
    print("usage: python -m apps.runtime.eagle3 --self-test")
