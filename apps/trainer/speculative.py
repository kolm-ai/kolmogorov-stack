"""
apps/trainer/speculative.py

Draft-model speculative decoding for serving compiled .kolm artifacts.

Mental model:
  Target model is the big one (Qwen 7B, Llama 14B, whatever the artifact
  shipped with). The draft model is a small fast model (1.5B / 3B) that
  proposes K tokens; the target then verifies them in a single forward pass.
  When the proposals match, we get K tokens for the cost of one big-model
  forward — typical wins are 2x-3x tokens/sec, sometimes more for code.

  This complements `prompt_lookup_num_tokens` (single-model, n-gram lookup
  in the prompt) from inference_cache.py. Use prompt-lookup when you don't
  have a smaller variant of the same family. Use draft-model when you do.

Pairings the registry recommends:
  Qwen2.5-7B target          → Qwen2.5-1.5B draft
  Qwen2.5-14B target         → Qwen2.5-3B draft
  Llama-3.2-3B target        → Llama-3.2-1B draft
  Gemma-3-12B target         → Gemma-3-1B draft

For .kolm artifacts: if a target ships with a draft pair declared in
manifest.runtime.draft_model, the serve path autoloads both. Otherwise we
fall back to the prompt-lookup path from inference_cache.py.

This module is import-safe with no torch — we degrade to None and let the
caller pick the prompt-lookup path.
"""

from __future__ import annotations
import os
from typing import Optional, Dict, Any


# Known good draft / target family pairings. Keys are normalized model ids.
DRAFT_PAIRINGS: Dict[str, str] = {
    "qwen/qwen2.5-7b-instruct": "Qwen/Qwen2.5-1.5B-Instruct",
    "qwen/qwen2.5-14b-instruct": "Qwen/Qwen2.5-3B-Instruct",
    "qwen/qwen2.5-32b-instruct": "Qwen/Qwen2.5-7B-Instruct",
    "meta-llama/llama-3.2-3b-instruct": "meta-llama/Llama-3.2-1B-Instruct",
    "meta-llama/meta-llama-3-8b-instruct": "meta-llama/Llama-3.2-1B-Instruct",
    "google/gemma-3-12b-it": "google/gemma-3-1b-it",
    "google/gemma-3-4b-it": "google/gemma-3-1b-it",
    "microsoft/phi-3.5-mini-instruct": "Qwen/Qwen2.5-1.5B-Instruct",
}


def pick_draft(target_id: str) -> Optional[str]:
    """Return the draft model id for a target, or None if no good pair."""
    if not target_id:
        return None
    return DRAFT_PAIRINGS.get(target_id.lower())


def build_assistant_kwargs(
    target_model,
    target_tokenizer,
    draft_model_id: Optional[str] = None,
    num_assistant_tokens: int = 5,
):
    """
    Construct generation kwargs that tell HF transformers to speculate via
    a draft model. Returns a dict suitable for passing as **gen_kwargs to
    .generate() — empty dict if speculative decoding is not configured.

    The HF API:
      model.generate(**inputs, assistant_model=draft_model,
                     num_assistant_tokens=N, ...)
    """
    if not draft_model_id:
        return {}

    try:
        from transformers import AutoModelForCausalLM
        import torch
    except ImportError:
        return {}

    target_device = next(target_model.parameters()).device
    target_dtype = next(target_model.parameters()).dtype

    try:
        draft = AutoModelForCausalLM.from_pretrained(
            draft_model_id,
            torch_dtype=target_dtype,
            trust_remote_code=False,
        ).to(target_device)
        draft.eval()
    except Exception as exc:
        # Couldn't load draft — fall back to single-model decoding.
        if os.environ.get("KOLM_VERBOSE"):
            print(f"[kolm.speculative] draft load failed: {exc}")
        return {}

    return {
        "assistant_model": draft,
        "num_assistant_tokens": int(num_assistant_tokens),
        # When draft and target share a tokenizer family, this is True.
        # Forcing False is safer if you're not sure.
        "assistant_tokenizer": None,
    }


def serve_spec_from_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """
    Read the runtime block from a manifest and return a serve spec:
      {
        "target_model": "Qwen/Qwen2.5-7B-Instruct",
        "draft_model": "Qwen/Qwen2.5-1.5B-Instruct" | None,
        "num_assistant_tokens": 5,
        "max_new_tokens": 512,
      }
    """
    runtime = (manifest or {}).get("runtime", {}) or {}
    target = runtime.get("base_model") or manifest.get("base_model")
    explicit_draft = runtime.get("draft_model")
    draft = explicit_draft or pick_draft(target or "")
    return {
        "target_model": target,
        "draft_model": draft,
        "num_assistant_tokens": int(runtime.get("num_assistant_tokens", 5)),
        "max_new_tokens": int(runtime.get("max_new_tokens", 512)),
    }


def speculative_supported() -> bool:
    """True iff transformers is new enough to take assistant_model kwarg."""
    try:
        import transformers
        # assistant_model landed in 4.35; we want 4.39+ for stability.
        from packaging.version import Version
        return Version(transformers.__version__) >= Version("4.39.0")
    except Exception:
        return False
