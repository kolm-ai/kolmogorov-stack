"""ExecuTorch exporter (PyTorch → on-device iOS/Android).

ExecuTorch's mobile pipeline is fast-moving (the format is still pre-1.0
as of mid-2026). We implement the v1 shape: HF → torch.export (StrictExport) →
to_edge() → to_executorch() → write .pte.

Quantization happens via XNNPACK partitioners for ARM CPUs.

Toolchain:
    pip install executorch  (>=0.4)
    pip install torch        (>=2.3)
    pip install transformers

The user MUST have an Apple developer cert (iOS) or Android NDK to ship the
result to a device; this exporter only produces the .pte file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .registry import ExportError, ExportNotApplicable, register

NAME = "executorch"


def plan(artifact_dir: str | os.PathLike) -> dict:
    artifact_dir = Path(artifact_dir)
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": [
            "merge_lora_into_base",
            "torch.export (strict)",
            "to_edge + to_executorch",
            "(optional) xnnpack quantization partitioner",
        ],
        "expected_outputs": ["model.pte"],
        "platform_note": "ARM64 mobile (iOS / Android NDK r25+)",
    }


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not plan(artifact_dir)["applicable"]:
        raise ExportNotApplicable("ExecuTorch export needs lora-tier or higher")

    try:
        import torch  # noqa: F401
        from executorch.exir import to_edge  # noqa: F401
    except Exception as e:
        raise ExportError(
            f"executorch not installed: {e}\n"
            "Install:\n"
            "  pip install torch\n"
            "  pip install executorch>=0.4\n"
        ) from e

    # Real export depends on the model class shape. Refuse to silently
    # produce something that doesn't load on-device. The wrapper has to be
    # specialized per model family (Qwen / Llama / Gemma / Phi).
    raise ExportError(
        "ExecuTorch export needs a model-family-specific wrapper. "
        "Open a request on github.com/kolm-ai/kolmogorov-stack with "
        "the base_model name from your manifest, and we'll ship the wrapper. "
        "Today supported via this pipeline: gguf (cross-platform), mlx (Apple)."
    )


register(NAME, export)
